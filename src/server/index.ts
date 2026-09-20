import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  applyPlan,
  buildPlan,
  codePoints,
  RedactionError,
  type InputRange,
  type Resolution,
} from './redaction.js';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};

const alphaContent =
  '收件地址：北京市海淀区中关村大街1号，联系人张三。\n' +
  '备用地址：上海市浦东新区张江路88号，联系人李四。\n' +
  '备注：张三同时负责两个站点，🎉 完成。';
const betaContent =
  '电话：010-88889999；手机：13800001111。\n' +
  '邮箱 zhang.san@example.com 由赵六维护。🐱‍👤';

const rows: RecordRow[] = [
  {id:'alpha',name:'Primary redaction findings',revision:3,content:alphaContent,updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary redaction findings',revision:5,content:betaContent,updatedAt:new Date(1000).toISOString()},
];

/** 码元（code point）下标定位，保证 emoji / 代理对占一个偏移。 */
function locate(content: string, needle: string): {start:number;end:number} {
  const cps = codePoints(content);
  const target = codePoints(needle);
  outer: for (let i = 0; i + target.length <= cps.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (cps[i + j] !== target[j]) continue outer;
    }
    return {start: i, end: i + target.length};
  }
  return {start: -1, end: -1};
}

function range(content: string, id: string, needle: string, kind: InputRange['kind'], strategy: InputRange['strategy']): InputRange | null {
  const {start, end} = locate(content, needle);
  if (start < 0) return null;
  return {id, start, end, kind, strategy};
}

function buildSuggestions(row: RecordRow): InputRange[] {
  if (row.id === 'alpha') {
    return [
      range(row.content, 'addr-1', '北京市海淀区中关村大街1号，联系人张三。', 'address', {kind: 'mask'}),
      range(row.content, 'name-1', '张三', 'name', {kind: 'label', text: '[姓名]'}),
      range(row.content, 'addr-2', '上海市浦东新区张江路88号，联系人李四。', 'address', {kind: 'remove'}),
      range(row.content, 'name-2', '李四', 'name', {kind: 'label', text: '[姓名]'}),
      // 相互部分相交的两个内层建议，且都落在 addr-2 内 → 外层策略主导，不产生待决冲突。
      range(row.content, 'inner-a', '上海市浦东新区张江路88号，联系人', 'address', {kind: 'mask'}),
      range(row.content, 'inner-b', '浦东新区张江路88号，联系人李四', 'generic', {kind: 'hash'}),
      // 部分相交且策略冲突、且不被任何外层包含 → 必须用户解决。
      range(row.content, 'conflict-a', '两个站点', 'generic', {kind: 'hash'}),
      range(row.content, 'conflict-b', '站点，🎉', 'generic', {kind: 'label', text: '[地点]'}),
      // 零长度建议。
      {id: 'zero-tail', start: codePoints(row.content).length, end: codePoints(row.content).length, kind: 'generic', strategy: {kind: 'mask'}},
    ].filter((value): value is InputRange => value !== null);
  }
  return [
    // 相邻且同策略（hash）→ 合并。
    range(row.content, 'mail-user', 'zhang.san', 'generic', {kind: 'hash'}),
    range(row.content, 'mail-host', '@example.com', 'generic', {kind: 'hash'}),
    // 包含：外层 remove 主导，姓名内层仅保留审计引用。
    range(row.content, 'phrase-1', '由赵六维护', 'generic', {kind: 'remove'}),
    range(row.content, 'name-3', '赵六', 'name', {kind: 'label', text: '[姓名]'}),
    // 相邻但不同策略（remove vs mask）→ 不得合并。
    range(row.content, 'dot', '。', 'generic', {kind: 'remove'}),
    range(row.content, 'emoji-zwnj', '🐱‍👤', 'generic', {kind: 'mask'}),
    // 零长度建议。
    {id: 'zero-head', start: 0, end: 0, kind: 'generic', strategy: {kind: 'mask'}},
  ].filter((value): value is InputRange => value !== null);
}

const suggestions = new Map(rows.map((row) => [row.id, buildSuggestions(row)]));

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"document-redaction",count:rows.length}));
  app.get('/api/documents',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/documents/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/documents/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/documents/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // 固定 revision 上的初始建议（码元坐标）。
  app.get('/api/documents/:id/suggestions',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.json({id:row.id,revision:row.revision,length:codePoints(row.content).length,ranges:suggestions.get(row.id)});
  });

  // 在固定文档 revision 上构建规范范围集合。
  app.post('/api/documents/:id/redaction/plan',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision){
      return res.status(409).json({error:'revision_conflict',current:{id:row.id,revision:row.revision}});
    }
    try{
      const resolutions:Resolution[]=Array.isArray(req.body.resolutions)?req.body.resolutions:[];
      const plan=buildPlan(row.content,req.body.ranges,resolutions);
      const applied=plan.ready?applyPlan(row.content,plan):null;
      res.json({id:row.id,revision:row.revision,plan,preview:applied?.output??null,warnings:applied?{leaks:applied.leaks,ineffective:applied.ineffective}:{leaks:[],ineffective:[]}});
    }catch(error){
      if(error instanceof RedactionError)return res.status(error.status).json({error:error.message,details:error.details});
      throw error;
    }
  });

  // 最终替换：仅接受基于当前 revision、且冲突全部解决的请求。
  app.post('/api/documents/:id/redaction/apply',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision){
      return res.status(409).json({error:'revision_conflict',current:{id:row.id,revision:row.revision}});
    }
    try{
      const resolutions:Resolution[]=Array.isArray(req.body.resolutions)?req.body.resolutions:[];
      const plan=buildPlan(row.content,req.body.ranges,resolutions);
      if(!plan.ready){
        return res.status(422).json({error:'conflicts_unresolved',plan});
      }
      // 流式切片替换；服务端不信任任何客户端预览。
      const {output,leaks,ineffective}=applyPlan(row.content,plan);
      if(ineffective.length>0){
        return res.status(422).json({error:'redaction_ineffective',ineffective});
      }
      if(leaks.length>0){
        return res.status(500).json({error:'redaction_leak_detected',leaks});
      }
      const persist=req.body.persist===true;
      if(persist){
        row.content=output;
        row.revision+=1;
        row.updatedAt=new Date().toISOString();
        suggestions.set(row.id,[]);
      }
      res.json({id:row.id,revision:row.revision,output,plan,persisted:persist});
    }catch(error){
      if(error instanceof RedactionError)return res.status(error.status).json({error:error.message,details:error.details});
      throw error;
    }
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
