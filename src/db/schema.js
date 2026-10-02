export const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  scopes          TEXT NOT NULL DEFAULT '["publish","read"]',
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER
);

CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  account_id    TEXT,
  display_name  TEXT,
  tokens        TEXT,
  scopes        TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  sandbox       INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (provider, account_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  api_key_id      TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  title           TEXT,
  description     TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  visibility      TEXT NOT NULL DEFAULT 'private',
  schedule_at     INTEGER,
  payload         TEXT NOT NULL DEFAULT '{}',
  asset_id        TEXT,
  video_path      TEXT,
  video_mime      TEXT,
  video_size      INTEGER,
  duration_ms     INTEGER,
  width           INTEGER,
  height          INTEGER,
  source_name     TEXT,
  callback_url    TEXT,
  callback_state  TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at INTEGER,
  locked_at       INTEGER,
  locked_by       TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency
  ON jobs (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS job_targets (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  connection_id TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',
  params      TEXT NOT NULL DEFAULT '{}',
  variant     TEXT,
  external_id TEXT,
  external_url TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (job_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_targets_job ON job_targets (job_id);

CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider   TEXT,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  data       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_job ON job_events (job_id, id);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  job_id      TEXT,
  variant     TEXT NOT NULL DEFAULT 'source',
  path        TEXT,
  storage_key TEXT,
  mime        TEXT,
  size        INTEGER,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state        TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  verifier     TEXT,
  redirect_uri TEXT,
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
