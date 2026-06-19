'use strict';

const { getPool } = require('../db');
const store = require('../data/store');
const audit = require('./audit');
const { httpError } = require('../utils/http');

/**
 * 收费敏感操作审批 —— 独立核心块。
 *
 * 免单 / 手工改价 / 打折 / 退款 一律不可由操作员直接生效，必须走申请-审批：
 *   PENDING --(approve)--> APPROVED（同事务内落地到停车账单）
 *   PENDING --(reject)----> REJECTED
 *
 * 权限隔离：操作员（approverLevel=0）只能发起；审批需 approverLevel >= 申请 tier，
 * 且审批人不得为发起人本人（防自批）。
 * 额度分级：金额超过可配上限 → tier=2，需更高一级审批人。
 * 原子性：申请/审批与审计追加在同一事务内完成。
 */

const TYPES = { WAIVER: 'WAIVER', DISCOUNT: 'DISCOUNT', REFUND: 'REFUND', PRICE_CHANGE: 'PRICE_CHANGE' };
const TYPE_LIST = Object.values(TYPES);
const STATUSES = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };

/** 依据可配额度上限判定审批级别（1=普通，2=超限需更高一级）。 */
function tierFor(type, amountCents, finalFeeCents, currentFee, limits) {
  if (type === TYPES.PRICE_CHANGE) {
    const delta = (currentFee || 0) - (finalFeeCents || 0);
    return delta > 0 && delta > limits.priceChange ? 2 : 1;
  }
  const limit = type === TYPES.WAIVER ? limits.waiver
    : type === TYPES.DISCOUNT ? limits.discount
      : type === TYPES.REFUND ? limits.refund : 0;
  return amountCents > limit ? 2 : 1;
}

async function loadLimits() {
  const [w, d, r, p] = await Promise.all([
    store.getConfigValue('limit_waiver_cents'),
    store.getConfigValue('limit_discount_cents'),
    store.getConfigValue('limit_refund_cents'),
    store.getConfigValue('limit_price_change_cents'),
  ]);
  return { waiver: Number(w) || 0, discount: Number(d) || 0, refund: Number(r) || 0, priceChange: Number(p) || 0 };
}

/* ----------------------------- 发起申请 ----------------------------- */

async function createRequest({ operator, sessionId, type, amountCents, finalFeeCents, reason }) {
  if (!operator) throw httpError(401, '未认证');
  if (operator.role === 'VIEWER') throw httpError(403, '观察员无权发起敏感操作');
  if (!TYPE_LIST.includes(type)) throw httpError(400, '非法的操作类型');
  if (!reason || !String(reason).trim()) throw httpError(400, '申请理由不能为空');
  const sid = Number(sessionId);
  if (!Number.isInteger(sid) || sid <= 0) throw httpError(400, '非法的停车账单 id');

  const session = await store.getSessionById(sid);
  if (!session) throw httpError(404, '停车账单不存在');
  if (session.status !== 'FINISHED') throw httpError(400, '仅可对已结费的停车账单发起敏感操作');

  const amt = Number(amountCents);
  let finalFee = finalFeeCents === undefined || finalFeeCents === null ? null : Number(finalFeeCents);
  if (type === TYPES.PRICE_CHANGE) {
    if (!Number.isInteger(finalFee) || finalFee < 0) throw httpError(400, '改价目标金额非法（非负整数，单位分）');
  } else {
    if (!Number.isInteger(amt) || amt <= 0) throw httpError(400, '金额必须为正整数（单位分）');
    if (amt > session.feeCents) throw httpError(400, '减免金额不能超过该账单应收金额');
    finalFee = null;
  }

  const limits = await loadLimits();
  const tier = tierFor(type, amt, finalFee, session.feeCents, limits);

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const adj = await store.createAdjustment({
      sessionId: session.id, lotId: session.lotId, operatorId: operator.id,
      type, amountCents: type === TYPES.PRICE_CHANGE ? 0 : amt, finalFeeCents: finalFee,
      reason: String(reason).trim(), tier,
    }, conn);
    await audit.appendAudit(conn, {
      recordId: adj.id, actorId: operator.id, eventType: 'ADJUSTMENT_REQUESTED',
      payload: {
        type, amountCents: adj.amountCents, finalFeeCents: adj.finalFeeCents,
        reason: adj.reason, tier, sessionId: session.id, lotId: session.lotId,
        currentFeeCents: session.feeCents, operatorId: operator.id, operatorName: operator.name,
      },
    });
    await conn.commit();
    return adj;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

/* ----------------------------- 审批通过 ----------------------------- */

async function approve({ approver, adjustmentId, note }) {
  if (!approver) throw httpError(401, '未认证');
  const id = Number(adjustmentId);
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const adj = await store.getAdjustmentForUpdate(conn, id);
    if (!adj) throw httpError(404, '审批单不存在');
    if (adj.status !== STATUSES.PENDING) throw httpError(409, `该申请当前状态为 ${adj.status}，不可审批`);
    if (approver.id === adj.operatorId) throw httpError(403, '不能审批自己发起的申请');
    const level = Number(approver.approverLevel) || 0;
    if (level < adj.tier) {
      throw httpError(403, `该申请为 ${adj.tier} 级，需更高权限审批人（当前审批级别 ${level}）`);
    }
    const session = await store.getSessionForUpdate(conn, adj.sessionId);
    if (!session) throw httpError(404, '关联停车账单不存在');
    if (session.status !== 'FINISHED') throw httpError(409, '关联账单未结费，无法落地');

    const before = session.feeCents;
    let after;
    if (adj.type === TYPES.PRICE_CHANGE) after = adj.finalFeeCents;
    else after = Math.max(0, before - adj.amountCents);

    await store.setSessionFeeCents(conn, session.id, after);
    const updated = await store.decideAdjustment(id, {
      status: STATUSES.APPROVED, approverId: approver.id, approvedAt: new Date(),
      decisionNote: note ? String(note) : null, beforeFeeCents: before, afterFeeCents: after,
    }, conn);
    await audit.appendAudit(conn, {
      recordId: id, actorId: approver.id, eventType: 'ADJUSTMENT_APPROVED',
      payload: {
        type: adj.type, amountCents: adj.amountCents, finalFeeCents: adj.finalFeeCents,
        tier: adj.tier, approverId: approver.id, approverName: approver.name,
        note: note ? String(note) : null, beforeFeeCents: before, afterFeeCents: after,
        sessionId: session.id, lotId: adj.lotId, operatorId: adj.operatorId,
      },
    });
    await conn.commit();
    return updated;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

/* ----------------------------- 审批驳回 ----------------------------- */

async function reject({ approver, adjustmentId, note }) {
  if (!approver) throw httpError(401, '未认证');
  const level = Number(approver.approverLevel) || 0;
  if (level < 1) throw httpError(403, '无审批权限');
  const id = Number(adjustmentId);
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const adj = await store.getAdjustmentForUpdate(conn, id);
    if (!adj) throw httpError(404, '审批单不存在');
    if (adj.status !== STATUSES.PENDING) throw httpError(409, `该申请当前状态为 ${adj.status}，不可驳回`);
    if (approver.id === adj.operatorId) throw httpError(403, '不能审批自己发起的申请');
    const updated = await store.decideAdjustment(id, {
      status: STATUSES.REJECTED, approverId: approver.id, decisionNote: note ? String(note) : null,
    }, conn);
    await audit.appendAudit(conn, {
      recordId: id, actorId: approver.id, eventType: 'ADJUSTMENT_REJECTED',
      payload: {
        type: adj.type, tier: adj.tier, approverId: approver.id, approverName: approver.name,
        note: note ? String(note) : null, operatorId: adj.operatorId,
        sessionId: adj.sessionId, lotId: adj.lotId,
      },
    });
    await conn.commit();
    return updated;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

async function listAdjustments(filter) {
  return store.listAdjustments(filter);
}
async function getAdjustment(id) {
  const adj = await store.getAdjustmentById(id);
  if (!adj) throw httpError(404, '审批单不存在');
  return adj;
}

module.exports = {
  TYPES, STATUSES, TYPE_LIST, tierFor, loadLimits,
  createRequest, approve, reject, listAdjustments, getAdjustment,
};
