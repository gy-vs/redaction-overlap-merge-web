import {useEffect,useRef,useState} from 'react';
import {AlertTriangle,FlaskConical,Play,Plus,Save,ScanSearch,ShieldCheck,Trash2} from 'lucide-react';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type Finding={id:string;kind:string;start:number;end:number;strategy:string};
type Span={start:number;end:number;strategy:string;replacement:string;sources:string[]};
type Conflict={id:string;left:string[];right:string[];intersection:{start:number;end:number};strategies:string[]};
type Plan=
  |{status:'ok';spans:Span[]}
  |{status:'conflict';conflicts:Conflict[]}
  |{status:'invalid';problems:string[]};
type Applied={output:string;spans:Span[];leaks:string[]};
const STRATEGIES=['mask','tokenize','hash','remove'];

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [findings,setFindings]=useState<Finding[]>([]);
  const [decisions,setDecisions]=useState<Record<string,'accept'|'reject'>>({});
  const [resolutions,setResolutions]=useState<Record<string,string>>({});
  const [plan,setPlan]=useState<Plan|null>(null);
  const [applied,setApplied]=useState<Applied|null>(null);
  const [status,setStatus]=useState('Ready');
  const [manual,setManual]=useState({start:'0',end:'0',kind:'pii',strategy:'mask'});
  const seq=useRef(0);
  const nextId=useRef(1);

  useEffect(()=>{fetch('/api/documents').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    setStatus('Loading');
    fetch('/api/documents/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);setDraft(value.content);
      setFindings([]);setDecisions({});setResolutions({});
      setStatus('Loaded');
    });
  },[selected]);
  // Any new decision, resolution, finding set or revision invalidates the
  // previous plan and preview: a stale preview must never overwrite a newer
  // decision.
  useEffect(()=>{setPlan(null);setApplied(null)},[findings,decisions,resolutions,row]);

  const dirty=!row||draft!==row.content;

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/documents/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(!response.ok){setStatus('Revision conflict');return}
    setRow(value);setStatus('Saved');
  }
  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/documents/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});
    const value=await response.json();
    const found:Finding[]=value.findings??[];
    setFindings(found);
    setDecisions(Object.fromEntries(found.map(f=>[f.id,'accept' as const])));
    setResolutions({});
    setStatus('Ready');
  }
  function addFinding(){
    const start=Number(manual.start);
    const end=Number(manual.end);
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start){setStatus('Invalid range');return}
    const id='manual-'+(nextId.current++);
    setFindings([...findings,{id,kind:manual.kind||'pii',start,end,strategy:manual.strategy}]);
    setDecisions({...decisions,[id]:'accept'});
  }
  function removeFinding(id:string){
    setFindings(findings.filter(f=>f.id!==id));
  }
  const payload=()=>({
    revision:row!.revision,
    findings,
    decisions:findings.map(f=>({findingId:f.id,action:decisions[f.id]??'reject'})),
    resolutions:Object.entries(resolutions).map(([conflictId,strategy])=>({conflictId,strategy})),
  });
  async function buildPlan(){
    if(!row)return;
    const my=++seq.current;
    setStatus('Planning');
    const response=await fetch('/api/documents/'+row.id+'/redactions/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload())});
    const value=await response.json();
    if(my!==seq.current)return; // a newer request superseded this one
    if(response.status===409){setStatus('Revision conflict — reload');return}
    if(!response.ok){setStatus(value.error??'Plan failed');return}
    setPlan(value);
    setStatus(value.status==='ok'?'Plan ready':value.status==='conflict'?'Resolve conflicts':'Invalid ranges');
  }
  async function apply(){
    if(!row)return;
    const my=++seq.current;
    setStatus('Applying');
    const response=await fetch('/api/documents/'+row.id+'/redactions/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload())});
    const value=await response.json();
    if(my!==seq.current)return;
    if(response.status===409){setStatus('Revision conflict — reload');return}
    if(response.status===422&&value.error==='unresolved_conflicts'){setPlan({status:'conflict',conflicts:value.conflicts});setStatus('Resolve conflicts');return}
    if(!response.ok){setStatus(value.error??'Apply failed');return}
    setApplied({output:value.output,spans:value.spans,leaks:value.leaks});
    setStatus('Applied');
  }

  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>Redaction Review Studio</strong><small>Local workspace</small></header>
    <section className="workspace">
      <aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={analyze}><ScanSearch size={15}/>Analyze</button>
          <button onClick={buildPlan} disabled={dirty||findings.length===0}><Play size={15}/>Build plan</button>
          <button onClick={apply} disabled={dirty||plan?.status!=='ok'}>Apply redactions</button>
          <span>{status}</span>
        </div>
        {dirty&&<p className="warn">Unsaved edits — save before planning so ranges match the stored revision.</p>}
        <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/>
        <h2>Findings</h2>
        <div className="findings">
          {findings.map(f=><div className={'finding'+(decisions[f.id]==='accept'?' accepted':'')} key={f.id}>
            <label><input type="checkbox" checked={decisions[f.id]==='accept'} onChange={e=>setDecisions({...decisions,[f.id]:e.target.checked?'accept':'reject'})}/> accept</label>
            <code>[{f.start},{f.end})</code>
            <span className="pill">{f.kind}</span>
            <select aria-label="Strategy" value={f.strategy} onChange={e=>setFindings(findings.map(x=>x.id===f.id?{...x,strategy:e.target.value}:x))}>{STRATEGIES.map(s=><option key={s} value={s}>{s}</option>)}</select>
            <span className="excerpt">{row?row.content.slice(f.start,f.end)||'(empty)':''}</span>
            <button aria-label="Remove finding" onClick={()=>removeFinding(f.id)}><Trash2 size={14}/></button>
          </div>)}
          {findings.length===0&&<p><small>No findings yet — run Analyze or add a range manually.</small></p>}
        </div>
        <div className="addform">
          <input aria-label="Start" value={manual.start} onChange={e=>setManual({...manual,start:e.target.value})}/>
          <input aria-label="End" value={manual.end} onChange={e=>setManual({...manual,end:e.target.value})}/>
          <input aria-label="Kind" value={manual.kind} onChange={e=>setManual({...manual,kind:e.target.value})}/>
          <select aria-label="Manual strategy" value={manual.strategy} onChange={e=>setManual({...manual,strategy:e.target.value})}>{STRATEGIES.map(s=><option key={s} value={s}>{s}</option>)}</select>
          <button onClick={addFinding}><Plus size={14}/>Add range</button>
        </div>
      </section>
      <aside className="pane">
        <h2>Review</h2>
        {plan?.status==='conflict'&&<div>
          {plan.conflicts.map(c=><div className="conflict" key={c.id}>
            <strong><AlertTriangle size={14}/> Overlap [{c.intersection.start},{c.intersection.end})</strong>
            <p><code>{c.left.join(', ')}</code> ({c.strategies[0]}) intersects <code>{c.right.join(', ')}</code> ({c.strategies[1]}) — pick the winning strategy:</p>
            <select aria-label="Winning strategy" value={resolutions[c.id]??''} onChange={e=>setResolutions({...resolutions,[c.id]:e.target.value})}>
              <option value="" disabled>choose…</option>
              {c.strategies.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          </div>)}
          <button className="primary" disabled={plan.conflicts.some(c=>!resolutions[c.id])} onClick={buildPlan}>Rebuild plan</button>
        </div>}
        {plan?.status==='invalid'&&<div className="conflict">{plan.problems.map(p=><p key={p}>{p}</p>)}</div>}
        {plan?.status==='ok'&&<div>
          <h3>Canonical spans</h3>
          <div className="spans">{plan.spans.map((s,i)=><div className="span" key={i}>
            <code>[{s.start},{s.end})</code> <span className="pill">{s.strategy}</span> → <code>{s.replacement||'(empty)'}</code><br/>
            <small>audit refs: {s.sources.join(', ')}</small>
          </div>)}</div>
        </div>}
        {applied&&<div>
          <h3>Output</h3>
          <pre className="output">{applied.output}</pre>
          {applied.leaks.length===0
            ?<p className="ok"><ShieldCheck size={14}/> No accepted original remains</p>
            :<p className="warn">Leaked originals: {applied.leaks.join(', ')}</p>}
          <button onClick={()=>setDraft(applied.output)}>Use as draft</button>
        </div>}
      </aside>
    </section>
  </main>;
}
