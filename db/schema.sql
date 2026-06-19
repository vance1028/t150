-- 城市智慧停车运营管理平台 表结构（全程 utf8mb4，确保中文正常）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(64) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'VIEWER',
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parking_lots (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  district      VARCHAR(64) NOT NULL,
  address       VARCHAR(255) NOT NULL DEFAULT '',
  total_spaces  INT NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parking_spaces (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  lot_id      INT UNSIGNED NOT NULL,
  code        VARCHAR(32) NOT NULL,
  type        VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
  status      VARCHAR(16) NOT NULL DEFAULT 'FREE',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_lot_space (lot_id, code),
  CONSTRAINT fk_space_lot FOREIGN KEY (lot_id) REFERENCES parking_lots(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vehicles (
  id           INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plate_no     VARCHAR(16) NOT NULL UNIQUE,
  owner_name   VARCHAR(64) NOT NULL DEFAULT '',
  phone        VARCHAR(32) NOT NULL DEFAULT '',
  vehicle_type VARCHAR(16) NOT NULL DEFAULT 'SMALL',
  is_member    TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parking_sessions (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  lot_id      INT UNSIGNED NOT NULL,
  space_id    INT UNSIGNED NULL,
  plate_no    VARCHAR(16) NOT NULL,
  enter_time  DATETIME(3) NOT NULL,
  exit_time   DATETIME(3) NULL,
  fee_cents   INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'PARKED',
  paid        TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_session_lot FOREIGN KEY (lot_id) REFERENCES parking_lots(id) ON DELETE CASCADE,
  CONSTRAINT fk_session_space FOREIGN KEY (space_id) REFERENCES parking_spaces(id) ON DELETE SET NULL,
  INDEX idx_session_status (status),
  INDEX idx_session_plate (plate_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================== 收费敏感操作：审批单 =====================
-- 免单 / 手工改价 / 打折 / 退款 均走申请-审批，不允许操作员直接生效。
CREATE TABLE IF NOT EXISTS fee_adjustments (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  session_id      INT UNSIGNED NOT NULL,
  lot_id          INT UNSIGNED NOT NULL,
  operator_id     INT UNSIGNED NOT NULL,
  type            VARCHAR(16) NOT NULL,
  amount_cents    INT NOT NULL DEFAULT 0,
  final_fee_cents INT NULL,
  reason          VARCHAR(500) NOT NULL,
  tier            TINYINT NOT NULL DEFAULT 1,
  status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  approver_id     INT UNSIGNED NULL,
  approved_at     DATETIME(3) NULL,
  decision_note   VARCHAR(500) NULL,
  before_fee_cents INT NULL,
  after_fee_cents  INT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_adj_session FOREIGN KEY (session_id) REFERENCES parking_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_adj_lot FOREIGN KEY (lot_id) REFERENCES parking_lots(id) ON DELETE CASCADE,
  CONSTRAINT fk_adj_operator FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_adj_approver FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_adj_status (status),
  INDEX idx_adj_operator (operator_id),
  INDEX idx_adj_lot (lot_id),
  INDEX idx_adj_type (type),
  INDEX idx_adj_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================== 防篡改审计链 =====================
-- 每条记录携带 prev_hash（前一条指纹）与 hash（自身内容指纹），环环相扣。
-- 审计记录对外只读：应用层不提供任何 update/delete 接口，仅 append + 校验。
-- 故意不设外键：审计链必须独立于业务表存亡，业务行删除审计仍留存。
CREATE TABLE IF NOT EXISTS audit_chain (
  seq         INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  record_id   INT UNSIGNED NOT NULL,
  actor_id    INT UNSIGNED NULL,
  event_type  VARCHAR(32) NOT NULL,
  payload     LONGTEXT NOT NULL,
  prev_hash   CHAR(64) NOT NULL,
  hash        CHAR(64) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_record (record_id),
  INDEX idx_audit_actor (actor_id),
  INDEX idx_audit_event (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 审计链锚点：记录最新一条的序号与指纹，用于校验尾部是否被删除/篡改。
CREATE TABLE IF NOT EXISTS audit_anchor (
  id          TINYINT UNSIGNED PRIMARY KEY,
  head_seq    INT UNSIGNED NOT NULL DEFAULT 0,
  head_hash   CHAR(64) NOT NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================== 监督规则配置 =====================
-- 免单/折扣额度上限（超限升级审批）+ 可疑行为规则阈值，均可配。
CREATE TABLE IF NOT EXISTS supervision_config (
  config_key   VARCHAR(64) PRIMARY KEY,
  config_value VARCHAR(255) NOT NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 审计链创世锚点（id=1，序号 0，全零指纹）。
INSERT IGNORE INTO audit_anchor (id, head_seq, head_hash) VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000');

-- 监督默认配置（INSERT IGNORE 保证幂等，可被 PUT /api/supervision/config 覆盖）。
INSERT IGNORE INTO supervision_config (config_key, config_value) VALUES
  ('limit_waiver_cents', '500'),
  ('limit_discount_cents', '500'),
  ('limit_refund_cents', '500'),
  ('limit_price_change_cents', '500'),
  ('frequent_waiver_count', '3'),
  ('frequent_waiver_window_minutes', '120'),
  ('frequent_waiver_max_amount_cents', '200'),
  ('lot_waiver_rate_threshold', '0.3'),
  ('shift_hours', '8,16,24'),
  ('shift_change_window_minutes', '30'),
  ('shift_price_change_count', '3');
