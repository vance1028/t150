'use strict';

const express = require('express');
const store = require('../data/store');
const audit = require('../services/audit');
const { authRequired } = require('../auth');
const { sendData } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

/**
 * 审计链对外只读：本路由仅暴露 GET（列表、校验）。
 * 不提供任何 POST/PUT/DELETE，确保审计记录不可经接口改写或删除。
 */

/** GET /api/audit —— 审计链列表（limit/offset 分页，按 seq 升序）。 */
router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 200;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
    const rows = await store.listAuditChain({ limit, offset });
    const total = await store.countAudit();
    return sendData(res, 200, rows, { total });
  } catch (e) { return next(e); }
});

/** GET /api/audit/verify —— 从头到尾校验审计链完整性，定位断点。 */
router.get('/verify', async (req, res, next) => {
  try {
    const report = await audit.verifyChain();
    return sendData(res, 200, report);
  } catch (e) { return next(e); }
});

module.exports = router;
