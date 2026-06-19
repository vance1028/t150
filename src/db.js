'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { SUPERVISION_DEFAULTS } = require('./data/configDefaults');

/**
 * MySQL 连接管理（mysql2/promise 连接池）。
 * 全程 utf8mb4，确保中文不乱码。
 */

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 13366,
  user: process.env.DB_USER || 'park',
  password: process.env.DB_PASSWORD || 'parkpass',
  database: process.env.DB_NAME || 'parking',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
};

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * 确保表结构存在（读取 db/schema.sql 执行）。
 * 用一个开启 multipleStatements 的临时连接执行，执行完关闭。
 * 额外做一次幂等迁移：给既有 users 表补 approver_level 列（旧库不会因 CREATE TABLE IF NOT EXISTS 自动加列）。
 */
async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({ ...DB_CONFIG, multipleStatements: true });
  try {
    await conn.query(sql);
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'approver_level'`,
    );
    if (!cols || !cols.length) {
      await conn.query('ALTER TABLE users ADD COLUMN approver_level TINYINT NOT NULL DEFAULT 0');
    }
  } finally {
    await conn.end();
  }
}

/** 清空所有业务数据（测试用）。审计链锚点一并重置为创世态。 */
async function resetAll() {
  const conn = await getPool().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'audit_chain', 'fee_adjustments',
      'parking_sessions', 'parking_spaces', 'vehicles', 'parking_lots', 'users',
    ]) {
      await conn.query(`TRUNCATE TABLE ${t}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    // 审计锚点复位为创世态，监督配置复位为默认值（保证用例间确定性）。
    await conn.query(
      `INSERT INTO audit_anchor (id, head_seq, head_hash)
       VALUES (1, 0, ?)
       ON DUPLICATE KEY UPDATE head_seq = 0, head_hash = VALUES(head_hash)`,
      [GENESIS_HASH],
    );
    await conn.query('DELETE FROM supervision_config');
    for (const [k, v] of Object.entries(SUPERVISION_DEFAULTS)) {
      await conn.query(
        'INSERT INTO supervision_config (config_key, config_value) VALUES (?, ?)',
        [k, v],
      );
    }
  } finally {
    conn.release();
  }
}

/** 等待数据库可连接（最多重试若干次），用于启动时等容器就绪。 */
async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const conn = await mysql.createConnection({ ...DB_CONFIG, database: undefined });
      await conn.end();
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('数据库连接超时');
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, ensureSchema, resetAll, waitForDb, close, DB_CONFIG, GENESIS_HASH };
