import {describe,expect,it} from 'vitest';
import {applyPlan,buildCanonicalPlan,detectFindings,detectLeaks,Decision,Finding,Plan,Resolution} from '../src/server/redaction';

const f=(id:string,start:number,end:number,kind='pii',strategy='mask'):Finding=>({id,start,end,kind,strategy});
const acceptAll=(fs:Finding[]):Decision[]=>fs.map(x=>({findingId:x.id,action:'accept'}));
const planOf=(content:string,fs:Finding[],decisions=acceptAll(fs),resolutions:Resolution[]=[])=>buildCanonicalPlan(content.length,fs,decisions,resolutions);
const spansOf=(plan:Plan)=>{if(plan.status!=='ok')throw new Error('expected ok plan, got '+plan.status);return plan.spans};

describe('containment',()=>{
  it('lets the outer strategy dominate and keeps inner findings as audit refs',()=>{
    const content='addr=12 Riverside Ave; name=Grace Lin; end';
    const aStart=content.indexOf('12 Riverside');
    const nStart=content.indexOf('Grace Lin');
    const fs=[f('addr',aStart,nStart+9,'address','mask'),f('name',nStart,nStart+9,'name','hash')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({start:aStart,end:nStart+9,strategy:'mask',replacement:'[REDACTED:ADDRESS]'});
    expect(spans[0].sources).toEqual(['addr','name']);
    const out=applyPlan(content,spans);
    expect(out).toBe('addr=[REDACTED:ADDRESS]; end');
    expect(out).not.toContain('Grace Lin');
    expect(detectLeaks(content,out,fs)).toEqual([]);
  });
  it('folds multi-level nesting into the outermost span',()=>{
    const content='x'.repeat(40);
    const fs=[f('outer',0,30,'a','mask'),f('mid',5,20,'b','hash'),f('inner',8,12,'c','tokenize')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toEqual([{start:0,end:30,strategy:'mask',replacement:'[REDACTED:A]',sources:['inner','mid','outer']}]);
  });
  it('never leaks the outer tail through stale coordinates',()=>{
    // Regression for the reported bug: replacing the inner range first and
    // then applying the outer range with its old offsets leaves the outer
    // tail of the original text in the output. Streaming application reads
    // every coordinate from the original content exactly once.
    const content='--abcdefgh--';
    const fs=[f('outer',2,10,'o','mask'),f('inner',4,6,'i','hash')];
    const out=applyPlan(content,spansOf(planOf(content,fs)));
    expect(out).toBe('--[REDACTED:O]--');
    expect(out).not.toContain('efgh');
    expect(detectLeaks(content,out,fs)).toEqual([]);
  });
});

describe('partial overlap',()=>{
  const content='0123456789abcde';
  it('merges same-strategy overlaps into one span',()=>{
    const fs=[f('a',0,10,'one','mask'),f('b',5,15,'two','mask')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toEqual([{start:0,end:15,strategy:'mask',replacement:'[REDACTED:MASK]',sources:['a','b']}]);
    expect(applyPlan(content,spans)).toBe('[REDACTED:MASK]');
  });
  it('requires an explicit resolution for conflicting strategies',()=>{
    const fs=[f('a',0,10,'one','mask'),f('b',5,15,'two','hash')];
    const plan=planOf(content,fs);
    expect(plan.status).toBe('conflict');
    if(plan.status!=='conflict')return;
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].intersection).toEqual({start:5,end:10});
    expect(plan.conflicts[0].strategies).toEqual(['mask','hash']);
    const resolved=planOf(content,fs,acceptAll(fs),[{conflictId:plan.conflicts[0].id,strategy:'hash'}]);
    const spans=spansOf(resolved);
    expect(spans).toEqual([{start:0,end:15,strategy:'hash',replacement:'[REDACTED:HASH]',sources:['a','b']}]);
    expect(applyPlan(content,spans)).toBe('[REDACTED:HASH]');
  });
});

describe('adjacency',()=>{
  const content='aaaabbbb';
  it('merges adjacent ranges that share a strategy',()=>{
    const fs=[f('a',0,4,'one','mask'),f('b',4,8,'two','mask')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toEqual([{start:0,end:8,strategy:'mask',replacement:'[REDACTED:MASK]',sources:['a','b']}]);
    expect(applyPlan(content,spans)).toBe('[REDACTED:MASK]');
  });
  it('keeps adjacent ranges with different strategies separate',()=>{
    const fs=[f('a',0,4,'one','mask'),f('b',4,8,'two','hash')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toEqual([
      {start:0,end:4,strategy:'mask',replacement:'[REDACTED:ONE]',sources:['a']},
      {start:4,end:8,strategy:'hash',replacement:'[REDACTED:TWO]',sources:['b']},
    ]);
    expect(applyPlan(content,spans)).toBe('[REDACTED:ONE][REDACTED:TWO]');
  });
});

describe('zero-length suggestions',()=>{
  const content='hello world';
  it('applies as a pure insertion',()=>{
    const fs=[f('mark',6,6,'marker','mask')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toEqual([{start:6,end:6,strategy:'mask',replacement:'[REDACTED:MARKER]',sources:['mark']}]);
    expect(applyPlan(content,spans)).toBe('hello [REDACTED:MARKER]world');
  });
  it('merges with an adjacent same-strategy range',()=>{
    const fs=[f('w',0,5,'word','mask'),f('z',5,5,'marker','mask')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({start:0,end:5,sources:['w','z']});
  });
  it('keeps same-position insertions with different strategies in order',()=>{
    const fs=[f('a',6,6,'one','mask'),f('b',6,6,'two','hash')];
    const spans=spansOf(planOf(content,fs));
    expect(spans).toHaveLength(2);
    expect(applyPlan(content,spans)).toBe('hello [REDACTED:ONE][REDACTED:TWO]world');
  });
  it('supports the remove strategy as an empty replacement',()=>{
    const fs=[f('w',0,5,'word','remove')];
    expect(applyPlan(content,spansOf(planOf(content,fs)))).toBe(' world');
  });
});

describe('unicode ranges',()=>{
  it('honours UTF-16 code-unit offsets around emoji and CJK text',()=>{
    const content='🔒 alpha 秘密 beta'; // 🔒 is two code units
    const cStart=content.indexOf('秘密');
    const fs=[f('emoji',0,2,'token','mask'),f('han',cStart,cStart+2,'name','hash')];
    const spans=spansOf(planOf(content,fs));
    expect(applyPlan(content,spans)).toBe('[REDACTED:TOKEN] alpha [REDACTED:NAME] beta');
    expect(detectLeaks(content,applyPlan(content,spans),fs)).toEqual([]);
  });
  it('inserts a zero-length suggestion at a surrogate-pair boundary',()=>{
    const content='🔒 alpha';
    const fs=[f('mark',2,2,'marker','mask')];
    expect(applyPlan(content,spansOf(planOf(content,fs)))).toBe('🔒[REDACTED:MARKER] alpha');
  });
});

describe('validation and leak detection',()=>{
  it('rejects ranges outside the pinned content',()=>{
    const plan=planOf('short',[f('bad',0,99)]);
    expect(plan).toEqual({status:'invalid',problems:['bad: range [0,99) outside 0..5']});
    expect(planOf('short',[f('bad',4,2)]).status).toBe('invalid');
  });
  it('ignores findings without an accept decision',()=>{
    const fs=[f('a',0,2),f('b',3,5)];
    const spans=spansOf(planOf('abcdef',fs,[{findingId:'a',action:'accept'},{findingId:'b',action:'reject'}]));
    expect(spans.map(s=>s.sources)).toEqual([['a']]);
  });
  it('does not flag natural occurrences of the redacted text elsewhere',()=>{
    const content='Grace met Grace';
    const fs=[f('n',0,5,'name','mask')];
    const out=applyPlan(content,spansOf(planOf(content,fs)));
    expect(out).toBe('[REDACTED:NAME] met Grace');
    expect(detectLeaks(content,out,fs)).toEqual([]);
  });
  it('flags surviving copies of an accepted original',()=>{
    const content='Grace met Grace';
    expect(detectLeaks(content,'[REDACTED:NAME] met Grace Grace',[f('n',0,5)])).toEqual(['Grace']);
  });
});

describe('suggestion pass',()=>{
  it('detects emails, phones, names and addresses with exact ranges',()=>{
    const content='mail ada@example.com or 555-0134\naddress: 1 Main St\nname: Grace Lin';
    const findings=detectFindings(content);
    const byKind=Object.fromEntries(findings.map(x=>[x.kind,x]));
    expect(content.slice(byKind.email.start,byKind.email.end)).toBe('ada@example.com');
    expect(content.slice(byKind.phone.start,byKind.phone.end)).toBe('555-0134');
    expect(content.slice(byKind.address.start,byKind.address.end)).toBe('1 Main St');
    expect(content.slice(byKind.name.start,byKind.name.end)).toBe('Grace Lin');
  });
});
