-- 关系助手 Agent 存储结构
--
-- 这份 DDL 是 SQLite 和 PostgreSQL 共用的（只用到两者都支持的语法）。
-- SQLite 特有的 PRAGMA 在 sqlite-db.ts 里单独设置。
--
-- 设计原则：
--   1. 两张表承担并发语义：memory_doc（generation CAS）、idempotency（request_id 唯一）；
--   2. 复杂结构（payload / messages / source_ids）用 JSON 文本列，不拆表 —— 它们只整体读写，
--      拆开只增加连接成本，换不来查询能力；
--   3. 外键全部打开，孤儿记录在插入时就被挡住。


CREATE TABLE IF NOT EXISTS person (
  person_id         TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  relation          TEXT NOT NULL,
  tags              TEXT NOT NULL,            -- JSON string[]
  relationship_goal TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id  TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES person(person_id),
  kind         TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  content_hash TEXT,
  expires_at   TEXT,
  summary      TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_person ON evidence(person_id);
-- 同一份材料只存一次：去重由数据库保证，不靠应用层先查后插
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_hash
  ON evidence(person_id, content_hash) WHERE content_hash IS NOT NULL;

-- 记忆文档头：generation 是乐观锁版本，version 是对外展示版本
CREATE TABLE IF NOT EXISTS memory_doc (
  person_id  TEXT PRIMARY KEY REFERENCES person(person_id),
  generation INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_item (
  memory_id    TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES person(person_id),
  text         TEXT NOT NULL,
  source_ids   TEXT NOT NULL,                 -- JSON string[]
  confirmed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_item_person ON memory_item(person_id);

CREATE TABLE IF NOT EXISTS candidate (
  candidate_id     TEXT PRIMARY KEY,
  person_id        TEXT NOT NULL REFERENCES person(person_id),
  text             TEXT NOT NULL,
  source_ids       TEXT NOT NULL,
  status           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  session_id       TEXT,
  origin           TEXT NOT NULL,
  insight_decision TEXT,
  insight_reason   TEXT,
  reviewed_at      TEXT,
  reject_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidate_person ON candidate(person_id, status);

CREATE TABLE IF NOT EXISTS action (
  request_id   TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES person(person_id),
  session_id   TEXT,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL,                 -- JSON
  reason       TEXT NOT NULL,
  source_ids   TEXT NOT NULL,                 -- JSON string[]
  card_version INTEGER NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  confirmed_at TEXT,
  submitted_at TEXT,
  attempts     INTEGER,
  receipt      TEXT                           -- JSON
);
CREATE INDEX IF NOT EXISTS idx_action_person ON action(person_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_status ON action(status);

-- 幂等表：request_id 主键就是"只能提交一次"的物理保证
CREATE TABLE IF NOT EXISTS idempotency (
  request_id   TEXT PRIMARY KEY,
  card_version INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  receipt      TEXT NOT NULL                  -- JSON
);

CREATE TABLE IF NOT EXISTS session (
  session_id   TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES person(person_id),
  request_id   TEXT UNIQUE,                   -- 请求级幂等：同一个 requestID 只能对应一个会话
  page_context TEXT,                          -- JSON
  messages     TEXT NOT NULL DEFAULT '[]',    -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey (
  survey_id   TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(session_id),
  tool_call_id TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  questions   TEXT NOT NULL,                  -- JSON
  answers     TEXT,                           -- JSON，NULL = 未回答
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_survey_session ON survey(session_id);

CREATE TABLE IF NOT EXISTS conflict (
  conflict_id TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES person(person_id),
  description TEXT NOT NULL,
  source_ids  TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS compaction (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  dropped    INTEGER NOT NULL,
  kept       INTEGER NOT NULL,
  summary    TEXT,
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_log (
  log_id      TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  session_id  TEXT,
  person_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  evidence_id TEXT,
  query       TEXT,
  actor       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_session ON access_log(session_id);

CREATE TABLE IF NOT EXISTS handoff (
  handoff_id  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_handoff_status ON handoff(status);