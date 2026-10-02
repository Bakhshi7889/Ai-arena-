import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { assertPublicUrl, downloadToFile } from '../lib/ssrf.js';
import { badRequest, conflict, forbidden, notFound, payloadTooLarge, unauthorized } from '../lib/errors.js';
import { newId, hashApiKey } from '../lib/crypto.js';
import { mediaKey } from '../storage/index.js';
import { validateCreatePost, assertKnownTargets } from '../lib/validators.js';
import { adapterMeta, PUBLISHABLE } from '../adapters/registry.js';
import { planVariants } from '../media/plan.js';
import { resolveBinaries } from '../media/ffmpeg.js';

const VIDEO_MIME = /^video\//i;
const ALLOWED_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];

export function createApiRouter({ repo, storage, config, runner, logger = () => {} }) {
  const router = express.Router();

  const upload = multer({
    dest: config.paths.tmp,
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 40 },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!VIDEO_MIME.test(file.mimetype || '') && !ALLOWED_EXT.includes(ext)) {
        cb(badRequest(`Unsupported file type "${file.mimetype}". Send a video: ${ALLOWED_EXT.join(', ')}`));
        return;
      }
      cb(null, true);
    },
  });

  // ---------------------------------------------------------------- auth ---
  router.use((req, _res, next) => {
    const header = req.get('x-api-key') || req.get('authorization');
    const raw = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : header;
    if (!raw) return next(unauthorized('Missing API key. Send X-API-Key: pst_live_…'));
    const key = repo.apiKeys.findByHash(hashApiKey(raw));
    if (!key) return next(unauthorized('Unknown API key'));
    if (key.revokedAt) return next(unauthorized('This API key was revoked'));
    repo.apiKeys.touch(key.id);
    req.apiKey = key;
    next();
  });

  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.apiKey.scopes.includes('publish') || req.apiKey.scopes.includes('admin')) return next();
    next(forbidden('This API key cannot publish (needs the "publish" scope)'));
  });

  // -------------------------------------------------------------- health ---
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'posterly',
      version: '0.1.0',
      driver: repo.db.__driver,
      storage: storage.driver,
      ffmpeg: resolveBinaries(config.media).available,
      platforms: PUBLISHABLE,
      time: new Date().toISOString(),
    });
  });

  router.get('/platforms', (_req, res) => {
    const connections = repo.connections.list();
    res.json({
      platforms: adapterMeta().map((meta) => {
        const connection = connections.find((c) => c.provider === meta.id || (meta.id === 'instagram' && c.provider === 'facebook'));
        return {
          ...meta,
          connected: Boolean(connection),
          sandbox: Boolean(connection?.sandbox) || config.sandbox === 'always',
          account: connection?.displayName ?? null,
        };
      }),
    });
  });

  // -------------------------------------------------------------- ingest ---
  router.post('/posts', upload.single('video'), async (req, res, next) => {
    let tmpFile = req.file?.path ?? null;
    try {
      const parsed = parseIngestBody(req.body);
      const validation = validateCreatePost(parsed, { hasFile: Boolean(req.file) });
      if (!validation.success) {
        throw badRequest('Invalid request', validation.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      const input = validation.data;
      assertKnownTargets(input.targets);

      const idempotencyKey = req.get('idempotency-key') || input.idempotencyKey || null;
      const existing = idempotencyKey ? repo.jobs.getByIdempotencyKey(req.apiKey.id, idempotencyKey) : null;
      if (existing) {
        cleanup(tmpFile);
        res.status(200).json({ job: publicJob(repo.jobs.get(existing.id)), deduplicated: true });
        return;
      }

      const jobId = newId('job');
      let videoPath = null;
      let videoSize = 0;
      let videoMime = null;
      let sourceName = null;

      if (req.file) {
        sourceName = req.file.originalname || 'video.mp4';
        videoSize = req.file.size;
        videoMime = req.file.mimetype || 'video/mp4';
        const key = mediaKey(jobId, 'source', sourceName);
        await storage.put({ key, sourcePath: req.file.path, contentType: videoMime });
        videoPath = storage.getPath(key) ?? req.file.path;
        if (storage.getPath(key)) cleanup(req.file.path);
      } else {
        const target = await assertPublicUrl(input.videoUrl, { allowPrivate: config.allowPrivateFetch });
        sourceName = path.basename(target.pathname) || 'video.mp4';
        const key = mediaKey(jobId, 'source', sourceName);
        const staged = path.join(config.paths.tmp, `${jobId}-${sourceName}`);
        const result = await downloadToFile(target.toString(), staged, { maxBytes: config.maxUploadBytes });
        videoSize = result.size;
        videoMime = result.mime || 'video/mp4';
        await storage.put({ key, sourcePath: staged, contentType: videoMime });
        videoPath = storage.getPath(key) ?? staged;
        if (storage.getPath(key)) cleanup(staged);
        else videoPath = staged;
      }

      const job = repo.jobs.create({
        id: jobId,
        apiKeyId: req.apiKey.id,
        idempotencyKey,
        title: input.title,
        description: input.description ?? null,
        tags: input.tags,
        visibility: input.visibility,
        scheduleAt: input.scheduledAt ? new Date(input.scheduledAt).getTime() : null,
        payload: { targets: input.targets, videoUrl: input.videoUrl ?? null },
        videoPath,
        videoMime,
        videoSize,
        sourceName,
        callbackUrl: input.callbackUrl ?? null,
        maxAttempts: config.queue.maxAttempts,
        status: input.scheduledAt ? 'queued' : 'queued',
      });

      for (const target of input.targets) {
        const { platform, ...params } = target;
        repo.targets.create(job.id, platform, {
          params: { ...params, format: params.format ?? undefined },
          variant: 'source',
        });
      }

      const plan = planVariants(
        { size: videoSize, mime: videoMime },
        input.targets.map((t) => ({ provider: t.platform, format: t.format })),
        { ffmpegAvailable: false },
      );
      for (const entry of plan) {
        for (const error of entry.errors) {
          logger('warn', `pre-flight: ${entry.provider}: ${error}`);
        }
      }

      repo.jobs.addEvent(job.id, 'info', `accepted from ${req.apiKey.name} via ${req.is('multipart/form-data') ? 'multipart upload' : 'videoUrl'}`);
      logger('info', `job ${job.id} queued for ${input.targets.map((t) => t.platform).join(', ')}`);

      res.status(202).json({ job: publicJob(repo.jobs.get(job.id)), warnings: plan.flatMap((p) => p.warnings.map((w) => ({ platform: p.provider, message: w }))) });
    } catch (err) {
      if (err?.code === 'LIMIT_FILE_SIZE') return next(payloadTooLarge(`File exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB limit`));
      next(err);
    } finally {
      cleanup(tmpFile);
    }
  });

  router.get('/posts', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const jobs = repo.jobs.list({ limit, status: req.query.status || undefined });
    res.json({ jobs: jobs.map(publicJob), limit });
  });

  router.get('/posts/:id', (req, res, next) => {
    const job = repo.jobs.get(req.params.id);
    if (!job) return next(notFound(`No job with id ${req.params.id}`));
    res.json({ job: publicJob(job), events: repo.jobs.events(job.id, 50) });
  });

  router.post('/posts/:id/retry', (req, res, next) => {
    const job = repo.jobs.get(req.params.id);
    if (!job) return next(notFound(`No job with id ${req.params.id}`));
    if (['published'].includes(job.status)) return next(conflict('Job already published'));
    for (const target of repo.targets.byJob(job.id).filter((t) => t.status !== 'published')) {
      repo.targets.update(target.id, { status: 'queued', lastError: null });
    }
    repo.jobs.update(job.id, { status: 'queued', attempts: 0, nextAttemptAt: null, error: null, completedAt: null });
    repo.jobs.addEvent(job.id, 'info', 'retry requested');
    res.json({ job: publicJob(repo.jobs.get(job.id)) });
  });

  router.delete('/posts/:id', (req, res, next) => {
    const job = repo.jobs.get(req.params.id);
    if (!job) return next(notFound(`No job with id ${req.params.id}`));
    repo.jobs.remove(job.id);
    res.json({ deleted: true, id: job.id });
  });

  router.get('/posts/:id/events', (req, res, next) => {
    const job = repo.jobs.get(req.params.id);
    if (!job) return next(notFound(`No job with id ${req.params.id}`));
    res.json({ events: repo.jobs.events(job.id, 200) });
  });

  return router;
}

function parseIngestBody(body = {}) {
  const out = { ...body };
  const maybeJson = (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
    return value;
  };

  out.tags = maybeJson(body.tags);
  if (typeof out.tags === 'string') out.tags = out.tags.split(',').map((s) => s.trim()).filter(Boolean);

  if (body.platforms && !body.targets) out.targets = maybeJson(body.platforms);
  else out.targets = maybeJson(body.targets);
  if (typeof out.targets === 'string') out.targets = out.targets.split(',').map((s) => s.trim()).filter(Boolean);

  if (body.scheduledAt) out.scheduledAt = body.scheduledAt;
  return out;
}

export function publicJob(job) {
  if (!job) return null;
  const { payload, ...rest } = job;
  return {
    ...rest,
    videoPath: undefined,
    targets: (job.targets ?? []).map((t) => ({
      id: t.id,
      provider: t.provider,
      status: t.status,
      externalId: t.externalId,
      externalUrl: t.externalUrl,
      attempts: t.attempts,
      error: t.lastError,
      sandbox: t.detail?.sandbox ?? null,
    })),
  };
}

function cleanup(file) {
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}
