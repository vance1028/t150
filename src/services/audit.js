'use strict';

const crypto = require('crypto');
const { getPool, GENESIS_HASH } = require('../db');
const store = require('../data/store');

/**
 * 防篡改审计链 —— 独立核心块。
 *
 * 设计：
 * - 每条审计记录 = 内容指纹 hash + 前一条指纹 prev_hash，首条 prev_hash = 创世全零。
 *   hash = sha256(prev_hash | seq | recordId | actorId | eventType | canonical(payload))
 * - payload 以「键排序的规范 JSON 字符串」存入 LONGTEXT，保证写时与校验时字节一致。
 * - appendAudit 在事务内：锁锚点 → 追加（hash 占位）→ 回填 hash → 推进锚点。
 *   可传入外部 conn，与审批落地同事务，保证「敏感操作 + 审计」原子一致。
 * - verifyChain 从头到尾重算：序号连续、前指衔接、内容指纹一致，再与锚点比对尾部，
 *   任何被改 / 删 / 插都能定位到断点序号。
 * - 审计记录对外只读：本模块仅暴露 append（内部）与 list/verify，无 update/delete。
 */

/* ----------------------- 规范化与指纹 ----------------------- */

/** 稳定序列化：对象按键排序，数组保序，兼容嵌套。 */
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** 计算单条记录自身指纹。 */
function computeHash(prevHash, { seq, recordId, actorId, eventType, payload }) {
  const content = [seq, recordId, actorId, eventType, payload].join('|');
  return crypto.createHash('sha256').update(`${prevHash}|${content}`, 'utf8').digest('hex');
}

/* ----------------------- 追加 ----------------------- */

/**
 * 追加一条审计记录。
 * @param conn 可选：外部事务连接；不传则自开事务。
 * @param {object} event { recordId, actorId, eventType, payload }
 * @returns { seq, prevHash, hash, payload }
 */
async function appendAudit(conn, event) {
  const ownTx = !conn;
  let c = conn;
  if (ownTx) {
    c = await getPool().getConnection();
    await c.beginTransaction();
  }
  try {
    const anchor = await store.getAuditAnchorForUpdate(c);
    const prevHash = anchor && anchor.headHash ? anchor.headHash : GENESIS_HASH;
    const payloadStr = canonical(event.payload);
    const seq = await store.insertAuditRow(c, {
      recordId: event.recordId,
      actorId: event.actorId ?? null,
      eventType: event.eventType,
      payload: payloadStr,
      prevHash,
    });
    const hash = computeHash(prevHash, {
      seq,
      recordId: event.recordId,
      actorId: event.actorId ?? null,
      eventType: event.eventType,
      payload: payloadStr,
    });
    await store.setAuditHash(c, seq, hash);
    await store.setAuditAnchor(c, seq, hash);
    if (ownTx) await c.commit();
    return { seq, prevHash, hash, payload: payloadStr };
  } catch (e) {
    if (ownTx) {
      try { await c.rollback(); } catch (_) { /* ignore */ }
    }
    throw e;
  } finally {
    if (ownTx) c.release();
  }
}

/* ----------------------- 校验 ----------------------- */

/**
 * 从头到尾校验审计链完整性。
 * @returns 链完整：{ valid:true, count, headSeq, headHash }
 *          断链：{ valid:false, brokenAt, reason, detail, checked, headSeq, headHash }
 *          reason ∈ SEQ_GAP | PREV_HASH_MISMATCH | HASH_MISMATCH | TAIL_MISMATCH | ANCHOR_ORPHAN
 */
async function verifyChain() {
  const rows = await store.listAuditChain({ limit: 1000000, offset: 0 });
  const anchor = await store.getAuditAnchor();
  const headSeq = anchor.headSeq;
  const headHash = anchor.headHash || GENESIS_HASH;
  const ctx = { checked: rows.length, headSeq, headHash };

  if (!rows.length) {
    if (headSeq !== 0 || headHash !== GENESIS_HASH) {
      return { valid: false, brokenAt: 0, reason: 'ANCHOR_ORPHAN', detail: '审计链为空但锚点非创世态，疑似删空链', ...ctx };
    }
    return { valid: true, count: 0, headSeq, headHash };
  }

  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectedSeq) {
      return { valid: false, brokenAt: r.seq, reason: 'SEQ_GAP', detail: `期望序号 ${expectedSeq}，实际 ${r.seq}，疑似删除或缺序`, ...ctx };
    }
    if (r.prevHash !== expectedPrev) {
      return { valid: false, brokenAt: r.seq, reason: 'PREV_HASH_MISMATCH', detail: `第 ${r.seq} 条前指指纹与上一条不衔接，疑似删除/插入/重排`, ...ctx };
    }
    const recomputed = computeHash(r.prevHash, {
      seq: r.seq, recordId: r.recordId, actorId: r.actorId,
      eventType: r.eventType, payload: r.payload,
    });
    if (recomputed !== r.hash) {
      return { valid: false, brokenAt: r.seq, reason: 'HASH_MISMATCH', detail: `第 ${r.seq} 条内容指纹不匹配，疑似篡改记录内容`, ...ctx };
    }
    expectedPrev = r.hash;
    expectedSeq = r.seq + 1;
  }

  const last = rows[rows.length - 1];
  if (last.seq !== headSeq || last.hash !== headHash) {
    return { valid: false, brokenAt: last.seq, reason: 'TAIL_MISMATCH', detail: `链尾(序号${last.seq})与锚点(序号${headSeq})不一致，疑似删除尾部或篡改锚点`, ...ctx };
  }
  return { valid: true, count: rows.length, headSeq, headHash };
}

module.exports = { canonical, computeHash, appendAudit, verifyChain, GENESIS_HASH };
