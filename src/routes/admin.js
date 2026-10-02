import express from 'express';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import {
  encryptJSON,
  generateApiKey,
  hashApiKey,
  hmacSha256,
  newToken,
  timingSafeEqual,
  verifyPassword,
  hashPassword,
} from '../lib/crypto.js';
import { createKeySchema, pasteTokenSchema } from '../lib/validators.js';
import { adapterMeta, PUBLISHABLE } from '../adapters/registry.js';
import { OAUTH_PROVIDERS, isConfigured } from '../oauth/index.js';
import { publicJob } from './api.js';
import { resolveBinaries } from '../media/ffmpeg.js';

const COOKIE = 'posterly_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionToken(secret, ttlMs = SESSION_TTL_MS) {
  const expires = Date.now() + ttlMs;
  const signature = hmacSha256(secret, `session.${expires}`);
  return `${expires}.${signature}`;
}

export function verifySessionToken(secret, token) {
  if (!token || !token.includes('.')) return false;
  const [expires, signature] = token.split('.');
  if (Number(expires) < Date.now()) return false;
  return timingSafeEqual(hmacSha256(secret, `session.${expires}`), signature);
}

export function createAdminRouter({ repo, config, runner }) {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const expectedUser = config.admin.user;
    const expectedPassword = config.admin.password;
    const storedHash = repo.settings.get('admin_password_hash');
    const passwordOk = storedHash
      ? verifyPassword(password ?? '', storedHash)
      : timingSafeEqual(String(password ?? ''), expectedPassword);
    if (String(username ?? '') !== expectedUser || !passwordOk) {
      throw unauthorized('Wrong username or password');
    }
    if (!storedHash) repo.settings.set('admin_password_hash', hashPassword(expectedPassword));
    res.cookie(COOKIE, createSessionToken(config.secret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    res.json({ ok: true, user: expectedUser });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.use((req, _res, next) => {
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    if (!verifySessionToken(config.secret, cookie)) return next(unauthorized('Dashboard session expired — sign in again'));
    next();
  });

  router.get('/api/summary', (_req, res) => {
    res.json({
      counts: repo.jobs.counts(),
      connections: repo.connections.list().map(publicConnection),
      keys: repo.apiKeys.list().map(publicKey),
      platforms: adapterMeta(),
      oauth: Object.entries(OAUTH_PROVIDERS).map(([id, def]) => ({ id, label: def.label, configured: isConfigured(id, config) })),
      config: {
        publicBaseUrl: config.publicBaseUrl,
        storage: repo.db.__driver === undefined ? null : undefined,
        storageDriver: runner?.storage?.driver ?? 'local',
        ffmpeg: resolveBinaries(config.media).available,
        sandbox: config.sandbox,
        maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
        publishable: PUBLISHABLE,
      },
    });
  });

  // ------------------------------------------------------------ API keys ---
  router.get('/api/keys', (_req, res) => res.json({ keys: repo.apiKeys.list().map(publicKey) }));

  router.post('/api/keys', (req, res) => {
    const parsed = createKeySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid key definition', parsed.error.issues);
    const plaintext = generateApiKey();
    const key = repo.apiKeys.create({
      name: parsed.data.name,
      keyHash: hashApiKey(plaintext),
      keyPrefix: plaintext.slice(0, 12),
      scopes: parsed.data.scopes,
      allowedOrigins: parsed.data.allowedOrigins,
    });
    res.status(201).json({ key: publicKey(key), secret: plaintext, warning: 'Store this now — it is not shown again.' });
  });

  router.delete('/api/keys/:id', (req, res) => {
    const key = repo.apiKeys.get(req.params.id);
    if (!key) throw notFound('No such API key');
    repo.apiKeys.revoke(key.id);
    res.json({ revoked: true, id: key.id });
  });

  // --------------------------------------------------------- connections ---
  router.get('/api/connections', (_req, res) =>
    res.json({ connections: repo.connections.list().map(publicConnection) }),
  );

  router.post('/api/connections', (req, res) => {
    const parsed = pasteTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid connection', parsed.error.issues);
    const d = parsed.data;
    const tokens = encryptJSON(
      {
        accessToken: d.accessToken,
        refreshToken: d.refreshToken ?? null,
        expiresAt: d.expiresAt ?? null,
      },
      config.secret,
    );
    const connection = repo.connections.upsert({
      provider: d.provider === 'instagram' ? 'facebook' : d.provider,
      accountId: d.accountId ?? `manual-${d.provider}`,
      displayName: d.displayName ?? `${d.provider} (manual token)`,
      tokens,
      scopes: [],
      sandbox: d.sandbox,
      meta: d.provider === 'instagram' ? { ...d.meta, instagramAccountId: d.accountId ?? d.meta.instagramAccountId } : d.meta,
    });
    res.status(201).json({ connection: publicConnection(connection) });
  });

  /** Sandbox connection: exercises the whole pipeline with simulated APIs. */
  router.post('/api/connections/demo', (req, res) => {
    const provider = String(req.body?.provider ?? '');
    if (!PUBLISHABLE.includes(provider) || provider === 'webhook') throw badRequest('Unknown provider');
    const connection = repo.connections.upsert({
      provider: provider === 'instagram' ? 'facebook' : provider,
      accountId: `demo-${provider}`,
      displayName: `${provider} (sandbox)`,
      tokens: null,
      scopes: [],
      sandbox: true,
      meta:
        provider === 'instagram'
          ? { instagramAccountId: '17840000000000000', pageId: '100000000000000' }
          : provider === 'facebook'
            ? { pageId: '100000000000000' }
            : {},
    });
    res.status(201).json({ connection: publicConnection(connection) });
  });

  router.delete('/api/connections/:id', (req, res) => {
    const connection = repo.connections.get(req.params.id);
    if (!connection) throw notFound('No such connection');
    repo.connections.remove(connection.id);
    res.json({ deleted: true, id: connection.id });
  });

  // ---------------------------------------------------------------- jobs ---
  router.get('/api/jobs', (req, res) => {
    const jobs = repo.jobs.list({ limit: Math.min(Number(req.query.limit) || 50, 200), status: req.query.status || undefined });
    res.json({ jobs: jobs.map((j) => ({ ...publicJob(repo.jobs.get(j.id)) })) });
  });

  router.get('/api/jobs/:id', (req, res) => {
    const job = repo.jobs.get(req.params.id);
    if (!job) throw notFound('No such job');
    res.json({ job: publicJob(job), events: repo.jobs.events(job.id, 200) });
  });

  router.post('/api/jobs/:id/retry', async (req, res) => {
    const job = repo.jobs.get(req.params.id);
    if (!job) throw notFound('No such job');
    for (const target of repo.targets.byJob(job.id).filter((t) => t.status !== 'published')) {
      repo.targets.update(target.id, { status: 'queued', lastError: null });
    }
    repo.jobs.update(job.id, { status: 'queued', attempts: 0, nextAttemptAt: null, error: null, completedAt: null });
    repo.jobs.addEvent(job.id, 'info', 'manual retry from dashboard');
    if (runner) await runner.drain();
    res.json({ job: publicJob(repo.jobs.get(job.id)) });
  });

  return router;
}

function publicKey(key) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.keyPrefix,
    scopes: key.scopes,
    allowedOrigins: key.allowedOrigins,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revoked: Boolean(key.revokedAt),
  };
}

function publicConnection(connection) {
  return {
    id: connection.id,
    provider: connection.provider,
    accountId: connection.accountId,
    displayName: connection.displayName,
    scopes: connection.scopes,
    status: connection.status,
    sandbox: connection.sandbox,
    meta: Object.fromEntries(Object.entries(connection.meta ?? {}).filter(([k]) => !k.toLowerCase().includes('token'))),
    createdAt: connection.createdAt,
  };
}

export function parseCookies(header) {
  return Object.fromEntries(
    String(header ?? '')
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );
}

export { newToken };
