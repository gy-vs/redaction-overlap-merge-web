import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/documents/alpha').expect(200);
    await request(app).put('/api/documents/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/documents/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('redaction planning',()=>{
  const CONTENT='redaction findings: Grace Lin\naddress: 1 Main St\nstate: active';
  async function seed(app:ReturnType<typeof createApp>){
    const doc=(await request(app).get('/api/documents/alpha').expect(200)).body;
    return (await request(app).put('/api/documents/alpha').send({content:CONTENT,revision:doc.revision}).expect(200)).body;
  }
  it('rejects plans and applies against a stale revision',async()=>{
    const app=createApp();
    const doc=await seed(app);
    const body={revision:doc.revision+1,findings:[],decisions:[]};
    await request(app).post('/api/documents/alpha/redactions/plan').send(body).expect(409);
    await request(app).post('/api/documents/alpha/redactions/apply').send(body).expect(409);
  });
  it('plans containment with the outer strategy and applies without leaks',async()=>{
    const app=createApp();
    const doc=await seed(app);
    const nStart=CONTENT.indexOf('Grace Lin');
    const aStart=CONTENT.indexOf('1 Main St');
    const findings=[
      {id:'addr',kind:'address',start:aStart,end:aStart+9,strategy:'mask'},
      {id:'name',kind:'name',start:nStart,end:nStart+9,strategy:'hash'},
    ];
    const decisions=findings.map(x=>({findingId:x.id,action:'accept'}));
    const plan=await request(app).post('/api/documents/alpha/redactions/plan').send({revision:doc.revision,findings,decisions}).expect(200);
    expect(plan.body.status).toBe('ok');
    const applied=await request(app).post('/api/documents/alpha/redactions/apply').send({revision:doc.revision,findings,decisions}).expect(200);
    expect(applied.body.output).not.toContain('Grace Lin');
    expect(applied.body.output).not.toContain('1 Main St');
    expect(applied.body.leaks).toEqual([]);
  });
  it('blocks apply until conflicting partial overlaps are resolved',async()=>{
    const app=createApp();
    const doc=await seed(app);
    const findings=[
      {id:'a',kind:'one',start:0,end:20,strategy:'mask'},
      {id:'b',kind:'two',start:10,end:30,strategy:'hash'},
    ];
    const decisions=findings.map(x=>({findingId:x.id,action:'accept'}));
    const plan=await request(app).post('/api/documents/alpha/redactions/plan').send({revision:doc.revision,findings,decisions}).expect(200);
    expect(plan.body.status).toBe('conflict');
    const conflictId=plan.body.conflicts[0].id;
    const denied=await request(app).post('/api/documents/alpha/redactions/apply').send({revision:doc.revision,findings,decisions}).expect(422);
    expect(denied.body.error).toBe('unresolved_conflicts');
    const resolved=await request(app).post('/api/documents/alpha/redactions/apply')
      .send({revision:doc.revision,findings,decisions,resolutions:[{conflictId,strategy:'hash'}]}).expect(200);
    expect(resolved.body.output.slice(0,'[REDACTED:HASH]'.length)).toBe('[REDACTED:HASH]');
    expect(resolved.body.leaks).toEqual([]);
  });
  it('rejects invalid ranges with 422',async()=>{
    const app=createApp();
    const doc=await seed(app);
    const res=await request(app).post('/api/documents/alpha/redactions/plan')
      .send({revision:doc.revision,findings:[{id:'bad',kind:'x',start:0,end:9999,strategy:'mask'}],decisions:[{findingId:'bad',action:'accept'}]}).expect(422);
    expect(res.body.error).toBe('invalid_ranges');
  });
  it('returns suggested findings from analyze',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/documents/alpha/analyze').send({content:'mail ada@example.com or 555-0134'}).expect(200);
    expect(res.body.findings.some((x:{kind:string})=>x.kind==='email')).toBe(true);
    expect(res.body.findings.some((x:{kind:string})=>x.kind==='phone')).toBe(true);
  });
});
