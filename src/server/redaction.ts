// Canonical redaction range planning and application.
//
// All offsets are UTF-16 code-unit positions (the same units used by
// String.prototype.slice and the Selection API) into the document content
// of one fixed revision. The server owns the content for that revision, so
// a plan is always computed and applied against identical coordinates.

export type Range={start:number;end:number};
export type Finding=Range&{id:string;kind:string;strategy:string;replacement?:string};
export type Decision={findingId:string;action:'accept'|'reject';replacement?:string};
export type Resolution={conflictId:string;strategy:string};
export type CanonicalSpan=Range&{strategy:string;replacement:string;sources:string[]};
export type Conflict={id:string;left:string[];right:string[];intersection:Range;strategies:string[]};
export type Plan=
  |{status:'ok';spans:CanonicalSpan[]}
  |{status:'conflict';conflicts:Conflict[]}
  |{status:'invalid';problems:string[]};

export function defaultReplacement(kind:string):string{
  return '[REDACTED:'+kind.toUpperCase()+']';
}
function strategyReplacement(strategy:string):string{
  return strategy==='remove'?'':'[REDACTED:'+strategy.toUpperCase()+']';
}

// A unit is an accepted finding while the canonical set is being built.
// Children are findings contained by this unit: the outer strategy wins,
// inner findings survive only as audit references in `sources`.
type Unit=Range&{strategy:string;replacement:string;sources:string[];children:Unit[]};

function collect(u:Unit):string[]{
  const ids=[...u.sources];
  for(const child of u.children)ids.push(...collect(child));
  return ids;
}

// Build the canonical, non-overlapping span set for the accepted findings.
//
// Overlap relations between half-open ranges [start,end):
//  - containment: the outer range dominates with its strategy; the inner
//    finding is kept as an audit reference on the resulting span.
//  - partial overlap, same strategy: merged into one span.
//  - partial overlap, conflicting strategies: never guessed — reported as a
//    conflict until the user picks a winning strategy via `resolutions`.
//  - adjacency (prev.end === next.start): merged only when strategies match;
//    different strategies stay as separate spans with their own replacements.
//  - zero-length ranges are valid insertions and follow the same rules.
export function buildCanonicalPlan(length:number,findings:Finding[],decisions:Decision[],resolutions:Resolution[]=[]):Plan{
  const decisionById=new Map(decisions.map(d=>[d.findingId,d]));
  const problems:string[]=[];
  const units:Unit[]=[];
  for(const f of findings){
    const decision=decisionById.get(f.id);
    if(!decision||decision.action!=='accept')continue;
    if(!Number.isInteger(f.start)||!Number.isInteger(f.end)||f.start<0||f.start>f.end||f.end>length){
      problems.push(f.id+': range ['+f.start+','+f.end+') outside 0..'+length);
      continue;
    }
    const replacement=decision.replacement??f.replacement??(f.strategy==='remove'?'':defaultReplacement(f.kind));
    units.push({start:f.start,end:f.end,strategy:f.strategy,replacement,sources:[f.id],children:[]});
  }
  if(problems.length)return{status:'invalid',problems};

  // Containers sort before their containees (same start, larger end first).
  units.sort((a,b)=>a.start-b.start||b.end-a.end);
  const chosen=new Map(resolutions.map(r=>[r.conflictId,r.strategy]));
  const conflicts:Conflict[]=[];
  const roots:Unit[]=[];
  const stack:Unit[]=[];
  const merge=(a:Unit,b:Unit,strategy:string)=>{ // b folds into a; a keeps its start
    a.end=Math.max(a.end,b.end);
    if(a.strategy!==strategy||a.replacement!==b.replacement)a.replacement=strategyReplacement(strategy);
    a.strategy=strategy;
    a.sources.push(...b.sources);
    a.children.push(...b.children);
  };
  for(const u of units){
    while(stack.length&&stack[stack.length-1].end<=u.start)stack.pop();
    const top=stack[stack.length-1];
    if(!top){roots.push(u);stack.push(u);continue}
    if(u.end<=top.end){top.children.push(u);stack.push(u);continue}
    // Partial overlap: top.start <= u.start < top.end < u.end.
    if(top.strategy===u.strategy){merge(top,u,top.strategy);continue}
    const left=[...top.sources].sort();
    const right=[...u.sources].sort();
    const id=left.join('+')+'|'+right.join('+');
    const strategy=chosen.get(id);
    if(strategy){merge(top,u,strategy);continue}
    conflicts.push({id,left,right,intersection:{start:u.start,end:top.end},strategies:[top.strategy,u.strategy]});
    // Keep the unresolved unit on the stack so later units are still checked
    // against it. Chained overlaps may surface in a later planning round once
    // earlier pairs are resolved — conflicts are never resolved by guessing.
    stack.push(u);
  }
  if(conflicts.length)return{status:'conflict',conflicts};

  // Fold containees into their container's audit refs, then merge adjacent
  // spans sharing a strategy. Adjacent spans with different strategies stay
  // separate so each keeps its own replacement.
  roots.sort((a,b)=>a.start-b.start||a.end-b.end);
  const spans:CanonicalSpan[]=[];
  for(const root of roots){
    const span:CanonicalSpan={start:root.start,end:root.end,strategy:root.strategy,replacement:root.replacement,sources:collect(root).sort()};
    const prev=spans[spans.length-1];
    if(prev&&prev.end===span.start&&prev.strategy===span.strategy){
      prev.end=span.end;
      prev.sources=[...prev.sources,...span.sources].sort();
      if(prev.replacement!==span.replacement)prev.replacement=strategyReplacement(prev.strategy);
    }else spans.push(span);
  }
  return{status:'ok',spans};
}

// Streaming slice application: every coordinate is read from the original
// content exactly once, in ascending order, and replacements never shift the
// coordinates of later spans. Stale-offset reuse is impossible by
// construction. Spans must be disjoint — buildCanonicalPlan guarantees this.
export function applyPlan(content:string,spans:CanonicalSpan[]):string{
  const ordered=[...spans].sort((a,b)=>a.start-b.start||a.end-b.end);
  let out='';
  let cursor=0;
  for(const span of ordered){
    if(span.start<cursor||span.start<0||span.end>content.length)throw new Error('non-canonical span ['+span.start+','+span.end+')');
    out+=content.slice(cursor,span.start)+span.replacement;
    cursor=span.end;
  }
  return out+content.slice(cursor);
}

// Safety net: an accepted range's original text must not survive in the
// output. Occurrences that naturally exist elsewhere in the document are
// accounted for, so only genuine leftovers are reported.
export function detectLeaks(content:string,output:string,ranges:Range[]):string[]{
  const consumed=new Map<string,number>();
  for(const range of ranges){
    const text=content.slice(range.start,range.end);
    if(text)consumed.set(text,(consumed.get(text)??0)+1);
  }
  const leaks:string[]=[];
  for(const [text,used] of consumed){
    const before=countOccurrences(content,text);
    const after=countOccurrences(output,text);
    if(after>Math.max(0,before-Math.min(used,before)))leaks.push(text);
  }
  return leaks;
}
function countOccurrences(haystack:string,needle:string):number{
  let count=0;
  let index=0;
  while((index=haystack.indexOf(needle,index))!==-1){count++;index+=needle.length}
  return count;
}

// Deterministic suggestion pass over the draft content.
export function detectFindings(content:string):Finding[]{
  const findings:Finding[]=[];
  const add=(kind:string,start:number,end:number)=>{
    if(end>start)findings.push({id:kind+':'+start+':'+end,kind,start,end,strategy:'mask'});
  };
  for(const m of content.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))add('email',m.index,m.index+m[0].length);
  for(const m of content.matchAll(/(?<!\d)\d{3}[-. ]\d{4}(?!\d)/g))add('phone',m.index,m.index+m[0].length);
  for(const m of content.matchAll(/(?:name|姓名)[:：]\s*([^\s,，;；\n]+(?: [^\s,，;；\n]+){0,2})/gi)){
    const at=m.index+m[0].length-m[1].length;
    add('name',at,at+m[1].length);
  }
  for(const m of content.matchAll(/(?:address|地址)[:：]\s*([^\n]+)/gi)){
    const at=m.index+m[0].length-m[1].length;
    add('address',at,at+m[1].length);
  }
  return findings.sort((a,b)=>a.start-b.start||a.end-b.end);
}
