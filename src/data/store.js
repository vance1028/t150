'use strict';

const { getPool } = require('../db');
const { hashPassword } = require('../utils/password');

/**
 * 数据仓储层：所有 SQL 集中在这里，路由层只调用这些 async 方法。
 * 对外返回 camelCase 字段对象。
 */

/* ----------------------------- 映射 ----------------------------- */

/** 事务感知查询：传入 conn 则用连接（事务内），否则用连接池。 */
function q(conn, sql, params) {
  return (conn || getPool()).query(sql, params);
}
async function qone(conn, sql, params) {
  const [rows] = await q(conn, sql, params);
  return rows[0];
}

function mapUser(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, name: r.name, role: r.role,
    status: r.status, approverLevel: r.approver_level, createdAt: r.created_at,
  };
}
function mapUserWithHash(r) {
  if (!r) return null;
  return { ...mapUser(r), passwordHash: r.password_hash };
}
function mapLot(r) {
  if (!r) return null;
  return {
    id: r.id, code: r.code, name: r.name, district: r.district, address: r.address,
    totalSpaces: r.total_spaces, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapSpace(r) {
  if (!r) return null;
  return {
    id: r.id, lotId: r.lot_id, code: r.code, type: r.type, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapVehicle(r) {
  if (!r) return null;
  return {
    id: r.id, plateNo: r.plate_no, ownerName: r.owner_name, phone: r.phone,
    vehicleType: r.vehicle_type, isMember: !!r.is_member, createdAt: r.created_at,
  };
}
function mapSession(r) {
  if (!r) return null;
  return {
    id: r.id, lotId: r.lot_id, spaceId: r.space_id, plateNo: r.plate_no,
    enterTime: r.enter_time, exitTime: r.exit_time, feeCents: r.fee_cents,
    status: r.status, paid: !!r.paid, createdAt: r.created_at,
  };
}

/* ----------------------------- 用户 ----------------------------- */

async function getUserByUsername(username) {
  const [rows] = await getPool().query('SELECT * FROM users WHERE username = ?', [username]);
  return mapUserWithHash(rows[0]);
}
async function getUserById(id) {
  const [rows] = await getPool().query('SELECT * FROM users WHERE id = ?', [id]);
  return mapUser(rows[0]);
}
async function listUsers() {
  const [rows] = await getPool().query('SELECT * FROM users ORDER BY id');
  return rows.map(mapUser);
}
async function createUser({ username, password, name, role = 'VIEWER', status = 'ACTIVE', approverLevel = 0 }) {
  const [r] = await getPool().query(
    'INSERT INTO users (username, password_hash, name, role, status, approver_level) VALUES (?, ?, ?, ?, ?, ?)',
    [username, hashPassword(password), name, role, status, Number(approverLevel) || 0],
  );
  return getUserById(r.insertId);
}
async function updateUser(id, fields) {
  const map = { name: 'name', role: 'role', status: 'status' };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] !== undefined) { sets.push(`${col} = ?`); params.push(fields[k]); }
  }
  if (fields.approverLevel !== undefined) { sets.push('approver_level = ?'); params.push(Number(fields.approverLevel) || 0); }
  if (fields.password !== undefined) { sets.push('password_hash = ?'); params.push(hashPassword(fields.password)); }
  if (sets.length) { params.push(id); await getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params); }
  return getUserById(id);
}
async function deleteUser(id) {
  const [r] = await getPool().query('DELETE FROM users WHERE id = ?', [id]);
  return r.affectedRows > 0;
}
async function countUsers() {
  const [rows] = await getPool().query('SELECT COUNT(*) AS n FROM users');
  return rows[0].n;
}

/* ----------------------------- 停车场 ----------------------------- */

async function listLots({ district, status, keyword } = {}) {
  const where = []; const params = [];
  if (district) { where.push('district = ?'); params.push(district); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (keyword) { where.push('(code LIKE ? OR name LIKE ? OR address LIKE ?)'); const k = `%${keyword}%`; params.push(k, k, k); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(`SELECT * FROM parking_lots ${clause} ORDER BY id DESC`, params);
  return rows.map(mapLot);
}
async function getLotById(id) {
  const [rows] = await getPool().query('SELECT * FROM parking_lots WHERE id = ?', [id]);
  return mapLot(rows[0]);
}
async function getLotByCode(code) {
  const [rows] = await getPool().query('SELECT * FROM parking_lots WHERE code = ?', [code]);
  return mapLot(rows[0]);
}
async function createLot(d) {
  const [r] = await getPool().query(
    `INSERT INTO parking_lots (code, name, district, address, total_spaces, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [d.code, d.name, d.district, d.address || '', d.totalSpaces || 0, d.status || 'OPEN'],
  );
  return getLotById(r.insertId);
}
async function updateLot(id, d) {
  const map = { name: 'name', district: 'district', address: 'address', totalSpaces: 'total_spaces', status: 'status' };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (sets.length) {
    sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    params.push(id);
    await getPool().query(`UPDATE parking_lots SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getLotById(id);
}
async function deleteLot(id) {
  const [r] = await getPool().query('DELETE FROM parking_lots WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

/* ----------------------------- 车位 ----------------------------- */

async function listSpaces({ lotId, status, type } = {}) {
  const where = []; const params = [];
  if (lotId !== undefined) { where.push('lot_id = ?'); params.push(lotId); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (type) { where.push('type = ?'); params.push(type); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(`SELECT * FROM parking_spaces ${clause} ORDER BY id`, params);
  return rows.map(mapSpace);
}
async function getSpaceById(id) {
  const [rows] = await getPool().query('SELECT * FROM parking_spaces WHERE id = ?', [id]);
  return mapSpace(rows[0]);
}
async function getSpaceByCode(lotId, code) {
  const [rows] = await getPool().query('SELECT * FROM parking_spaces WHERE lot_id = ? AND code = ?', [lotId, code]);
  return mapSpace(rows[0]);
}
async function createSpace(d) {
  const [r] = await getPool().query(
    'INSERT INTO parking_spaces (lot_id, code, type, status) VALUES (?, ?, ?, ?)',
    [d.lotId, d.code, d.type || 'STANDARD', d.status || 'FREE'],
  );
  return getSpaceById(r.insertId);
}
async function updateSpace(id, d) {
  const map = { type: 'type', status: 'status' };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (sets.length) {
    sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    params.push(id);
    await getPool().query(`UPDATE parking_spaces SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getSpaceById(id);
}
async function deleteSpace(id) {
  const [r] = await getPool().query('DELETE FROM parking_spaces WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

/* ----------------------------- 车辆 ----------------------------- */

async function listVehicles({ keyword, isMember } = {}) {
  const where = []; const params = [];
  if (keyword) { where.push('(plate_no LIKE ? OR owner_name LIKE ?)'); const k = `%${keyword}%`; params.push(k, k); }
  if (isMember !== undefined) { where.push('is_member = ?'); params.push(isMember ? 1 : 0); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(`SELECT * FROM vehicles ${clause} ORDER BY id DESC`, params);
  return rows.map(mapVehicle);
}
async function getVehicleById(id) {
  const [rows] = await getPool().query('SELECT * FROM vehicles WHERE id = ?', [id]);
  return mapVehicle(rows[0]);
}
async function getVehicleByPlate(plateNo) {
  const [rows] = await getPool().query('SELECT * FROM vehicles WHERE plate_no = ?', [plateNo]);
  return mapVehicle(rows[0]);
}
async function createVehicle(d) {
  const [r] = await getPool().query(
    'INSERT INTO vehicles (plate_no, owner_name, phone, vehicle_type, is_member) VALUES (?, ?, ?, ?, ?)',
    [d.plateNo, d.ownerName || '', d.phone || '', d.vehicleType || 'SMALL', d.isMember ? 1 : 0],
  );
  return getVehicleById(r.insertId);
}
async function updateVehicle(id, d) {
  const map = { ownerName: 'owner_name', phone: 'phone', vehicleType: 'vehicle_type' };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (d.isMember !== undefined) { sets.push('is_member = ?'); params.push(d.isMember ? 1 : 0); }
  if (sets.length) { params.push(id); await getPool().query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`, params); }
  return getVehicleById(id);
}
async function deleteVehicle(id) {
  const [r] = await getPool().query('DELETE FROM vehicles WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

/* ----------------------------- 停车记录 ----------------------------- */

async function listSessions({ lotId, plateNo, status } = {}) {
  const where = []; const params = [];
  if (lotId !== undefined) { where.push('lot_id = ?'); params.push(lotId); }
  if (plateNo) { where.push('plate_no = ?'); params.push(plateNo); }
  if (status) { where.push('status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(`SELECT * FROM parking_sessions ${clause} ORDER BY id DESC`, params);
  return rows.map(mapSession);
}
async function getSessionById(id) {
  const [rows] = await getPool().query('SELECT * FROM parking_sessions WHERE id = ?', [id]);
  return mapSession(rows[0]);
}
async function createSession(d) {
  const [r] = await getPool().query(
    `INSERT INTO parking_sessions (lot_id, space_id, plate_no, enter_time, status)
     VALUES (?, ?, ?, ?, ?)`,
    [d.lotId, d.spaceId ?? null, d.plateNo, d.enterTime, d.status || 'PARKED'],
  );
  return getSessionById(r.insertId);
}
async function updateSession(id, d) {
  const map = { spaceId: 'space_id', exitTime: 'exit_time', feeCents: 'fee_cents', status: 'status' };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (d.paid !== undefined) { sets.push('paid = ?'); params.push(d.paid ? 1 : 0); }
  if (sets.length) { params.push(id); await getPool().query(`UPDATE parking_sessions SET ${sets.join(', ')} WHERE id = ?`, params); }
  return getSessionById(id);
}

/* 行锁读取停车记录（事务内），用于审批落地时锁定账单。 */
async function getSessionForUpdate(conn, id) {
  const [rows] = await q(conn, 'SELECT * FROM parking_sessions WHERE id = ? FOR UPDATE', [id]);
  return mapSession(rows[0]);
}
/* 事务内直接改写应收金额（敏感操作生效的唯一落库点）。 */
async function setSessionFeeCents(conn, id, feeCents) {
  await q(conn, 'UPDATE parking_sessions SET fee_cents = ? WHERE id = ?', [feeCents, id]);
}

/* ----------------------------- 收费敏感操作审批单 ----------------------------- */

function mapAdjustment(r) {
  if (!r) return null;
  return {
    id: r.id, sessionId: r.session_id, lotId: r.lot_id, operatorId: r.operator_id,
    type: r.type, amountCents: r.amount_cents, finalFeeCents: r.final_fee_cents,
    reason: r.reason, tier: r.tier, status: r.status, approverId: r.approver_id,
    approvedAt: r.approved_at, decisionNote: r.decision_note,
    beforeFeeCents: r.before_fee_cents, afterFeeCents: r.after_fee_cents,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function getAdjustmentById(id, conn = null) {
  const row = await qone(conn, 'SELECT * FROM fee_adjustments WHERE id = ?', [id]);
  return mapAdjustment(row);
}
/** 行锁读取审批单（事务内），用于审批时锁定避免并发重复审批。 */
async function getAdjustmentForUpdate(conn, id) {
  const row = await qone(conn, 'SELECT * FROM fee_adjustments WHERE id = ? FOR UPDATE', [id]);
  return mapAdjustment(row);
}
async function createAdjustment(d, conn = null) {
  const [r] = await q(
    conn,
    `INSERT INTO fee_adjustments
       (session_id, lot_id, operator_id, type, amount_cents, final_fee_cents, reason, tier, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [d.sessionId, d.lotId, d.operatorId, d.type, d.amountCents, d.finalFeeCents ?? null, d.reason, d.tier],
  );
  return getAdjustmentById(r.insertId, conn);
}
async function listAdjustments({ status, type, operatorId, lotId, sessionId } = {}) {
  const where = []; const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (operatorId !== undefined) { where.push('operator_id = ?'); params.push(operatorId); }
  if (lotId !== undefined) { where.push('lot_id = ?'); params.push(lotId); }
  if (sessionId !== undefined) { where.push('session_id = ?'); params.push(sessionId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM fee_adjustments ${clause} ORDER BY id DESC`,
    params,
  );
  return rows.map(mapAdjustment);
}
async function decideAdjustment(id, fields, conn = null) {
  const sets = [
    'status = ?', 'approver_id = ?', 'decision_note = ?',
    'before_fee_cents = ?', 'after_fee_cents = ?', 'updated_at = CURRENT_TIMESTAMP(3)',
  ];
  const params = [
    fields.status, fields.approverId, fields.decisionNote ?? null,
    fields.beforeFeeCents ?? null, fields.afterFeeCents ?? null,
  ];
  if (fields.approvedAt !== undefined) { sets.splice(2, 0, 'approved_at = ?'); params.splice(2, 0, fields.approvedAt); }
  params.push(id);
  await q(conn, `UPDATE fee_adjustments SET ${sets.join(', ')} WHERE id = ?`, params);
  return getAdjustmentById(id, conn);
}

/* ----------------------------- 防篡改审计链 ----------------------------- */

function mapAudit(r) {
  if (!r) return null;
  return {
    seq: r.seq, recordId: r.record_id, actorId: r.actor_id, eventType: r.event_type,
    payload: r.payload, prevHash: r.prev_hash, hash: r.hash, createdAt: r.created_at,
  };
}
/** 行锁读取审计锚点（事务内），返回 { headSeq, headHash }。 */
async function getAuditAnchorForUpdate(conn) {
  const row = await qone(conn, 'SELECT head_seq, head_hash FROM audit_anchor WHERE id = 1 FOR UPDATE', []);
  return row ? { headSeq: row.head_seq, headHash: row.head_hash } : null;
}
/** 非锁读取审计锚点（校验用）。 */
async function getAuditAnchor() {
  const row = await qone(null, 'SELECT head_seq, head_hash FROM audit_anchor WHERE id = 1', []);
  return row ? { headSeq: row.head_seq, headHash: row.head_hash } : { headSeq: 0, headHash: null };
}
/** 插入审计记录（hash 先占位），返回自增 seq。payload 为规范化 JSON 字符串。 */
async function insertAuditRow(conn, { recordId, actorId, eventType, payload, prevHash }) {
  const [r] = await q(
    conn,
    `INSERT INTO audit_chain (record_id, actor_id, event_type, payload, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [recordId, actorId ?? null, eventType, payload, prevHash, ''],
  );
  return r.insertId;
}
/** 回填审计记录自身指纹。 */
async function setAuditHash(conn, seq, hash) {
  await q(conn, 'UPDATE audit_chain SET hash = ? WHERE seq = ?', [hash, seq]);
}
/** 推进审计锚点到最新一条。 */
async function setAuditAnchor(conn, seq, hash) {
  await q(conn, 'UPDATE audit_anchor SET head_seq = ?, head_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1', [seq, hash]);
}
async function listAuditChain({ limit = 200, offset = 0 } = {}) {
  const [rows] = await getPool().query(
    'SELECT * FROM audit_chain ORDER BY seq ASC LIMIT ? OFFSET ?',
    [Number(limit) || 200, Number(offset) || 0],
  );
  return rows.map(mapAudit);
}
async function countAudit() {
  const row = await qone(null, 'SELECT COUNT(*) AS n FROM audit_chain', []);
  return row ? row.n : 0;
}
async function getAuditBySeq(seq) {
  const row = await qone(null, 'SELECT * FROM audit_chain WHERE seq = ?', [seq]);
  return mapAudit(row);
}

/* ----------------------------- 监督规则配置 ----------------------------- */

const { SUPERVISION_DEFAULTS } = require('./configDefaults');

async function listConfig() {
  const [rows] = await getPool().query('SELECT config_key, config_value FROM supervision_config ORDER BY config_key');
  const map = {};
  for (const r of rows) map[r.config_key] = r.config_value;
  return map;
}
/** 取配置，缺失键回退到默认值。 */
async function getConfigValue(key) {
  const row = await qone(null, 'SELECT config_value FROM supervision_config WHERE config_key = ?', [key]);
  if (row) return row.config_value;
  return SUPERVISION_DEFAULTS[key] !== undefined ? SUPERVISION_DEFAULTS[key] : null;
}
async function setConfigValue(key, value) {
  await getPool().query(
    `INSERT INTO supervision_config (config_key, config_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP(3)`,
    [key, String(value)],
  );
  return getConfigValue(key);
}

/* ----------------------------- 监督统计查询 ----------------------------- */

/** 已生效敏感操作按类型聚合（支持操作员/停车场/时间区间过滤）。 */
async function aggregateApprovedAdjustments({ operatorId, lotId, from, to } = {}) {
  const where = ["status = 'APPROVED'"]; const params = [];
  if (operatorId !== undefined) { where.push('operator_id = ?'); params.push(operatorId); }
  if (lotId !== undefined) { where.push('lot_id = ?'); params.push(lotId); }
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  const [rows] = await getPool().query(
    `SELECT type,
            COUNT(*) AS cnt,
            COALESCE(SUM(amount_cents), 0) AS sum_amount,
            COALESCE(SUM(before_fee_cents), 0) AS sum_before,
            COALESCE(SUM(after_fee_cents), 0) AS sum_after
     FROM fee_adjustments
     WHERE ${where.join(' AND ')}
     GROUP BY type`,
    params,
  );
  return rows.map((r) => ({
    type: r.type, count: r.cnt, sumAmount: Number(r.sum_amount),
    sumBefore: Number(r.sum_before), sumAfter: Number(r.sum_after),
    impact: Number(r.sum_before) - Number(r.sum_after),
  }));
}

/** 各停车场：免单账单数 / 已结费账单数（用于免单率告警）。 */
async function lotWaiverStats() {
  const [rows] = await getPool().query(
    `SELECT l.id AS lot_id, l.code AS lot_code, l.name AS lot_name,
            COALESCE(w.c, 0) AS waived_count,
            COALESCE(f.c, 0) AS finished_count
     FROM parking_lots l
     LEFT JOIN (
       SELECT lot_id, COUNT(DISTINCT session_id) AS c
       FROM fee_adjustments WHERE type = 'WAIVER' AND status = 'APPROVED'
       GROUP BY lot_id
     ) w ON w.lot_id = l.id
     LEFT JOIN (
       SELECT lot_id, COUNT(*) AS c
       FROM parking_sessions WHERE status = 'FINISHED'
       GROUP BY lot_id
     ) f ON f.lot_id = l.id`,
  );
  return rows.map((r) => ({
    lotId: r.lot_id, lotCode: r.lot_code, lotName: r.lot_name,
    waivedCount: Number(r.waived_count), finishedCount: Number(r.finished_count),
  }));
}

/** 各操作员：窗口内小额免单次数与累计金额（窗口以数据库时钟为准，避免时区错配）。 */
async function operatorSmallWaiverStats(maxAmount, windowMinutes) {
  const where = ["type = 'WAIVER'", "status = 'APPROVED'", 'amount_cents <= ?']; const params = [maxAmount];
  if (windowMinutes) { where.push('created_at >= (NOW() - INTERVAL ? MINUTE)'); params.push(windowMinutes); }
  const [rows] = await getPool().query(
    `SELECT operator_id, COUNT(*) AS cnt, COALESCE(SUM(amount_cents), 0) AS total
     FROM fee_adjustments WHERE ${where.join(' AND ')} GROUP BY operator_id`,
    params,
  );
  return rows.map((r) => ({ operatorId: r.operator_id, count: r.cnt, total: Number(r.total) }));
}

/** 全部已生效改价记录（用于临近交班集中改价告警）。 */
async function listApprovedPriceChanges() {
  const [rows] = await getPool().query(
    `SELECT id, operator_id, lot_id, created_at
     FROM fee_adjustments WHERE type = 'PRICE_CHANGE' AND status = 'APPROVED'
     ORDER BY created_at`,
  );
  return rows.map((r) => ({ id: r.id, operatorId: r.operator_id, lotId: r.lot_id, createdAt: r.created_at }));
}

module.exports = {
  q, qone,
  mapUser, mapLot, mapSpace, mapVehicle, mapSession,
  getUserByUsername, getUserById, listUsers, createUser, updateUser, deleteUser, countUsers,
  listLots, getLotById, getLotByCode, createLot, updateLot, deleteLot,
  listSpaces, getSpaceById, getSpaceByCode, createSpace, updateSpace, deleteSpace,
  listVehicles, getVehicleById, getVehicleByPlate, createVehicle, updateVehicle, deleteVehicle,
  listSessions, getSessionById, createSession, updateSession, getSessionForUpdate, setSessionFeeCents,
  getAdjustmentById, getAdjustmentForUpdate, createAdjustment, listAdjustments, decideAdjustment,
  getAuditAnchorForUpdate, getAuditAnchor, insertAuditRow, setAuditHash, setAuditAnchor, listAuditChain, countAudit, getAuditBySeq,
  listConfig, getConfigValue, setConfigValue,
  aggregateApprovedAdjustments, lotWaiverStats, operatorSmallWaiverStats, listApprovedPriceChanges,
};
