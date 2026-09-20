import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, CheckCircle2, Eraser, Eye, Send, ShieldAlert} from 'lucide-react';
import {fromUtf16Offset, type Strategy} from '../server/redaction';

type Suggestion = {id: string; start: number; end: number; kind: 'address' | 'name' | 'generic'; strategy: Strategy};
type ConflictMember = {rangeId: string; start: number; end: number; kind: string; strategy: Strategy};
type Conflict = {id: string; kind: 'overlap' | 'identical'; start: number; end: number; members: ConflictMember[]};
type Canonical = {
  id: string;
  start: number;
  end: number;
  kind: string;
  strategy: Strategy;
  sourceRanges: string[];
  contained: string[];
  mergedAdjacent: boolean;
  origin: 'accepted' | 'resolved';
};
type Ignored = {id: string; start: number; end: number; reason: string};
type Plan = {canonical: Canonical[]; conflicts: Conflict[]; ignored: Ignored[]; ready: boolean; length: number};
type Warnings = {leaks: unknown[]; ineffective: {rangeId: string; original: string}[]};
type PlanResponse = {revision: number; plan: Plan; preview: string | null; warnings: Warnings};
type ApplyResponse = {revision: number; output: string; persisted: boolean};

const STRATEGY_LABEL: Record<string, string> = {mask: '掩码 █', remove: '删除', hash: '假名哈希'};

function strategySummary(strategy: Strategy): string {
  return strategy.kind === 'label' ? `标签：${strategy.text || '（空）'}` : STRATEGY_LABEL[strategy.kind] ?? strategy.kind;
}

function sliceContent(content: string, start: number, end: number): string {
  return Array.from(content).slice(start, end).join('');
}

function StrategyPicker({strategy, onChange}: {strategy: Strategy; onChange: (s: Strategy) => void}) {
  return (
    <span className="picker">
      <select
        value={strategy.kind === 'label' ? 'label' : strategy.kind}
        onChange={(e) => {
          const kind = e.target.value;
          if (kind === 'label') onChange({kind: 'label', text: '[已脱敏]'});
          else onChange({kind} as Strategy);
        }}
      >
        <option value="mask">掩码</option>
        <option value="remove">删除</option>
        <option value="hash">假名哈希</option>
        <option value="label">标签</option>
      </select>
      {strategy.kind === 'label' && (
        <input
          aria-label="标签文本"
          value={strategy.text}
          onChange={(e) => onChange({kind: 'label', text: e.target.value})}
        />
      )}
    </span>
  );
}

export default function RedactionPanel({docId, revision, content, onPersisted}: {
  docId: string;
  revision: number;
  content: string;
  onPersisted: (output: string, revision: number) => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<Suggestion[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Strategy>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedOutput, setAppliedOutput] = useState<string | null>(null);

  // 每次请求自带序号；只有最新响应可以落盘，旧预览绝不能覆盖新决策。
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setAcceptedIds(new Set());
    setManual([]);
    setOverrides({});
    setResolutions({});
    setPlan(null);
    setError(null);
    setAppliedOutput(null);
    requestSeq.current++; // 作废所有在途旧请求
    fetch(`/api/documents/${docId}/suggestions`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled || body.revision !== revision) return; // revision 已变，丢弃
        setSuggestions(body.ranges);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, revision]);

  const allRanges = useMemo<Suggestion[]>(() => {
    const accepted = suggestions
      .filter((s) => acceptedIds.has(s.id) && s.start !== s.end)
      .map((s) => (overrides[s.id] ? {...s, strategy: overrides[s.id]} : s));
    return [...accepted, ...manual];
  }, [suggestions, acceptedIds, overrides, manual]);

  function addRangeFromSelection() {
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Content"]');
    if (!area) return;
    const start = fromUtf16Offset(content, area.selectionStart);
    const end = fromUtf16Offset(content, area.selectionEnd);
    if (start === end) {
      setError('零长度选择不会参与脱敏（零长度建议仅作为忽略项回报）。');
      return;
    }
    setError(null);
    const id = `manual-${Date.now()}`;
    setManual((prev) => [...prev, {id, start, end, kind: 'generic', strategy: {kind: 'mask'}}]);
  }

  const computePlan = useCallback(async (nextResolutions: Record<string, string>) => {
    setBusy(true);
    setError(null);
    const seq = ++requestSeq.current;
    const res = await fetch(`/api/documents/${docId}/redaction/plan`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        revision,
        ranges: allRanges,
        resolutions: Object.entries(nextResolutions).map(([conflictId, chosenRangeId]) => ({conflictId, chosenRangeId})),
      }),
    });
    if (seq !== requestSeq.current) return; // 旧响应直接丢弃，不能覆盖新决策
    setBusy(false);
    if (res.status === 409) {
      setError('文档 revision 已变化，请重新加载后再审阅。');
      setPlan(null);
      return;
    }
    const body = (await res.json()) as PlanResponse & {error?: string; details?: unknown};
    if (!res.ok) {
      setError(body.error ?? '构建规范集合失败');
      return;
    }
    setPlan(body);
    setAppliedOutput(null); // 旧输出作废，等待基于新集合的重新应用
  }, [allRanges, docId, revision]);

  function resolveConflict(conflictId: string, chosenRangeId: string) {
    const next = {...resolutions, [conflictId]: chosenRangeId};
    setResolutions(next);
    computePlan(next); // 冲突解决后立即基于固定 revision 重算规范集合
  }

  async function apply(persist: boolean) {
    if (!plan?.plan.ready) return;
    setBusy(true);
    setError(null);
    const seq = ++requestSeq.current;
    const res = await fetch(`/api/documents/${docId}/redaction/apply`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        revision,
        ranges: allRanges,
        resolutions: Object.entries(resolutions).map(([conflictId, chosenRangeId]) => ({conflictId, chosenRangeId})),
        persist,
      }),
    });
    const body = (await res.json().catch(() => null)) as (ApplyResponse & {error?: string}) | null;
    if (seq !== requestSeq.current) return;
    setBusy(false);
    if (!res.ok || !body) {
      if (res.status === 409) setError('文档 revision 已变化，请重新加载。');
      else if (body?.error === 'redaction_ineffective') setError('存在与原文相同的标签替换，脱敏无效，请更换策略。');
      else if (body?.error === 'redaction_leak_detected') setError('服务端检测到原文泄露，已拒绝输出。');
      else setError(body?.error ?? '应用失败');
      return;
    }
    setAppliedOutput(body.output); // 仅由最新 apply 响应写入
    if (persist) onPersisted(body.output, body.revision);
  }

  return (
    <div className="redact">
      <div className="toolbar">
        <strong>脱敏审阅</strong>
        <button onClick={() => setAcceptedIds(new Set(suggestions.filter((s) => s.start !== s.end).map((s) => s.id)))}>
          <Eye size={15}/>接受全部非零建议
        </button>
        <button onClick={addRangeFromSelection}><Eraser size={15}/>用当前选区添加范围</button>
        <button className="primary" onClick={() => computePlan(resolutions)} disabled={busy || allRanges.length === 0}>
          <Send size={15}/>构建规范集合
        </button>
        <span>rev {revision} · {allRanges.length} 个已接受范围</span>
      </div>

      {error && <div className="banner error"><AlertTriangle size={15}/>{error}</div>}

      <div className="redact-grid">
        <div className="redact-col">
          <h3>建议范围</h3>
          {suggestions.map((s) => {
            const checked = acceptedIds.has(s.id);
            const zero = s.start === s.end;
            return (
              <label key={s.id} className={`range-row${zero ? ' zero' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={zero}
                  onChange={() => setAcceptedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                    return next;
                  })}
                />
                <span className="range-meta">
                  <code>{s.id}</code>
                  <em>{s.kind}{zero ? ' · 零长度（忽略）' : ` · [${s.start}, ${s.end})`}</em>
                  {!zero && <q>{sliceContent(content, s.start, s.end)}</q>}
                </span>
                {checked && !zero && (
                  <StrategyPicker
                    strategy={overrides[s.id] ?? s.strategy}
                    onChange={(st) => setOverrides((prev) => ({...prev, [s.id]: st}))}
                  />
                )}
              </label>
            );
          })}
          {manual.map((s) => (
            <div key={s.id} className="range-row manual">
              <span className="range-meta">
                <code>{s.id}</code>
                <em>generic · [{s.start}, {s.end})</em>
                <q>{sliceContent(content, s.start, s.end)}</q>
              </span>
              <StrategyPicker strategy={s.strategy} onChange={(st) => setManual((prev) => prev.map((x) => (x.id === s.id ? {...x, strategy: st} : x)))}/>
              <button className="link" onClick={() => setManual((prev) => prev.filter((x) => x.id !== s.id))}>移除</button>
            </div>
          ))}
        </div>

        <div className="redact-col">
          <h3>需要解决的冲突</h3>
          {plan && plan.plan.conflicts.length === 0 && <div className="banner ok"><CheckCircle2 size={15}/>无冲突</div>}
          {!plan && <p className="hint">接受范围后构建规范集合。</p>}
          {plan?.plan.conflicts.map((c) => (
            <div key={c.id} className="conflict">
              <div className="conflict-head">
                <ShieldAlert size={15}/>
                <strong>{c.kind === 'overlap' ? '部分相交，策略冲突' : '同跨度，策略不同'}</strong>
                <em>[{c.start}, {c.end})</em>
              </div>
              <p className="hint">服务端不会猜测；请选择一个范围的策略作用于整个并集：</p>
              {c.members.map((m) => {
                const active = resolutions[c.id] === m.rangeId;
                return (
                  <button
                    key={m.rangeId}
                    className={`conflict-choice${active ? ' chosen' : ''}`}
                    onClick={() => resolveConflict(c.id, m.rangeId)}
                  >
                    <code>{m.rangeId}</code>
                    <q>{sliceContent(content, m.start, m.end)}</q>
                    <span>{strategySummary(m.strategy)}</span>
                    {active && <CheckCircle2 size={14}/>}
                  </button>
                );
              })}
            </div>
          ))}

          <h3>规范范围</h3>
          {plan?.plan.canonical.map((c) => (
            <div key={c.id} className="canonical">
              <div className="conflict-head">
                <code>[{c.start}, {c.end})</code>
                <span>{strategySummary(c.strategy)}</span>
                {c.mergedAdjacent && <em className="tag">相邻同策略已合并</em>}
                {c.origin === 'resolved' && <em className="tag resolved">冲突解决产物</em>}
              </div>
              {c.contained.length > 0 && (
                <p className="hint">外层策略主导，内层仅保留审计引用：{c.contained.join(', ')}</p>
              )}
              <p className="hint">来源：{c.sourceRanges.join(', ')}</p>
            </div>
          ))}
          {plan?.plan.ignored.map((i) => (
            <p key={i.id} className="hint ignored">已忽略 {i.id}：{i.reason} @ {i.start}</p>
          ))}
          {(plan?.warnings.ineffective.length ?? 0) > 0 && (
            <div className="banner error"><AlertTriangle size={15}/>脱敏无效：{plan?.warnings.ineffective.map((x) => x.rangeId).join(', ')}</div>
          )}
        </div>

        <div className="redact-col">
          <h3>预览 / 最终输出</h3>
          <div className="toolbar">
            <button onClick={() => apply(false)} disabled={!plan?.plan.ready || busy}><Eye size={15}/>预览（不落库）</button>
            <button className="primary" onClick={() => apply(true)} disabled={!plan?.plan.ready || busy}><Send size={15}/>应用并保存</button>
          </div>
          {plan && !plan.plan.ready && <div className="banner warn"><AlertTriangle size={15}/>存在未解决冲突，无法生成最终输出。</div>}
          <pre className="preview">{appliedOutput ?? (plan?.plan.ready ? plan.preview : null) ?? '—'}</pre>
          {appliedOutput && <p className="hint ok-text">服务端已重新流式替换并校验：输出不含任何已接受范围原文。</p>}
        </div>
      </div>
    </div>
  );
}
