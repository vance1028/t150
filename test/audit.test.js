'use strict';

// 收费敏感操作审批 + 防篡改审计链 + 监督告警 的端到端测试。
// 测试连接 MySQL（默认 127.0.0.1:13366，由 docker compose 起的 db 服务）。
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const supervision = require('../src/services/supervision');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });

test.before(async () => {
  await waitForDb();
  await ensureSchema();
  getPool();
});

test.beforeEach(async () => {
  await resetAll();
  await seed();
});

test.after(async () => { await close(); });

/* ----------------------------- 辅助 ----------------------------- */

async function loginAs(username, password) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  assert.strictEqual(res.status, 200, `登录失败: ${JSON.stringify(res.body)}`);
  return { token: res.body.data.token, user: res.body.data.user };
}

async function me(token) {
  const res = await request(app).get('/api/auth/me').set(auth(token));
  return res.body.data;
}

async function lotByCode(token, code) {
  const res = await request(app).get('/api/lots').set(auth(token));
  return res.body.data.find((l) => l.code === code);
}

/** 取种子中那条已结费账单（川AD6789，应收 1500）。 */
async function seedFinishedSession(token) {
  const res = await request(app).get('/api/sessions?status=FINISHED').set(auth(token));
  return res.body.data.find((s) => s.plateNo === '川AD6789');
}

/** 新建一条已结费账单并返回其 id。 */
async function createFinishedSession(token, lotId, plateNo, feeCents = 1000) {
  const enter = await request(app).post('/api/sessions/enter').set(auth(token))
    .send({ lotId, plateNo, enterTime: '2026-06-19 08:00:00' });
  assert.strictEqual(enter.status, 201, JSON.stringify(enter.body));
  const sid = enter.body.data.id;
  const exit = await request(app).post(`/api/sessions/${sid}/exit`).set(auth(token))
    .send({ exitTime: '2026-06-19 09:00:00', feeCents });
  assert.strictEqual(exit.status, 200, JSON.stringify(exit.body));
  return sid;
}

async function requestWaiver(token, sessionId, amountCents, reason = '客户投诉') {
  return request(app).post('/api/fee-adjustments').set(auth(token))
    .send({ sessionId, type: 'WAIVER', amountCents, reason });
}
async function requestPriceChange(token, sessionId, finalFeeCents, reason = '系统计费异常') {
  return request(app).post('/api/fee-adjustments').set(auth(token))
    .send({ sessionId, type: 'PRICE_CHANGE', finalFeeCents, reason });
}
async function approve(token, id, note) {
  return request(app).post(`/api/fee-adjustments/${id}/approve`).set(auth(token)).send({ note });
}
async function reject(token, id, note) {
  return request(app).post(`/api/fee-adjustments/${id}/reject`).set(auth(token)).send({ note });
}
async function verifyChain(token) {
  return request(app).get('/api/audit/verify').set(auth(token));
}

/* =====================================================================
 *  一、申请-审批状态机与权限隔离
 * ===================================================================== */

test('操作员发起免单申请：状态 PENDING、tier1、审计链落 1 条且校验通过', async () => {
  const op = await loginAs('operator', 'operator123');
  const sess = await seedFinishedSession(op.token);
  const res = await requestWaiver(op.token, sess.id, 300);
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const adj = res.body.data;
  assert.strictEqual(adj.status, 'PENDING');
  assert.strictEqual(adj.tier, 1);
  assert.strictEqual(adj.amountCents, 300);
  assert.strictEqual(adj.operatorId, op.user.id);

  const v = await verifyChain(op.token);
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.body.data.valid, true);
  assert.strictEqual(v.body.data.count, 1);

  const list = await request(app).get('/api/audit').set(auth(op.token));
  assert.strictEqual(list.body.data[0].eventType, 'ADJUSTMENT_REQUESTED');
});

test('viewer 无权发起敏感操作（403）', async () => {
  const v = await loginAs('viewer', 'viewer123');
  const sess = await seedFinishedSession(v.token);
  const res = await requestWaiver(v.token, sess.id, 300);
  assert.strictEqual(res.status, 403);
});

test('操作员不能审批自己发起的申请（403 防自批）', async () => {
  const op = await loginAs('operator', 'operator123');
  const sess = await seedFinishedSession(op.token);
  const { body } = await requestWaiver(op.token, sess.id, 300);
  const res = await approve(op.token, body.data.id);
  assert.strictEqual(res.status, 403);
});

test('低审批级别不能审批他人申请（操作员 level0 < tier1 → 403）', async () => {
  const admin = await loginAs('admin', 'admin123');
  const op = await loginAs('operator', 'operator123');
  const sess = await seedFinishedSession(admin.token);
  // 由 admin 发起，operator 试图审批：自批不适用，但级别不足
  const { body } = await requestWaiver(admin.token, sess.id, 300);
  const res = await approve(op.token, body.data.id);
  assert.strictEqual(res.status, 403);
});

test('审批通过：金额落地到账单、审计链增至 2 条、校验通过', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  assert.strictEqual(sess.feeCents, 1500);

  const { body: reqBody } = await requestWaiver(op.token, sess.id, 300);
  const res = await approve(admin.token, reqBody.data.id, '同意');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.status, 'APPROVED');
  assert.strictEqual(res.body.data.beforeFeeCents, 1500);
  assert.strictEqual(res.body.data.afterFeeCents, 1200);
  assert.strictEqual(res.body.data.approverId, admin.user.id);

  const after = await request(app).get(`/api/sessions/${sess.id}`).set(auth(op.token));
  assert.strictEqual(after.body.data.feeCents, 1200, '账单应收金额应已减免');

  const v = await verifyChain(op.token);
  assert.strictEqual(v.body.data.valid, true);
  assert.strictEqual(v.body.data.count, 2);
});

test('审批驳回：不改账单金额、审计链增至 2 条、校验通过', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);

  const { body: reqBody } = await requestWaiver(op.token, sess.id, 300);
  const res = await reject(admin.token, reqBody.data.id, '证据不足');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.status, 'REJECTED');

  const after = await request(app).get(`/api/sessions/${sess.id}`).set(auth(op.token));
  assert.strictEqual(after.body.data.feeCents, 1500, '驳回不应改变账单金额');

  const v = await verifyChain(op.token);
  assert.strictEqual(v.body.data.valid, true);
  assert.strictEqual(v.body.data.count, 2);
});

test('非 PENDING 状态不可再审批/驳回（409）', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  const { body: reqBody } = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, reqBody.data.id);

  const again = await approve(admin.token, reqBody.data.id);
  assert.strictEqual(again.status, 409);
  const rej = await reject(admin.token, reqBody.data.id);
  assert.strictEqual(rej.status, 409);
});

test('改价申请：按目标金额落地、delta 超限判 tier2', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);

  // delta = 1500 - 1000 = 500，未超 limit(500) → tier1
  const r1 = await requestPriceChange(op.token, sess.id, 1000);
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.body));
  assert.strictEqual(r1.body.data.tier, 1);
  await approve(admin.token, r1.body.data.id);
  const s1 = await request(app).get(`/api/sessions/${sess.id}`).set(auth(op.token));
  assert.strictEqual(s1.body.data.feeCents, 1000);
});

/* =====================================================================
 *  二、额度分级审批（超限需更高一级）
 * ===================================================================== */

test('超限免单判 tier2：一级审批人被拒、二级审批人通过', async () => {
  const admin = await loginAs('admin', 'admin123');
  const op = await loginAs('operator', 'operator123');
  // 新建一个 level1 审批人
  const ap1 = await request(app).post('/api/users').set(auth(admin.token))
    .send({ username: 'approver1', password: 'ap12345', name: '一级审批', role: 'ADMIN', approverLevel: 1 });
  assert.strictEqual(ap1.status, 201, JSON.stringify(ap1.body));
  const ap1Login = await loginAs('approver1', 'ap12345');

  const sess = await seedFinishedSession(op.token);
  // 默认 limit_waiver_cents=500，免 600 → tier2
  const r = await requestWaiver(op.token, sess.id, 600);
  assert.strictEqual(r.body.data.tier, 2);

  const blocked = await approve(ap1Login.token, r.body.data.id);
  assert.strictEqual(blocked.status, 403, '一级审批人不应通过超限申请');

  const ok = await approve(admin.token, r.body.data.id);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.data.status, 'APPROVED');
});

test('调高额度上限后，原超限金额变为 tier1', async () => {
  const admin = await loginAs('admin', 'admin123');
  const op = await loginAs('operator', 'operator123');
  const sess = await seedFinishedSession(op.token);
  await request(app).put('/api/supervision/config').set(auth(admin.token))
    .send({ limit_waiver_cents: '1000' });

  const r = await requestWaiver(op.token, sess.id, 600);
  assert.strictEqual(r.body.data.tier, 1, '上限提到 1000 后 600 应为 tier1');
});

/* =====================================================================
 *  三、防篡改哈希链与完整性校验
 * ===================================================================== */

test('审计链对外只读：无 POST/PUT/DELETE 接口（均 404）', async () => {
  const op = await loginAs('operator', 'operator123');
  const post = await request(app).post('/api/audit').set(auth(op.token)).send({});
  const put = await request(app).put('/api/audit/1').set(auth(op.token)).send({});
  const del = await request(app).delete('/api/audit/1').set(auth(op.token));
  assert.strictEqual(post.status, 404);
  assert.strictEqual(put.status, 404);
  assert.strictEqual(del.status, 404);
});

test('篡改审计内容：校验定位到断点（HASH_MISMATCH）', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  const { body } = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, body.data.id);

  const before = await verifyChain(op.token);
  assert.strictEqual(before.body.data.valid, true);

  // 模拟在库里偷偷改了第 1 条的内容
  await getPool().query("UPDATE audit_chain SET payload = 'tampered' WHERE seq = 1");

  const after = await verifyChain(op.token);
  assert.strictEqual(after.body.data.valid, false);
  assert.strictEqual(after.body.data.brokenAt, 1);
  assert.strictEqual(after.body.data.reason, 'HASH_MISMATCH');
});

test('删除审计中间记录：校验定位断点（SEQ_GAP / PREV 不衔接）', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  const { body } = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, body.data.id);

  await getPool().query('DELETE FROM audit_chain WHERE seq = 1');
  const after = await verifyChain(op.token);
  assert.strictEqual(after.body.data.valid, false);
  assert.strictEqual(after.body.data.brokenAt, 2, '应从被删的下一条开始报断');
});

test('删除审计尾部记录：校验定位断点（TAIL_MISMATCH）', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  const { body } = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, body.data.id);

  await getPool().query('DELETE FROM audit_chain WHERE seq = 2');
  const after = await verifyChain(op.token);
  assert.strictEqual(after.body.data.valid, false);
  assert.strictEqual(after.body.data.reason, 'TAIL_MISMATCH');
});

test('插入伪造审计记录：校验定位断点（PREV 不衔接）', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  const { body } = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, body.data.id);

  // 模拟在库里偷偷插入一条伪造记录（prev_hash 对不上真实链尾）
  await getPool().query(
    `INSERT INTO audit_chain (record_id, actor_id, event_type, payload, prev_hash, hash)
     VALUES (999, NULL, 'FAKE', 'fake', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000000')`,
  );
  const after = await verifyChain(op.token);
  assert.strictEqual(after.body.data.valid, false);
  assert.ok(after.body.data.brokenAt > 0, '应能发现插入的伪造记录并定位断点');
});

test('审计链列表返回 total 与升序 seq', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);
  const { body } = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, body.data.id);

  const res = await request(app).get('/api/audit').set(auth(op.token));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 2);
  assert.strictEqual(res.body.data[0].seq, 1);
  assert.strictEqual(res.body.data[1].seq, 2);
  assert.ok(res.body.data[0].hash.length === 64);
  assert.strictEqual(res.body.data[1].prevHash, res.body.data[0].hash, '下一条前指应等于上一条指纹');
});

/* =====================================================================
 *  四、监督统计与可疑行为告警
 * ===================================================================== */

test('统计：按操作员聚合免单/打折笔数与影响金额', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const sess = await seedFinishedSession(op.token);

  const w = await requestWaiver(op.token, sess.id, 300);
  await approve(admin.token, w.body.data.id); // 1500 -> 1200
  const d = await request(app).post('/api/fee-adjustments').set(auth(op.token))
    .send({ sessionId: sess.id, type: 'DISCOUNT', amountCents: 200, reason: '会员折扣' });
  await approve(admin.token, d.body.data.id); // 1200 -> 1000

  const res = await request(app).get(`/api/supervision/stats?operatorId=${op.user.id}`).set(auth(op.token));
  assert.strictEqual(res.status, 200);
  const byType = res.body.data.byType;
  assert.strictEqual(byType.WAIVER.count, 1);
  assert.strictEqual(byType.WAIVER.impactCents, 300);
  assert.strictEqual(byType.DISCOUNT.count, 1);
  assert.strictEqual(byType.DISCOUNT.impactCents, 200);
  assert.strictEqual(res.body.data.total.count, 2);
  assert.strictEqual(res.body.data.total.impactCents, 500);
});

test('告警：频繁小额免单 + 停车场免单率偏高 同时命中', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const lot2 = await lotByCode(op.token, 'PL-JN-002');

  for (let i = 0; i < 3; i += 1) {
    const sid = await createFinishedSession(op.token, lot2.id, `测A${1000 + i}`, 1000);
    const r = await requestWaiver(op.token, sid, 100); // 小额免单
    const ap = await approve(admin.token, r.body.data.id);
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  }

  const res = await request(app).get('/api/supervision/alerts').set(auth(op.token));
  assert.strictEqual(res.status, 200);
  const rules = res.body.data.alerts.map((a) => a.rule);
  assert.ok(rules.includes('FREQUENT_SMALL_WAIVER'), '应命中频繁小额免单');
  assert.ok(rules.includes('LOT_HIGH_WAIVER_RATE'), '应命中停车场免单率偏高');
  const freq = res.body.data.alerts.find((a) => a.rule === 'FREQUENT_SMALL_WAIVER');
  assert.strictEqual(freq.count, 3);
  assert.strictEqual(freq.operatorId, op.user.id);
});

test('告警：临近交班集中改价（回填时间模拟）', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');
  const lot2 = await lotByCode(op.token, 'PL-JN-002');

  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const sid = await createFinishedSession(op.token, lot2.id, `测P${2000 + i}`, 1000);
    const r = await requestPriceChange(op.token, sid, 800);
    const ap = await approve(admin.token, r.body.data.id);
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    ids.push(r.body.data.id);
  }
  // 回填为临近 8 点交班（07:50，距 08:00 仅 10 分钟）
  await getPool().query(
    'UPDATE fee_adjustments SET created_at = ? WHERE id IN (?, ?, ?)',
    ['2026-06-19 07:50:00', ids[0], ids[1], ids[2]],
  );

  const res = await request(app).get('/api/supervision/alerts').set(auth(op.token));
  const burst = res.body.data.alerts.find((a) => a.rule === 'SHIFT_PRICE_CHANGE_BURST');
  assert.ok(burst, '应命中临近交班集中改价');
  assert.strictEqual(burst.count, 3);
  assert.strictEqual(burst.operatorId, op.user.id);
});

test('isNearShift 纯函数：交班前窗口内为真、窗口外为假', () => {
  const shifts = [8 * 60, 16 * 60, 24 * 60];
  assert.ok(supervision.isNearShift(new Date('2026-06-19 07:50:00'), shifts, 30));
  assert.ok(supervision.isNearShift(new Date('2026-06-19 15:45:00'), shifts, 30));
  assert.ok(supervision.isNearShift(new Date('2026-06-19 23:50:00'), shifts, 30));
  assert.ok(!supervision.isNearShift(new Date('2026-06-19 10:00:00'), shifts, 30));
  assert.ok(!supervision.isNearShift(new Date('2026-06-19 08:31:00'), shifts, 30));
});

/* =====================================================================
 *  五、监督配置
 * ===================================================================== */

test('配置：非 admin 修改被拒（403）、未知键被拒（400）、admin 修改生效', async () => {
  const op = await loginAs('operator', 'operator123');
  const admin = await loginAs('admin', 'admin123');

  const forbid = await request(app).put('/api/supervision/config').set(auth(op.token))
    .send({ limit_waiver_cents: '1' });
  assert.strictEqual(forbid.status, 403);

  const bad = await request(app).put('/api/supervision/config').set(auth(admin.token))
    .send({ not_a_key: '1' });
  assert.strictEqual(bad.status, 400);

  const ok = await request(app).put('/api/supervision/config').set(auth(admin.token))
    .send({ limit_waiver_cents: '1000', frequent_waiver_count: '5' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.data.applied.limit_waiver_cents, '1000');
  assert.strictEqual(ok.body.data.config.limit_waiver_cents, '1000');

  const get = await request(app).get('/api/supervision/config').set(auth(admin.token));
  assert.strictEqual(get.body.data.limit_waiver_cents, '1000');
});
