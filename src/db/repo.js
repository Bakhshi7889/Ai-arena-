import { SCHEMA } from './schema.js';
import { newId } from '../lib/crypto.js';

const now = () => Date.now();

function json(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createRepo(db) {
  db.exec(SCHEMA);

  const apiKeys = {
    create({ id = newId('key'), name, keyHash, keyPrefix, scopes = ['publish', 'read'], allowedOrigins = [] }) {
      db.prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, allowed_origins, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, keyHash, keyPrefix, JSON.stringify(scopes), JSON.stringify(allowedOrigins), now());
      return apiKeys.get(id);
    },
    get(id) {
      return mapKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
    },
    findByHash(keyHash) {
      return mapKey(db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash));
    },
    list() {
      return db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all().map(mapKey);
    },
    touch(id) {
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
    },
    revoke(id) {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), id);
    },
  };

  const connections = {
    upsert(conn) {
      const existing = db
        .prepare('SELECT id FROM connections WHERE provider = ? AND account_id = ?')
        .get(conn.provider, conn.accountId ?? null);
      const id = existing?.id ?? conn.id ?? newId('conn');
      const ts = now();
      if (existing) {
        db.prepare(
          `UPDATE connections SET display_name = ?, tokens = ?, scopes = ?, status = ?, sandbox = ?, meta = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          conn.displayName ?? null,
          conn.tokens ?? null,
          JSON.stringify(conn.scopes ?? []),
          conn.status ?? 'active',
          conn.sandbox ? 1 : 0,
          JSON.stringify(conn.meta ?? {}),
          ts,
          id,
        );
      } else {
        db.prepare(
          `INSERT INTO connections (id, provider, account_id, display_name, tokens, scopes, status, sandbox, meta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          conn.provider,
          conn.accountId ?? null,
          conn.displayName ?? null,
          conn.tokens ?? null,
          JSON.stringify(conn.scopes ?? []),
          conn.status ?? 'active',
          conn.sandbox ? 1 : 0,
          JSON.stringify(conn.meta ?? {}),
          ts,
          ts,
        );
      }
      return connections.get(id);
    },
    get(id) {
      return mapConnection(db.prepare('SELECT * FROM connections WHERE id = ?').get(id));
    },
    findByProvider(provider) {
      return db
        .prepare("SELECT * FROM connections WHERE provider = ? AND status = 'active' ORDER BY created_at ASC")
        .all(provider)
        .map(mapConnection);
    },
    list() {
      return db.prepare('SELECT * FROM connections ORDER BY provider, created_at').all().map(mapConnection);
    },
    remove(id) {
      return db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS c FROM connections').get().c;
    },
  };

  const jobs = {
    create(job) {
      const id = job.id ?? newId('job');
      const ts = now();
      db.prepare(
        `INSERT INTO jobs (id, api_key_id, idempotency_key, status, title, description, tags, visibility,
                           schedule_at, payload, asset_id, video_path, video_mime, video_size, duration_ms,
                           width, height, source_name, callback_url, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        job.apiKeyId ?? null,
        job.idempotencyKey ?? null,
        job.status ?? 'queued',
        job.title ?? null,
        job.description ?? null,
        JSON.stringify(job.tags ?? []),
        job.visibility ?? 'private',
        job.scheduleAt ?? null,
        JSON.stringify(job.payload ?? {}),
        job.assetId ?? null,
        job.videoPath ?? null,
        job.videoMime ?? null,
        job.videoSize ?? null,
        job.durationMs ?? null,
        job.width ?? null,
        job.height ?? null,
        job.sourceName ?? null,
        job.callbackUrl ?? null,
        job.maxAttempts ?? 5,
        ts,
        ts,
      );
      return jobs.get(id);
    },
    get(id) {
      const job = mapJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
      if (!job) return null;
      job.targets = targets.byJob(id);
      return job;
    },
    getByIdempotencyKey(apiKeyId, key) {
      if (!key) return null;
      return mapJob(
        db.prepare('SELECT * FROM jobs WHERE api_key_id IS ? AND idempotency_key = ?').get(apiKeyId ?? null, key),
      );
    },
    list({ limit = 50, offset = 0, status, apiKeyId } = {}) {
      const clauses = [];
      const params = [];
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
      if (apiKeyId) {
        clauses.push('api_key_id = ?');
        params.push(apiKeyId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db
        .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
        .map(mapJob);
    },
    update(id, patch) {
      const allowed = {
        status: 'status',
        title: 'title',
        description: 'description',
        visibility: 'visibility',
        scheduleAt: 'schedule_at',
        assetId: 'asset_id',
        videoPath: 'video_path',
        videoMime: 'video_mime',
        videoSize: 'video_size',
        durationMs: 'duration_ms',
        width: 'width',
        height: 'height',
        callbackState: 'callback_state',
        attempts: 'attempts',
        maxAttempts: 'max_attempts',
        nextAttemptAt: 'next_attempt_at',
        lockedAt: 'locked_at',
        lockedBy: 'locked_by',
        error: 'error',
        completedAt: 'completed_at',
        payload: 'payload',
      };
      // Unknown keys used to be dropped silently, which hides caller bugs.
      const unknown = Object.keys(patch).filter((key) => !(key in allowed));
      if (unknown.length) {
        throw new Error(`jobs.update received unknown field(s): ${unknown.join(', ')}`);
      }
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries(allowed)) {
        if (!(key in patch)) continue;
        sets.push(`${column} = ?`);
        params.push(key === 'payload' ? JSON.stringify(patch[key]) : patch[key]);
      }
      if (!sets.length) return jobs.get(id);
      sets.push('updated_at = ?');
      params.push(now(), id);
      db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      return jobs.get(id);
    },
    /** Atomic lease: only one worker can move a job out of a claimable state. */
    claim(id, expectedStatuses, workerId) {
      const placeholders = expectedStatuses.map(() => '?').join(',');
      const res = db
        .prepare(
          `UPDATE jobs SET status = 'processing', locked_at = ?, locked_by = ?, updated_at = ?
           WHERE id = ? AND status IN (${placeholders})`,
        )
        .run(now(), workerId, now(), id, ...expectedStatuses);
      return res.changes > 0;
    },
    due(limit = 5) {
      return db
        .prepare(
          `SELECT * FROM jobs
           WHERE status IN ('queued', 'retry')
             AND (schedule_at IS NULL OR schedule_at <= ?)
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (locked_at IS NULL OR locked_at < ?)
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(now(), now(), now() - 10 * 60 * 1000, limit)
        .map(mapJob);
    },
    remove(id) {
      return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
    },
    counts() {
      const rows = db.prepare('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status').all();
      return Object.fromEntries(rows.map((r) => [r.status, r.c]));
    },
    addEvent(jobId, level, message, { provider = null, data = null } = {}) {
      db.prepare(
        'INSERT INTO job_events (job_id, provider, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(jobId, provider, level, message, data ? JSON.stringify(data) : null, now());
    },
    events(jobId, limit = 200) {
      return db
        .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?')
        .all(jobId, limit)
        .map((e) => ({ ...e, data: json(e.data, null) }));
    },
  };

  const targets = {
    create(jobId, provider, { params = {}, connectionId = null, status = 'queued', variant = null } = {}) {
      const id = newId('tgt');
      const ts = now();
      db.prepare(
        `INSERT INTO job_targets (id, job_id, provider, connection_id, status, params, variant, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, jobId, provider, connectionId, status, JSON.stringify(params), variant, ts, ts);
      return targets.get(id);
    },
    get(id) {
      return mapTarget(db.prepare('SELECT * FROM job_targets WHERE id = ?').get(id));
    },
    byJob(jobId) {
      return db
        .prepare('SELECT * FROM job_targets WHERE job_id = ? ORDER BY rowid ASC')
        .all(jobId)
        .map(mapTarget);
    },
    update(id, patch) {
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries({
        status: 'status',
        connectionId: 'connection_id',
        externalId: 'external_id',
        externalUrl: 'external_url',
        attempts: 'attempts',
        lastError: 'last_error',
        detail: 'detail',
        variant: 'variant',
      })) {
        if (!(key in patch)) continue;
        sets.push(`${column} = ?`);
        params.push(key === 'detail' && typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key]);
      }
      if (!sets.length) return targets.get(id);
      sets.push('updated_at = ?');
      params.push(now(), id);
      db.prepare(`UPDATE job_targets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      return targets.get(id);
    },
  };

  const assets = {
    create(asset) {
      const id = asset.id ?? newId('ast');
      db.prepare(
        `INSERT INTO assets (id, job_id, variant, path, storage_key, mime, size, width, height, duration_ms, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        asset.jobId ?? null,
        asset.variant ?? 'source',
        asset.path ?? null,
        asset.storageKey ?? null,
        asset.mime ?? null,
        asset.size ?? null,
        asset.width ?? null,
        asset.height ?? null,
        asset.durationMs ?? null,
        JSON.stringify(asset.meta ?? {}),
        now(),
      );
      return assets.get(id);
    },
    get(id) {
      const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
      return row ? { ...row, meta: json(row.meta, {}) } : undefined;
    },
    byJob(jobId) {
      return db
        .prepare('SELECT * FROM assets WHERE job_id = ?')
        .all(jobId)
        .map((row) => ({ ...row, meta: json(row.meta, {}) }));
    },
  };

  const oauthStates = {
    create({ provider, verifier = null, redirectUri = null, meta = {}, ttlMs = 10 * 60 * 1000 }) {
      const state = newId('st');
      db.prepare(
        'INSERT INTO oauth_states (state, provider, verifier, redirect_uri, meta, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(state, provider, verifier, redirectUri, JSON.stringify(meta), now(), now() + ttlMs);
      return state;
    },
    consume(state) {
      const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
      if (!row) return null;
      db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
      if (row.expires_at < now()) return null;
      return {
        state: row.state,
        provider: row.provider,
        verifier: row.verifier,
        redirectUri: row.redirect_uri,
        meta: json(row.meta, {}),
      };
    },
  };

  const settings = {
    get(key, fallback = null) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, String(value), now());
      return value;
    },
    all() {
      return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
    },
  };

  return { db, apiKeys, connections, jobs, targets, assets, oauthStates, settings };
}

function mapKey(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: json(row.scopes, []),
    allowedOrigins: json(row.allowed_origins, []),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function mapConnection(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.account_id,
    displayName: row.display_name,
    tokens: row.tokens,
    scopes: json(row.scopes, []),
    status: row.status,
    sandbox: Boolean(row.sandbox),
    meta: json(row.meta, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    title: row.title,
    description: row.description,
    tags: json(row.tags, []),
    visibility: row.visibility,
    scheduleAt: row.schedule_at,
    payload: json(row.payload, {}),
    assetId: row.asset_id,
    videoPath: row.video_path,
    videoMime: row.video_mime,
    videoSize: row.video_size,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    sourceName: row.source_name,
    callbackUrl: row.callback_url,
    callbackState: row.callback_state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapTarget(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    jobId: row.job_id,
    provider: row.provider,
    connectionId: row.connection_id,
    status: row.status,
    params: json(row.params, {}),
    variant: row.variant,
    externalId: row.external_id,
    externalUrl: row.external_url,
    attempts: row.attempts,
    lastError: row.last_error,
    detail: json(row.detail, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
