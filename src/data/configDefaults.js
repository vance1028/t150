'use strict';

/**
 * 监督规则默认配置（单一来源）。
 * - 既被 db/schema.sql 的 INSERT IGNORE 用于建库时灌默认值；
 * - 也被 src/db.js 的 resetAll 在测试间重置回默认，避免用例间相互污染。
 * 修改默认值时请同步 db/schema.sql 中的 INSERT IGNORE 段。
 */
const SUPERVISION_DEFAULTS = {
  limit_waiver_cents: '500',
  limit_discount_cents: '500',
  limit_refund_cents: '500',
  limit_price_change_cents: '500',
  frequent_waiver_count: '3',
  frequent_waiver_window_minutes: '120',
  frequent_waiver_max_amount_cents: '200',
  lot_waiver_rate_threshold: '0.3',
  shift_hours: '8,16,24',
  shift_change_window_minutes: '30',
  shift_price_change_count: '3',
};

module.exports = { SUPERVISION_DEFAULTS };
