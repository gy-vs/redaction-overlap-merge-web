import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const cp = (text: string) => Array.from(text).length;

/** 码元坐标定位。 */
function span(content: string, needle: string) {
  const start = cp(content.slice(0, content.indexOf(needle)));
  return {start, end: start + cp(needle)};
}

async function getDoc(app: ReturnType<typeof createApp>, id: string) {
  const res = await request(app).get('/api/documents/' + id).expect(200);
  return res.body as {id: string; revision: number; content: string};
}

describe('redaction API', () => {
  it('建议接口返回固定 revision 与码元坐标（含 emoji）', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'alpha');
    const res = await request(app).get('/api/documents/alpha/suggestions').expect(200);
    expect(res.body.revision).toBe(doc.revision);
    expect(res.body.length).toBe(cp(doc.content));
    const ids = res.body.ranges.map((x: {id: string}) => x.id);
    expect(ids).toContain('addr-1');
    expect(ids).toContain('zero-tail');
    // 零长度建议坐标合法
    const zero = res.body.ranges.find((x: {id: string}) => x.id === 'zero-tail');
    expect(zero.start).toBe(zero.end);
  });

  it('规范集合：完全包含时外层主导，预览不泄露任何已接受原文', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'alpha');
    const suggestions = (await request(app).get('/api/documents/alpha/suggestions')).body.ranges;
    const subset = suggestions.filter((s: {id: string}) => ['addr-1', 'name-1'].includes(s.id));
    const res = await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges: subset})
      .expect(200);
    expect(res.body.plan.ready).toBe(true);
    expect(res.body.plan.canonical).toHaveLength(1);
    expect(res.body.plan.canonical[0].contained).toEqual(['name-1']);
    expect(res.body.preview).not.toContain('北京市海淀区中关村大街1号，联系人张三。');
    // 外层内的姓名实例必须消失；范围外第二处“张三”不在任何已接受范围中
    expect(res.body.preview.startsWith('收件地址：' + '█'.repeat(cp('北京市海淀区中关村大街1号，联系人张三。')))).toBe(true);
    expect(res.body.preview).not.toContain('联系人张三');
  });

  it('部分相交且策略冲突 → 422，要求解决；解决后应用成功', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'alpha');
    const s1 = span(doc.content, '两个站点');
    const s2 = span(doc.content, '站点，🎉');
    const ranges = [
      {id: 'a', start: s1.start, end: s1.end, strategy: {kind: 'hash'}},
      {id: 'b', start: s2.start, end: s2.end, strategy: {kind: 'label', text: '[地点]'}},
    ];

    // 固定 revision 校验
    await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: 999, ranges})
      .expect(409);

    const planRes = await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges})
      .expect(200);
    expect(planRes.body.plan.ready).toBe(false);
    expect(planRes.body.plan.conflicts).toHaveLength(1);
    expect(planRes.body.preview).toBeNull();
    const conflictId = planRes.body.plan.conflicts[0].id;

    // 未解决直接 apply → 422
    const blocked = await request(app)
      .post('/api/documents/alpha/redaction/apply')
      .send({revision: doc.revision, ranges})
      .expect(422);
    expect(blocked.body.error).toBe('conflicts_unresolved');

    // 解决后再算一次 → 成功，输出无原文
    const applied = await request(app)
      .post('/api/documents/alpha/redaction/apply')
      .send({revision: doc.revision, ranges, resolutions: [{conflictId, chosenRangeId: 'b'}]})
      .expect(200);
    expect(applied.body.output).not.toContain('两个站点');
    expect(applied.body.output).toContain('[地点]');
  });

  it('旧预览不能覆盖新决策：改选后重新构建的集合反映新选择', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'alpha');
    const s1 = span(doc.content, '两个站点');
    const s2 = span(doc.content, '站点，🎉');
    const ranges = [
      {id: 'a', start: s1.start, end: s1.end, strategy: {kind: 'hash'}},
      {id: 'b', start: s2.start, end: s2.end, strategy: {kind: 'label', text: '[地点]'}},
    ];
    const conflictId = (await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges}))
      .body.plan.conflicts[0].id;

    const first = await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges, resolutions: [{conflictId, chosenRangeId: 'b'}]})
      .expect(200);
    expect(first.body.plan.canonical[0].strategy).toEqual({kind: 'label', text: '[地点]'});
    expect(first.body.preview).toContain('[地点]');

    // 同 revision、同范围，改选 a → 新规范集合与新预览，旧 label 决策不残留
    const second = await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges, resolutions: [{conflictId, chosenRangeId: 'a'}]})
      .expect(200);
    expect(second.body.plan.ready).toBe(true);
    expect(second.body.plan.canonical[0].strategy).toEqual({kind: 'hash'});
    expect(second.body.preview).not.toContain('[地点]');
    expect(second.body.preview).not.toContain('两个站点');
  });

  it('相邻同策略合并，相邻不同策略保留', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'beta');
    const suggestions = (await request(app).get('/api/documents/alpha/suggestions'.replace('alpha', 'beta'))).body.ranges;
    const same = suggestions.filter((s: {id: string}) => ['mail-user', 'mail-host'].includes(s.id));
    const samePlan = await request(app)
      .post('/api/documents/beta/redaction/plan')
      .send({revision: doc.revision, ranges: same})
      .expect(200);
    expect(samePlan.body.plan.canonical).toHaveLength(1);
    expect(samePlan.body.plan.canonical[0].mergedAdjacent).toBe(true);

    const diff = suggestions.filter((s: {id: string}) => ['dot', 'emoji-zwnj'].includes(s.id));
    const diffPlan = await request(app)
      .post('/api/documents/beta/redaction/plan')
      .send({revision: doc.revision, ranges: diff})
      .expect(200);
    expect(diffPlan.body.plan.canonical).toHaveLength(2);
    // ZWJ emoji 整体脱敏，不拆散
    expect(diffPlan.body.preview).not.toContain('🐱‍👤');
  });

  it('最终输出不得包含任何已接受范围原文（含内层）', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'beta');
    const suggestions = (await request(app).get('/api/documents/beta/suggestions')).body.ranges;
    // 全部建议（含被包含的赵六、相邻的邮箱片段、ZWJ emoji），零长度自动忽略
    const applied = await request(app)
      .post('/api/documents/beta/redaction/apply')
      .send({revision: doc.revision, ranges: suggestions})
      .expect(200);
    for (const original of ['zhang.san', '@example.com', '由赵六维护', '赵六', '🐱‍👤']) {
      expect(applied.body.output).not.toContain(original);
    }
  });

  it('非法范围（越界/坏策略）返回 400；恒等 label 在 apply 时被拒', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'alpha');
    await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges: [{id: 'x', start: 0, end: 9999, strategy: {kind: 'mask'}}]})
      .expect(400);
    await request(app)
      .post('/api/documents/alpha/redaction/plan')
      .send({revision: doc.revision, ranges: [{id: 'x', start: 0, end: 1, strategy: {kind: 'bogus'}}]})
      .expect(400);

    await request(app)
      .post('/api/documents/alpha/redaction/apply')
      .send({revision: doc.revision, ranges: [{id: 'x', start: 0, end: 1, strategy: {kind: 'label', text: doc.content[0]}}]})
      .expect(422);
  });

  it('persist 后 revision 前进且旧 revision 请求冲突', async () => {
    const app = createApp();
    const doc = await getDoc(app, 'alpha');
    const ranges = [{id: 's', start: 0, end: 1, strategy: {kind: 'mask'}}];
    const applied = await request(app)
      .post('/api/documents/alpha/redaction/apply')
      .send({revision: doc.revision, ranges, persist: true})
      .expect(200);
    expect(applied.body.revision).toBe(doc.revision + 1);
    expect(applied.body.persisted).toBe(true);
    await request(app)
      .post('/api/documents/alpha/redaction/apply')
      .send({revision: doc.revision, ranges})
      .expect(409);
  });
});
