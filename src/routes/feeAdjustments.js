'use strict';

const express = require('express');
const approval = require('../services/approval');
const { authRequired, requireRole } = require('../auth');
const { sendData, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

/** GET /api/fee-adjustments —— 审批单列表（status/type/operatorId/lotId/sessionId 过滤）。 */
router.get('/', async (req, res, next) => {
  try {
    const { status, type, operatorId, lotId, sessionId } = req.query;
    const filter = { status, type };
    if (operatorId !== undefined) filter.operatorId = Number(operatorId);
    if (lotId !== undefined) filter.lotId = Number(lotId);
    if (sessionId !== undefined) filter.sessionId = Number(sessionId);
    return sendData(res, 200, await approval.listAdjustments(filter));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    return sendData(res, 200, await approval.getAdjustment(id));
  } catch (e) { return next(e); }
});

/** POST /api/fee-adjustments —— 操作员发起免单/改价/打折/退款申请（不直接生效）。 */
router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { sessionId, type, amountCents, finalFeeCents, reason } = req.body || {};
    const adj = await approval.createRequest({
      operator: req.user, sessionId, type, amountCents, finalFeeCents, reason,
    });
    return sendData(res, 201, adj);
  } catch (e) { return next(e); }
});

/** POST /api/fee-adjustments/:id/approve —— 审批通过（同事务落地到停车账单 + 审计）。 */
router.post('/:id/approve', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { note } = req.body || {};
    const adj = await approval.approve({ approver: req.user, adjustmentId: id, note });
    return sendData(res, 200, adj);
  } catch (e) { return next(e); }
});

/** POST /api/fee-adjustments/:id/reject —— 审批驳回（不改变账单金额 + 审计）。 */
router.post('/:id/reject', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { note } = req.body || {};
    const adj = await approval.reject({ approver: req.user, adjustmentId: id, note });
    return sendData(res, 200, adj);
  } catch (e) { return next(e); }
});

module.exports = router;
