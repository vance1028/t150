'use strict';

const store = require('../data/store');
const { SUPERVISION_DEFAULTS } = require('../data/configDefaults');
const { httpError } = require('../utils/http');

/**
 * 监督分析 —— 独立核心块。
 *
 * - getStats：按操作员 / 停车场 / 时间区间统计免单、打折、退款、改价的笔数与影响金额。
 * - scanAlerts：用可配规则扫可疑行为——
 *     1) 同一操作员窗口内频繁小额免单；
 *     2) 某停车场免单率异常偏高；
 *     3) 临近交班集中改价。
 * - getConfig / updateConfig：读取与修改额度上限及规则阈值（超限自动升级审批级别）。
 */

const CONFIG_KEYS = Object.keys(SUPERVISION_DEFAULTS);

async function userMap() {
  const users = await store.listUsers();
  const m = {};
  for (const u of users) m[u.id] = u;
  return m;
}

/** 取配置并解析为强类型对象。 */
async function configObject() {
  const map = await store.listConfig();
  const num = (k) => Number(map[k]) || 0;
  return {
    waiver: num('limit_waiver_cents'),
    discount: num('limit_discount_cents'),
    refund: num('limit_refund_cents'),
    priceChange: num('limit_price_change_cents'),
    frequentWaiverCount: num('frequent_waiver_count'),
    frequentWaiverWindowMinutes: num('frequent_waiver_window_minutes'),
    frequentWaiverMaxAmountCents: num('frequent_waiver_max_amount_cents'),
    lotWaiverRateThreshold: Number(map['lot_waiver_rate_threshold']) || 0,
    shiftHours: map['shift_hours'] || SUPERVISION_DEFAULTS.shift_hours,
    shiftChangeWindowMinutes: num('shift_change_window_minutes'),
    shiftPriceChangeCount: num('shift_price_change_count'),
  };
}

/** 判断某时刻是否落在「交班前 windowMin 分钟」窗口内（班次按小时界定）。 */
function isNearShift(date, shiftMinutes, windowMin) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const tod = d.getHours() * 60 + d.getMinutes();
  for (const b of shiftMinutes) {
    const diff = b - tod;
    if (diff >= 0 && diff <= windowMin) return true;
  }
  return false;
}

/* ----------------------------- 统计 ----------------------------- */

async function getStats({ operatorId, lotId, from, to } = {}) {
  const rows = await store.aggregateApprovedAdjustments({ operatorId, lotId, from, to });
  const byType = {};
  let count = 0;
  let impact = 0;
  for (const r of rows) {
    byType[r.type] = { count: r.count, sumAmountCents: r.sumAmount, impactCents: r.impact };
    count += r.count;
    impact += r.impact;
  }
  const result = {
    byType,
    total: { count, impactCents: impact },
    range: { from: from || null, to: to || null },
  };
  if (operatorId !== undefined) {
    const u = await store.getUserById(operatorId);
    result.operator = u ? { id: u.id, name: u.name, username: u.username } : null;
  }
  if (lotId !== undefined) {
    const l = await store.getLotById(lotId);
    result.lot = l ? { id: l.id, code: l.code, name: l.name } : null;
  }
  return result;
}

/* ----------------------------- 可疑行为扫描 ----------------------------- */

async function scanAlerts() {
  const cfg = await configObject();
  const alerts = [];
  const users = await userMap();

  // 1) 同一操作员窗口内频繁小额免单（窗口以数据库时钟为准）
  const small = await store.operatorSmallWaiverStats(
    cfg.frequentWaiverMaxAmountCents,
    cfg.frequentWaiverWindowMinutes,
  );
  for (const s of small) {
    if (s.count >= cfg.frequentWaiverCount) {
      alerts.push({
        rule: 'FREQUENT_SMALL_WAIVER', severity: 'WARN',
        operatorId: s.operatorId,
        operatorName: users[s.operatorId] ? users[s.operatorId].name : null,
        count: s.count, totalCents: s.total,
        threshold: cfg.frequentWaiverCount,
        windowMinutes: cfg.frequentWaiverWindowMinutes,
        maxAmountCents: cfg.frequentWaiverMaxAmountCents,
        detail: `操作员在 ${cfg.frequentWaiverWindowMinutes} 分钟内小额(≤${cfg.frequentWaiverMaxAmountCents}分)免单 ${s.count} 次`,
      });
    }
  }

  // 2) 某停车场免单率异常偏高
  const lots = await store.lotWaiverStats();
  for (const l of lots) {
    if (l.finishedCount > 0) {
      const rate = l.waivedCount / l.finishedCount;
      if (rate > cfg.lotWaiverRateThreshold) {
        alerts.push({
          rule: 'LOT_HIGH_WAIVER_RATE', severity: 'WARN',
          lotId: l.lotId, lotCode: l.lotCode, lotName: l.lotName,
          waivedCount: l.waivedCount, finishedCount: l.finishedCount,
          rate: Number(rate.toFixed(4)), threshold: cfg.lotWaiverRateThreshold,
          detail: `停车场免单率 ${(rate * 100).toFixed(1)}% 超过阈值 ${(cfg.lotWaiverRateThreshold * 100).toFixed(1)}%`,
        });
      }
    }
  }

  // 3) 临近交班集中改价
  const shiftMinutes = String(cfg.shiftHours)
    .split(',')
    .map((s) => Number(s.trim()) * 60)
    .filter((n) => !Number.isNaN(n));
  const priceChanges = await store.listApprovedPriceChanges();
  const byOp = {};
  for (const pc of priceChanges) {
    if (isNearShift(pc.createdAt, shiftMinutes, cfg.shiftChangeWindowMinutes)) {
      if (!byOp[pc.operatorId]) byOp[pc.operatorId] = { count: 0, items: [] };
      byOp[pc.operatorId].count += 1;
      byOp[pc.operatorId].items.push({ id: pc.id, lotId: pc.lotId, createdAt: pc.createdAt });
    }
  }
  for (const [opId, info] of Object.entries(byOp)) {
    if (info.count >= cfg.shiftPriceChangeCount) {
      alerts.push({
        rule: 'SHIFT_PRICE_CHANGE_BURST', severity: 'WARN',
        operatorId: Number(opId),
        operatorName: users[opId] ? users[opId].name : null,
        count: info.count, threshold: cfg.shiftPriceChangeCount,
        windowMinutes: cfg.shiftChangeWindowMinutes,
        detail: `操作员临近交班(前${cfg.shiftChangeWindowMinutes}分钟)集中改价 ${info.count} 次`,
        items: info.items,
      });
    }
  }

  return { alerts, checkedAt: new Date().toISOString(), configSnapshot: cfg };
}

/* ----------------------------- 配置 ----------------------------- */

async function getConfig() {
  return store.listConfig();
}

async function updateConfig(entries) {
  if (!entries || typeof entries !== 'object') throw httpError(400, '配置体需为对象');
  const applied = {};
  for (const [k, v] of Object.entries(entries)) {
    if (!CONFIG_KEYS.includes(k)) throw httpError(400, `未知的配置项: ${k}`);
    applied[k] = await store.setConfigValue(k, v);
  }
  return { applied, config: await store.listConfig() };
}

module.exports = {
  getStats, scanAlerts, getConfig, updateConfig, configObject, isNearShift, CONFIG_KEYS,
};
