import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal env loader: `node --env-file` is not available on every supported
 * runtime, so we parse .env ourselves. Real environment variables always win.
 */
export function loadEnvFile(file = '.env') {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function list(name, fallback = []) {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function dataDir() {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  for (const sub of ['', 'media', 'tmp', 'assets']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

export function createConfig(overrides = {}) {
  loadEnvFile();
  const secret = process.env.POSTER_SECRET || '';
  const production = process.env.NODE_ENV === 'production';
  const resolvedSecret =
    secret || (production ? null : 'dev-only-insecure-secret-change-me-please!!');
  if (!resolvedSecret) {
    throw new Error('POSTER_SECRET must be set in production (openssl rand -hex 32)');
  }
  if (!production && !secret) {
    // eslint-disable-next-line no-console
    console.warn('[posterly] POSTER_SECRET is not set — using an insecure dev secret.');
  }

  const dir = dataDir();
  const config = {
    env: process.env.NODE_ENV || 'development',
    production,
    port: int('PORT', 4000),
    host: process.env.HOST || '0.0.0.0',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${int('PORT', 4000)}`).replace(/\/$/, ''),
    secret: resolvedSecret,
    admin: {
      user: process.env.POSTER_ADMIN_USER || 'admin',
      password: process.env.POSTER_ADMIN_PASSWORD || 'posterly',
    },
    allowedOrigins: list('ALLOWED_ORIGINS', ['*']),
    dataDir: dir,
    paths: {
      db: path.join(dir, 'posterly.sqlite'),
      media: path.join(dir, 'media'),
      tmp: path.join(dir, 'tmp'),
      assets: path.join(dir, 'assets'),
    },
    maxUploadBytes: int('MAX_UPLOAD_MB', 512) * 1024 * 1024,
    queue: {
      mode: process.env.POSTER_MODE || 'all',
      concurrency: int('QUEUE_CONCURRENCY', 2),
      pollMs: int('QUEUE_POLL_MS', 750),
      maxAttempts: int('MAX_ATTEMPTS', 5),
    },
    sandbox: process.env.POSTER_SANDBOX || 'auto',
    allowPrivateFetch: bool('POSTER_ALLOW_PRIVATE_URLS', false),
    media: {
      ffmpegPath: process.env.FFMPEG_PATH || null,
      ffprobePath: process.env.FFPROBE_PATH || null,
      enabled: !bool('POSTER_DISABLE_MEDIA', false),
    },
    s3: process.env.S3_BUCKET
      ? {
          bucket: process.env.S3_BUCKET,
          region: process.env.S3_REGION || 'us-east-1',
          endpoint: process.env.S3_ENDPOINT || undefined,
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
        }
      : null,
    oauth: {
      youtube: {
        clientId: process.env.YOUTUBE_CLIENT_ID,
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
      },
      tiktok: {
        clientId: process.env.TIKTOK_CLIENT_KEY,
        clientSecret: process.env.TIKTOK_CLIENT_SECRET,
      },
      facebook: {
        clientId: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
      },
      x: {
        clientId: process.env.X_CLIENT_ID,
        clientSecret: process.env.X_CLIENT_SECRET,
      },
      linkedin: {
        clientId: process.env.LINKEDIN_CLIENT_ID,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
      },
    },
    signedUrlTtlSeconds: int('SIGNED_URL_TTL_SECONDS', 6 * 60 * 60),
    ...overrides,
  };
  return config;
}

export const cryptoUtils = crypto;
