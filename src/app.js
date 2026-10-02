import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApiRouter } from './routes/api.js';
import { createAdminRouter } from './routes/admin.js';
import { createOauthRouter } from './routes/oauth.js';
import { createMediaRouter } from './routes/media.js';
import { PosterError } from './lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

export function createApp({ repo, storage, config, runner, transport, logger = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // ----------------------------------------------------------------- CORS ---
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const allowed = config.allowedOrigins;
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-credentials', 'true');
    }
    res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, X-API-Key, Idempotency-Key');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true, limit: '4mb' }));

  // ------------------------------------------------------------ health/root --
  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, service: 'posterly', storage: storage.driver, db: repo.db.__driver, ffmpeg: runner?.binaries?.available ?? false }),
  );

  // Signed media (public, short-lived) --------------------------------------
  app.use('/media', createMediaRouter({ storage, config }));

  // OAuth -------------------------------------------------------------------
  app.use('/oauth', createOauthRouter({ repo, config, transport }));

  // Public ingest API --------------------------------------------------------
  app.use('/api/v1', createApiRouter({ repo, storage, config, runner, logger }));

  // Dashboard API ------------------------------------------------------------
  app.use('/admin', createAdminRouter({ repo, config, runner }));

  // Embeddable widget --------------------------------------------------------
  app.get('/embed/poster.js', (_req, res) => {
    const file = path.join(PUBLIC_DIR, 'poster-widget.js');
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.sendFile(file);
  });

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  app.use((_req, res) => {
    if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  // ---------------------------------------------------------- error handling -
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof PosterError) {
      return res.status(err.status).json(err.toJSON());
    }
    if (err?.status && err?.code) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    logger('error', err?.stack ?? String(err));
    res.status(500).json({ error: { code: 'internal_error', message: config.production ? 'Internal error' : String(err?.message ?? err) } });
  });

  return app;
}
