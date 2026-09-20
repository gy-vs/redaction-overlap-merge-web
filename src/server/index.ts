import express from 'express';
import {fileURLToPath} from 'node:url';
import {applyPlan,buildCanonicalPlan,detectFindings,detectLeaks,Decision,Finding,Resolution} from './redaction';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary redaction findings',revision:3,content:'redaction findings: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary redaction findings',revision:5,content:'redaction findings: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"document-redaction",count:rows.length}));
  app.get('/api/documents',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/documents/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/documents/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/documents/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));const content=String(req.body.content??row.content);res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,diagnostics:[],findings:detectFindings(content)})});

  // Redaction planning and application are always computed against the
  // stored content of the pinned revision — never against client-mutated
  // text — so coordinates cannot go stale between preview and apply.
  const parseRanges=(req:express.Request)=>{
    const body=req.body??{};
    return{
      findings:(Array.isArray(body.findings)?body.findings:[]) as Finding[],
      decisions:(Array.isArray(body.decisions)?body.decisions:[]) as Decision[],
      resolutions:(Array.isArray(body.resolutions)?body.resolutions:[]) as Resolution[],
    };
  };
  const pinnedRow=(req:express.Request,res:express.Response)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row){res.status(404).json({error:'not_found'});return null}
    if(req.body?.revision!==row.revision){res.status(409).json({error:'revision_conflict',current:{id:row.id,revision:row.revision}});return null}
    return row;
  };
  app.post('/api/documents/:id/redactions/plan',(req,res)=>{
    const row=pinnedRow(req,res);if(!row)return;
    const {findings,decisions,resolutions}=parseRanges(req);
    const plan=buildCanonicalPlan(row.content.length,findings,decisions,resolutions);
    if(plan.status==='invalid')return res.status(422).json({error:'invalid_ranges',problems:plan.problems});
    res.json({revision:row.revision,...plan});
  });
  app.post('/api/documents/:id/redactions/apply',(req,res)=>{
    const row=pinnedRow(req,res);if(!row)return;
    const {findings,decisions,resolutions}=parseRanges(req);
    const plan=buildCanonicalPlan(row.content.length,findings,decisions,resolutions);
    if(plan.status==='invalid')return res.status(422).json({error:'invalid_ranges',problems:plan.problems});
    if(plan.status==='conflict')return res.status(422).json({error:'unresolved_conflicts',conflicts:plan.conflicts});
    // Structural guarantee: every accepted finding is folded into exactly
    // one canonical span, so its original text is always replaced.
    const accepted=findings.filter(f=>decisions.some(d=>d.findingId===f.id&&d.action==='accept'));
    const covered=new Set(plan.spans.flatMap(span=>span.sources));
    const missing=accepted.filter(f=>!covered.has(f.id)).map(f=>f.id);
    if(missing.length)return res.status(500).json({error:'coverage_gap',missing});
    const output=applyPlan(row.content,plan.spans);
    res.json({revision:row.revision,spans:plan.spans,output,leaks:detectLeaks(row.content,output,accepted)});
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
