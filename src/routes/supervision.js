'use strict';

const express = require('express');
const supervision = require('../services/supervision');
const { authRequired, requireRole } = require('../auth');
const { sendData } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

/** GET /api/supervision/stats —— 操作员/停车场/时间区间的敏感操作统计。 */
router.get('/stats', async (req, res, next) => {
  try {
    const { operatorId, lotId, from, to } = req.query;
    const filter = { from: from || null, to: to || null };
    if (operatorId !== undefined) filter.operatorId = Number(operatorId);
    if (lotId !== undefined) filter.lotId = Number(lotId);
    return sendData(res, 200, await supervision.getStats(filter));
  } catch (e) { return next(e); }
});

/** GET /api/supervision/alerts —— 用可配规则扫描可疑行为并告警。 */
router.get('/alerts', async (req, res, next) => {
  try {
    return sendData(res, 200, await supervision.scanAlerts());
  } catch (e) { return next(e); }
});

/** GET /api/supervision/config —— 读取额度上限与规则阈值。 */
router.get('/config', async (req, res, next) => {
  try {
    return sendData(res, 200, await supervision.getConfig());
  } catch (e) { return next(e); }
});

/** PUT /api/supervision/config —— 修改额度上限与规则阈值（仅 ADMIN）。 */
router.put('/config', requireRole('ADMIN'), async (req, res, next) => {
  try {
    return sendData(res, 200, await supervision.updateConfig(req.body || {}));
  } catch (e) { return next(e); }
});

module.exports = router;
