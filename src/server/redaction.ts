/**
 * 脱敏范围规范化与安全替换核心逻辑（框架无关）。
 *
 * 坐标约定：所有 start/end 均为 Unicode 码元（code point）偏移，
 * 半开区间 [start, end)。代理对（如 emoji）按一个码元计数，
 * 避免 UTF-16 下标把一个字符拆成两个偏移。
 *
 * 不变式：
 *  - 规范化集合固定在某个文档 revision 的内容上构建；
 *  - 替换采用流式切片，从原文坐标一次推进，绝不复用已变化的坐标；
 *  - 任何已接受范围覆盖的原文片段不会出现在最终输出中。
 */

export type Strategy =
  | {kind: 'mask'}
  | {kind: 'remove'}
  | {kind: 'label'; text: string}
  | {kind: 'hash'};

export type RangeKind = 'address' | 'name' | 'generic';

/** 调用方提交的原始范围。 */
export type InputRange = {
  id?: string;
  start: number;
  end: number;
  kind?: RangeKind;
  strategy: Strategy;
};

export type Resolution = {conflictId: string; chosenRangeId: string};

export type CanonicalRange = {
  id: string;
  start: number;
  end: number;
  kind: RangeKind;
  strategy: Strategy;
  strategyKey: string;
  /** 直接产出该规范范围的已接受范围 id（相邻合并/冲突解决后可能有多个）。 */
  sourceRanges: string[];
  /** 被外层策略主导的内层范围 id，仅作审计引用。 */
  contained: string[];
  mergedAdjacent: boolean;
  origin: 'accepted' | 'resolved';
};

export type ConflictMember = {
  rangeId: string;
  start: number;
  end: number;
  kind: RangeKind;
  strategy: Strategy;
};

export type Conflict = {
  id: string;
  kind: 'overlap' | 'identical';
  start: number;
  end: number;
  members: ConflictMember[];
};

export type IgnoredRange = {
  id: string;
  start: number;
  end: number;
  reason: 'zero_length';
};

export type SourceSpan = {id: string; start: number; end: number};

export type Plan = {
  length: number;
  canonical: CanonicalRange[];
  conflicts: Conflict[];
  ignored: IgnoredRange[];
  /** 所有参与规范化的非零长度已接受范围（含被包含/被合并者），用于泄露校验。 */
  sources: SourceSpan[];
  ready: boolean;
};

export class RedactionError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, code: string, details?: unknown) {
    super(code);
    this.name = 'RedactionError';
    this.status = status;
    this.details = details;
  }
}

const STRATEGY_KINDS = new Set(['mask', 'remove', 'label', 'hash']);

export function strategyKey(strategy: Strategy): string {
  switch (strategy.kind) {
    case 'label':
      return `label:${strategy.text}`;
    default:
      return strategy.kind;
  }
}

/** 把字符串展开为码元数组；offset 以码元为单位。 */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** UTF-16 下标（如 textarea selectionStart）转码元下标。 */
export function fromUtf16Offset(text: string, utf16Offset: number): number {
  return Array.from(text.slice(0, utf16Offset)).length;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

type Accepted = {
  id: string;
  start: number;
  end: number;
  kind: RangeKind;
  strategy: Strategy;
};

function parseRanges(input: unknown, length: number): {accepted: Accepted[]; ignored: IgnoredRange[]} {
  if (!Array.isArray(input)) {
    throw new RedactionError(400, 'ranges_must_be_array');
  }
  const ignored: IgnoredRange[] = [];
  const accepted: Accepted[] = [];
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new RedactionError(400, 'range_invalid', {index});
    }
    const r = raw as Partial<InputRange>;
    if (!isInt(r.start) || !isInt(r.end) || r.start < 0 || r.end < 0 || r.start > r.end) {
      throw new RedactionError(400, 'range_offsets_invalid', {index, start: r.start, end: r.end});
    }
    if (r.end > length) {
      throw new RedactionError(400, 'range_out_of_bounds', {index, end: r.end, length});
    }
    if (!r.strategy || typeof r.strategy !== 'object' || !STRATEGY_KINDS.has(r.strategy.kind)) {
      throw new RedactionError(400, 'strategy_invalid', {index});
    }
    if (r.strategy.kind === 'label' && typeof (r.strategy as {text?: unknown}).text !== 'string') {
      throw new RedactionError(400, 'label_text_invalid', {index});
    }
    const kind: RangeKind = r.kind === 'address' || r.kind === 'name' ? r.kind : 'generic';
    const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : `range-${index}`;
    // 零长度建议不参与包含/相交/相邻判定，原样退回为忽略项。
    if (r.start === r.end) {
      ignored.push({id, start: r.start, end: r.end, reason: 'zero_length'});
      return;
    }
    accepted.push({id, start: r.start, end: r.end, kind, strategy: r.strategy as Strategy});
  });
  return {accepted, ignored};
}

type Comp = {
  ids: string[];
  start: number;
  end: number;
  kind: 'overlap' | 'identical';
};

/**
 * 基于固定内容构建规范范围集合。
 *
 * 关系处理：
 *  - 完全包含：外层策略主导，内层范围进入外层的 contained 审计引用；
 *  - 部分相交且策略不同：产生必须由用户解决的冲突，服务端不猜测；
 *  - 相邻（end === 下一个 start）且策略相同：合并；策略不同：保留各自范围。
 */
export function buildPlan(content: string, input: unknown, resolutions: Resolution[] = []): Plan {
  const cps = codePoints(content);
  const length = cps.length;
  const {accepted, ignored} = parseRanges(input, length);

  // 同跨度同策略去重；同跨度不同策略留待冲突阶段处理。
  const deduped: Accepted[] = [];
  for (const r of accepted) {
    const same = deduped.find((d) => d.start === r.start && d.end === r.end && strategyKey(d.strategy) === strategyKey(r.strategy));
    if (!same) deduped.push(r);
  }

  const byId = new Map(deduped.map((r) => [r.id, r]));

  // 部分相交 / 同跨度异策略 → 并查集聚合为冲突组件。
  const parent = new Map<string, string>(deduped.map((r) => [r.id, r.id]));
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const conflictPairs: {kind: 'overlap' | 'identical'; x: string; y: string}[] = [];
  const recordPair = (a: string, b: string, kind: 'overlap' | 'identical') => {
    parent.set(find(a), find(b));
    conflictPairs.push({kind, x: a < b ? a : b, y: a < b ? b : a});
  };
  for (let i = 0; i < deduped.length; i++) {
    for (let j = i + 1; j < deduped.length; j++) {
      const a = deduped[i];
      const b = deduped[j];
      const crosses =
        (a.start < b.start && a.end > b.start && a.end < b.end) ||
        (b.start < a.start && b.end > a.start && b.end < a.end);
      if (crosses) {
        recordPair(a.id, b.id, 'overlap');
      } else if (a.start === b.start && a.end === b.end && strategyKey(a.strategy) !== strategyKey(b.strategy)) {
        recordPair(a.id, b.id, 'identical');
      }
    }
  }

  // 组件元数据；只要组件内存在一条部分相交边，类型即为 overlap。
  const rootsInConflict = new Set(conflictPairs.flatMap((p) => [find(p.x), find(p.y)]));
  const comps = new Map<string, Comp>();
  const compOf = new Map<string, string>();
  for (const r of deduped) {
    const root = find(r.id);
    if (!rootsInConflict.has(root)) continue; // 未参与冲突
    if (!comps.has(root)) comps.set(root, {ids: [], start: r.start, end: r.end, kind: 'identical'});
    const comp = comps.get(root)!;
    comp.ids.push(r.id);
    comp.start = Math.min(comp.start, r.start);
    comp.end = Math.max(comp.end, r.end);
    compOf.set(r.id, root);
  }
  for (const [root, comp] of comps) {
    comp.kind = conflictPairs.some((p) => p.kind === 'overlap' && find(p.x) === root) ? 'overlap' : 'identical';
  }

  // 解析用户决策。
  const resolutionByComp = new Map<string, Resolution>();
  for (const resolution of resolutions) {
    let matchedRoot: string | undefined;
    for (const [root, comp] of comps) {
      if (conflictIdFor(comp) === resolution.conflictId) {
        matchedRoot = root;
        break;
      }
    }
    if (!matchedRoot) {
      throw new RedactionError(400, 'resolution_conflict_unknown', {conflictId: resolution.conflictId});
    }
    const comp = comps.get(matchedRoot)!;
    if (!comp.ids.includes(resolution.chosenRangeId)) {
      throw new RedactionError(400, 'resolution_member_unknown', {
        conflictId: resolution.conflictId,
        chosenRangeId: resolution.chosenRangeId,
      });
    }
    resolutionByComp.set(matchedRoot, resolution);
  }

  // 活动范围 = 未参与冲突的已接受范围 + 已解决冲突的联合范围（伪范围）。
  type Active = {
    id: string;
    start: number;
    end: number;
    kind: RangeKind;
    strategy: Strategy;
    sourceRanges: string[];
    origin: 'accepted' | 'resolved';
    pseudo: boolean;
  };
  const active: Active[] = [];
  const openComps: {root: string; comp: Comp}[] = [];
  for (const r of deduped) {
    if (!compOf.has(r.id)) active.push({...r, sourceRanges: [r.id], origin: 'accepted', pseudo: false});
  }
  for (const [root, comp] of comps) {
    const resolution = resolutionByComp.get(root);
    if (resolution) {
      const chosen = byId.get(resolution.chosenRangeId)!;
      active.push({
        id: `resolved:${conflictIdFor(comp)}`,
        start: comp.start,
        end: comp.end,
        kind: chosen.kind,
        strategy: chosen.strategy,
        sourceRanges: [...comp.ids],
        origin: 'resolved',
        pseudo: true,
      });
    } else {
      openComps.push({root, comp});
    }
  }

  // 冲突联合若被单个外层活动范围完全吞下，外层策略主导（明确规则，非猜测），
  // 冲突成员降级为审计引用；否则冲突必须保留并由用户解决。
  const swallowed = new Set<string>();
  const remainingOpen: Comp[] = [];
  for (const {comp} of openComps) {
    // 冲突联合完全落在某个非冲突成员的外层内 → 外层策略主导（确定性规则，非猜测）。
    const swallower = active.find((a) => a.start <= comp.start && a.end >= comp.end);
    if (swallower) {
      for (const id of comp.ids) swallowed.add(id);
    } else {
      remainingOpen.push(comp);
    }
  }

  const conflicts: Conflict[] = remainingOpen.map((comp) => ({
    id: conflictIdFor(comp),
    kind: comp.kind,
    start: comp.start,
    end: comp.end,
    members: comp.ids.map((id) => {
      const r = byId.get(id)!;
      return {rangeId: r.id, start: r.start, end: r.end, kind: r.kind, strategy: r.strategy};
    }),
  }));

  const contains = (outer: Active, inner: {start: number; end: number}) =>
    outer.start <= inner.start && outer.end >= inner.end && !(outer.start === inner.start && outer.end === inner.end);

  // 找最终根外层：活动范围中包含 target、且自身不再被任何活动范围包含的唯一范围。
  const rootOf = new Map<string, Active>();
  const roots = active.filter((a) => !active.some((other) => other.id !== a.id && contains(other, a)));
  for (const inner of active) {
    if (roots.includes(inner)) continue;
    const root = roots.find((candidate) => contains(candidate, inner));
    if (root) rootOf.set(inner.id, root);
  }
  // 被吞下的冲突成员同样挂到根外层。
  for (const id of swallowed) {
    const r = byId.get(id)!;
    const root = roots.find((candidate) => contains(candidate, r) || (candidate.start === r.start && candidate.end === r.end));
    if (root && !rootOf.has(id)) rootOf.set(id, root);
  }

  const canonical: CanonicalRange[] = roots
    .map((root) => {
      const contained: string[] = [];
      for (const [innerId, owner] of rootOf) {
        if (owner !== root) continue;
        const inner = active.find((a) => a.id === innerId);
        if (inner) contained.push(...inner.sourceRanges);
        else contained.push(innerId); // 被吞下的冲突成员
      }
      return {
        id: root.id,
        start: root.start,
        end: root.end,
        kind: root.kind,
        strategy: root.strategy,
        strategyKey: strategyKey(root.strategy),
        sourceRanges: [...root.sourceRanges],
        contained: contained.sort(),
        mergedAdjacent: false,
        origin: root.origin,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // 相邻且策略相同 → 合并；相邻但策略不同 → 保留两个独立范围。
  const merged: CanonicalRange[] = [];
  for (const range of canonical) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end === range.start && prev.strategyKey === range.strategyKey) {
      prev.end = range.end;
      prev.sourceRanges.push(...range.sourceRanges);
      prev.contained.push(...range.contained);
      prev.contained.sort();
      prev.mergedAdjacent = true;
      if (range.origin === 'resolved') prev.origin = 'resolved';
    } else {
      merged.push({...range, sourceRanges: [...range.sourceRanges], contained: [...range.contained]});
    }
  }

  const sources: SourceSpan[] = deduped.map((r) => ({id: r.id, start: r.start, end: r.end}));

  return {
    length,
    canonical: merged,
    conflicts,
    ignored,
    sources,
    ready: conflicts.length === 0,
  };
}

function conflictIdFor(comp: Comp): string {
  return 'conflict_' + [...comp.ids].sort().join('+');
}

function fnv1a32(codes: number[], offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (const code of codes) {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 确定性假名：同一原文始终得到同一 16 位十六进制串。 */
export function hashReplacement(original: string): string {
  const codes = Array.from(original).map((ch) => ch.codePointAt(0)!);
  const hi = fnv1a32(codes, 0x811c9dc5);
  const lo = fnv1a32(codes, 0x12345678);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

export type Applied = {
  output: string;
  /** 守卫发现的泄露：已接受的内层原文出现在了外层/合并后的替换片段里。 */
  leaks: {rangeId: string; original: string}[];
  /** 脱敏无效：规范范围的替换结果与其原文完全一致（如 label 文本等于原文）。 */
  ineffective: {rangeId: string; original: string}[];
};

/**
 * 流式切片替换：按原文坐标从左到右推进，每段原文只读一次，
 * 替换片段不会被当作坐标再次索引（也可以等价地从后向前替换）。
 */
export function applyPlan(content: string, plan: Plan): Applied {
  const cps = codePoints(content);
  const ordered = [...plan.canonical].sort((a, b) => a.start - b.start || b.end - a.end);

  // 防御性断言：规范范围互不相交。
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new RedactionError(500, 'canonical_overlap_detected');
    }
  }

  let output = '';
  let cursor = 0;
  for (const range of ordered) {
    output += cps.slice(cursor, range.start).join(''); // 未改动的间隙（原文坐标）
    const original = cps.slice(range.start, range.end).join('');
    output += renderStrategy(range.strategy, original);
    cursor = range.end;
  }
  output += cps.slice(cursor).join('');

  // 泄露守卫：每个已接受范围的原文都不得出现在覆盖它的替换片段中。
  // 只检查该范围对应的替换片段，不会误伤文档其他位置出现的相同文字。
  // 若用户显式选择的 label 与其原文相同（脱敏无效），同样在此拦截：
  // 最终输出不得包含任何已接受范围的原文。
  const leaks: {rangeId: string; original: string}[] = [];
  const ineffective: {rangeId: string; original: string}[] = [];
  for (const span of plan.sources) {
    const owner = ordered.find((r) => r.start <= span.start && r.end >= span.end);
    if (!owner) continue; // 未解决冲突中的范围尚未参与替换
    const original = cps.slice(span.start, span.end).join('');
    const rendered = renderStrategy(owner.strategy, original);
    const token = renderStrategy(owner.strategy, cps.slice(owner.start, owner.end).join(''));
    const isWholeOwner = owner.start === span.start && owner.end === span.end;
    if (isWholeOwner && rendered === original) {
      ineffective.push({rangeId: span.id, original});
    } else if (!isWholeOwner && original.length > 0 && token.includes(original)) {
      leaks.push({rangeId: span.id, original});
    }
  }
  return {output, leaks, ineffective};
}

function renderStrategy(strategy: Strategy, original: string): string {
  switch (strategy.kind) {
    case 'mask':
      return '█'.repeat(Array.from(original).length);
    case 'remove':
      return '';
    case 'label':
      return strategy.text;
    case 'hash':
      return hashReplacement(original);
  }
}
