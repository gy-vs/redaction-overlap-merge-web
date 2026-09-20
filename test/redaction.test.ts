import {describe,expect,it} from 'vitest';
import {
  applyPlan,
  buildPlan,
  codePoints,
  fromUtf16Offset,
  hashReplacement,
  strategyKey,
  type InputRange,
} from '../src/server/redaction';

const r = (
  id: string,
  start: number,
  end: number,
  strategy: InputRange['strategy'],
  kind: InputRange['kind'] = 'generic',
): InputRange => ({id, start, end, kind, strategy});

describe('buildPlan - 完全包含', () => {
  const content = '地址：北京市海淀区张三收。';
  // 外层 3..12（到句点前），内层姓名落在其中
  const outer = r('addr', 3, 12, {kind: 'mask'}, 'address');
  const inner = r('name', 9, 11, {kind: 'label', text: '[姓名]'}, 'name');

  it('外层策略主导，内层只保留审计引用', () => {
    const plan = buildPlan(content, [outer, inner]);
    expect(plan.ready).toBe(true);
    expect(plan.canonical).toHaveLength(1);
    const only = plan.canonical[0];
    expect(only.start).toBe(3);
    expect(only.end).toBe(12);
    expect(only.strategy).toEqual({kind: 'mask'});
    expect(only.kind).toBe('address');
    expect(only.contained).toEqual(['name']);
    expect(only.sourceRanges).toEqual(['addr']);
  });

  it('最终输出不泄露外层尾部原文（旧实现的内层先行 + 旧偏移 bug 回归）', () => {
    const plan = buildPlan(content, [outer, inner]);
    const {output, leaks} = applyPlan(content, plan);
    expect(output).toBe('地址：' + '█'.repeat(9) + '。');
    // 被包含范围的原文（姓名）必须消失
    expect(output).not.toContain('张三');
    // 外层尾部原文不能泄露
    expect(output).not.toContain('收');
    expect(leaks).toEqual([]);
  });

  it('内层 label 文本较长导致坐标变化时，外层仍完整脱敏（禁止复用已变化坐标）', () => {
    const text = 'AAA姓名BBB'; // [0,3) 外层 remove，[3,5) 内层 label
    const plan = buildPlan(text, [
      r('outer', 0, 5, {kind: 'mask'}, 'address'),
      r('inner', 3, 5, {kind: 'label', text: '这是一个很长的姓名标签'}, 'name'),
    ]);
    const {output, leaks} = applyPlan(text, plan);
    expect(output).toBe('█'.repeat(5) + 'BBB');
    expect(output).not.toContain('姓名');
    expect(leaks).toEqual([]);
  });
});

describe('buildPlan - 部分相交', () => {
  const content = 'xxxx两个站点，🎉结束';
  // [4,8) "两个站点" 与 [7,10) "点，🎉" 在 [7,8) 相交，策略不同
  const a = r('a', 4, 8, {kind: 'hash'});
  const b = r('b', 7, 10, {kind: 'label', text: '[地点]'});

  it('策略冲突时必须要求用户解决，不猜测、不产出可执行规范范围', () => {
    const plan = buildPlan(content, [a, b]);
    expect(plan.ready).toBe(false);
    expect(plan.conflicts).toHaveLength(1);
    const conflict = plan.conflicts[0];
    expect(conflict.kind).toBe('overlap');
    expect(conflict.start).toBe(4);
    expect(conflict.end).toBe(10);
    expect(conflict.members.map((m) => m.rangeId).sort()).toEqual(['a', 'b']);
    expect(plan.canonical).toEqual([]);
    const applied = applyPlan(content, plan);
    expect(applied.output).toBe(content); // 未解决前不得替换
    expect(applied.leaks).toEqual([]);
  });

  it('前端解决后重新计算规范集合；旧决策不会残留', () => {
    const resolved = buildPlan(content, [a, b], [{conflictId: planConflictId(content, [a, b]), chosenRangeId: 'b'}]);
    expect(resolved.ready).toBe(true);
    expect(resolved.canonical).toHaveLength(1);
    expect(resolved.canonical[0].start).toBe(4);
    expect(resolved.canonical[0].end).toBe(10);
    expect(resolved.canonical[0].strategy).toEqual({kind: 'label', text: '[地点]'});
    expect(resolved.canonical[0].origin).toBe('resolved');
    expect(applyPlan(content, resolved).output).toBe('xxxx[地点]结束');

    // 改选 a：重新构建的集合必须反映新决策
    const switched = buildPlan(content, [a, b], [{conflictId: planConflictId(content, [a, b]), chosenRangeId: 'a'}]);
    const out = applyPlan(content, switched);
    expect(out.output.startsWith('xxxx')).toBe(true);
    expect(out.output).not.toContain('[地点]');
    expect(out.output).not.toContain('两个站点');
  });

  it('无效决策被拒绝（成员不属于冲突 / 冲突不存在）', () => {
    const id = planConflictId(content, [a, b]);
    expect(() => buildPlan(content, [a, b], [{conflictId: id, chosenRangeId: 'nope'}])).toThrow();
    expect(() => buildPlan(content, [a, b], [{conflictId: 'conflict_x+y', chosenRangeId: 'a'}])).toThrow();
  });

  it('冲突联合完全被外层包含时由外层策略主导，无需用户解决', () => {
    const outer = r('outer', 0, codePoints(content).length, {kind: 'remove'}, 'address');
    const plan = buildPlan(content, [outer, a, b]);
    expect(plan.ready).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.canonical).toHaveLength(1);
    expect(plan.canonical[0].contained.sort()).toEqual(['a', 'b']);
    expect(applyPlan(content, plan).output).toBe('');
  });
});

describe('buildPlan - 相邻', () => {
  const content = 'ABCDEFGH';
  it('相邻且同策略 → 合并为一个规范范围', () => {
    const plan = buildPlan(content, [
      r('x', 0, 3, {kind: 'mask'}),
      r('y', 3, 5, {kind: 'mask'}),
    ]);
    expect(plan.canonical).toHaveLength(1);
    expect(plan.canonical[0]).toMatchObject({start: 0, end: 5, mergedAdjacent: true});
    expect(plan.canonical[0].sourceRanges).toEqual(['x', 'y']);
    expect(applyPlan(content, plan).output).toBe('█'.repeat(5) + 'FGH');
  });

  it('相邻但不同策略 → 保留两个独立范围，不丢策略', () => {
    const plan = buildPlan(content, [
      r('x', 0, 3, {kind: 'remove'}),
      r('y', 3, 5, {kind: 'mask'}),
    ]);
    expect(plan.canonical).toHaveLength(2);
    expect(plan.canonical[0].strategy).toEqual({kind: 'remove'});
    expect(plan.canonical[1].strategy).toEqual({kind: 'mask'});
    expect(applyPlan(content, plan).output).toBe('██FGH');
  });

  it('同策略但不相邻（有间隙）→ 不合并', () => {
    const plan = buildPlan(content, [
      r('x', 0, 2, {kind: 'remove'}),
      r('y', 3, 5, {kind: 'remove'}),
    ]);
    expect(plan.canonical).toHaveLength(2);
    expect(applyPlan(content, plan).output).toBe('C' + 'FGH');
  });

  it('同属 label 但文本不同 → 策略键不同，不合并', () => {
    const plan = buildPlan(content, [
      r('x', 0, 3, {kind: 'label', text: '[A]'}),
      r('y', 3, 5, {kind: 'label', text: '[B]'}),
    ]);
    expect(plan.canonical).toHaveLength(2);
    expect(applyPlan(content, plan).output).toBe('[A][B]FGH');
  });
});

describe('buildPlan - 零长度建议', () => {
  it('被忽略并在 ignored 中回报，不影响输出', () => {
    const content = 'abc';
    const plan = buildPlan(content, [
      r('z', 1, 1, {kind: 'mask'}),
      r('real', 0, 1, {kind: 'remove'}),
    ]);
    expect(plan.ignored).toEqual([{id: 'z', start: 1, end: 1, reason: 'zero_length'}]);
    expect(plan.canonical).toHaveLength(1);
    expect(applyPlan(content, plan).output).toBe('bc');
  });
});

describe('Unicode 范围（码元坐标）', () => {
  const content = '你好🎉世界';
  it('emoji 占一个码元偏移，mask 保持码元长度', () => {
    expect(codePoints(content)).toHaveLength(5);
    const plan = buildPlan(content, [r('e', 2, 3, {kind: 'mask'})]);
    expect(applyPlan(content, plan).output).toBe('你好█世界');
  });

  it('ZWJ 序列整体作为范围，不拆散代理对', () => {
    const text = 'a🐱‍👤b';
    const cps = codePoints(text);
    // Array.from('🐱‍👤') => ['🐱','‍','👤'] 共 3 个码元
    expect(cps.length).toBe(5);
    const plan = buildPlan(text, [r('z', 1, 4, {kind: 'mask'})]);
    const {output} = applyPlan(text, plan);
    expect(output).toBe('a███b');
    expect(Array.from(output)).toEqual(['a', '█', '█', '█', 'b']);
  });

  it('UTF-16 下标正确换算为码元下标', () => {
    expect(fromUtf16Offset(content, 4)).toBe(3); // emoji 后
  });

  it('越界 / 非法偏移被拒绝', () => {
    expect(() => buildPlan(content, [r('bad', 0, 99, {kind: 'mask'})])).toThrow();
    expect(() => buildPlan(content, [r('bad', 3, 1, {kind: 'mask'})])).toThrow();
  });
});

describe('策略渲染与安全替换', () => {
  const content = 'prefix-SECRET-suffix';
  it('remove/mask/label/hash 各自渲染且不泄露原文', () => {
    const planRemove = buildPlan(content, [r('s', 7, 13, {kind: 'remove'})]);
    expect(applyPlan(content, planRemove).output).toBe('prefix--suffix');

    const planMask = buildPlan(content, [r('s', 7, 13, {kind: 'mask'})]);
    expect(applyPlan(content, planMask).output).toBe('prefix-' + '█'.repeat(6) + '-suffix');

    const planLabel = buildPlan(content, [r('s', 7, 13, {kind: 'label', text: 'XXX'})]);
    expect(applyPlan(content, planLabel).output).toBe('prefix-XXX-suffix');

    const planHash = buildPlan(content, [r('s', 7, 13, {kind: 'hash'})]);
    const hashed = applyPlan(content, planHash);
    expect(hashed.output).not.toContain('SECRET');
    expect(hashed.leaks).toEqual([]);
    expect(hashReplacement('SECRET')).toBe(hashReplacement('SECRET'));
  });

  it('从后向前与流式切片等价：替换长度变化不影响后续坐标', () => {
    // 多个变长替换（remove 缩短、label 改变长度）交错
    const plan = buildPlan(content, [
      r('a', 0, 6, {kind: 'remove'}),   // "prefix"
      r('b', 7, 13, {kind: 'label', text: '中'}),
      r('c', 14, 20, {kind: 'mask'}),   // "suffix"
    ]);
    const {output, leaks} = applyPlan(content, plan);
    expect(output).toBe('-中-██████');
    expect(leaks).toEqual([]);
    expect(output).not.toContain('prefix');
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('suffix');
  });

  it('label 文本若等于原文，守卫标记为脱敏无效（最终输出不得保留原文）', () => {
    const plan = buildPlan(content, [r('s', 7, 13, {kind: 'label', text: 'SECRET'})]);
    const {leaks, ineffective} = applyPlan(content, plan);
    expect(leaks).toEqual([]);
    expect(ineffective.map((l) => l.rangeId)).toEqual(['s']);
  });

  it('文档其他位置出现的相同文字不会被误报', () => {
    const text = 'X-Y-X';
    const plan = buildPlan(text, [r('one', 0, 1, {kind: 'label', text: 'X'})]);
    const {leaks, ineffective} = applyPlan(text, plan);
    expect(leaks).toEqual([]);
    // 范围 [0,1) 的原文 X 被原样保留 → ineffective（严格不变式）
    expect(ineffective.map((l) => l.rangeId)).toEqual(['one']);
  });

  it('label 替换为不相关文本时既不泄露也不误报', () => {
    const text = 'X-Y-X';
    const plan = buildPlan(text, [r('one', 0, 1, {kind: 'label', text: 'Z'})]);
    const {output, leaks, ineffective} = applyPlan(text, plan);
    expect(output).toBe('Z-Y-X');
    expect(leaks).toEqual([]);
    expect(ineffective).toEqual([]);
  });

  it('strategyKey 区分 label 文本', () => {
    expect(strategyKey({kind: 'label', text: 'a'})).not.toBe(strategyKey({kind: 'label', text: 'b'}));
    expect(strategyKey({kind: 'mask'})).toBe('mask');
  });
});

describe('同跨度冲突（identical）', () => {
  it('同跨度不同策略要求解决；同跨度同策略去重', () => {
    const content = 'ABCDEF';
    const conflict = buildPlan(content, [
      r('p', 1, 4, {kind: 'mask'}, 'address'),
      r('q', 1, 4, {kind: 'remove'}, 'name'),
    ]);
    expect(conflict.ready).toBe(false);
    expect(conflict.conflicts[0].kind).toBe('identical');

    const dedup = buildPlan(content, [
      r('p', 1, 4, {kind: 'mask'}),
      r('q', 1, 4, {kind: 'mask'}),
    ]);
    expect(dedup.ready).toBe(true);
    expect(dedup.canonical).toHaveLength(1);
  });
});

function planConflictId(content: string, ranges: InputRange[]): string {
  const plan = buildPlan(content, ranges);
  return plan.conflicts[0].id;
}
