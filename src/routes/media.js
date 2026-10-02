import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { forbidden, notFound } from '../lib/errors.js';

/**
 * Serves stored media behind short-lived signed URLs. Platform APIs
 * (Instagram, Facebook file_url, TikTok PULL_FROM_URL) fetch the video from
 * here, and the same URL is what we hand to custom webhooks.
 */
export function createMediaRouter({ storage, config }) {
  const router = express.Router();

  if (storage.driver !== 'local') {
    router.get('/*', (_req, res) => {
      res.redirect(302, storage.publicUrl(_req.params[0]));
    });
    return router;
  }

  router.get('/*', (req, res, next) => {
    const key = decodeURIComponent(req.params[0] ?? '');
    const expires = Number(req.query.exp);
    const signature = String(req.query.sig ?? '');
    if (!storage.verifyUrl(key, expires, signature, config.secret)) {
      return next(forbidden('This media link is invalid or has expired'));
    }
    const filePath = storage.getPath(key);
    if (!filePath || !fs.existsSync(filePath)) return next(notFound('Asset not found'));

    const stat = fs.statSync(filePath);
    res.setHeader('content-type', guessType(filePath));
    res.setHeader('content-length', String(stat.size));
    res.setHeader('cache-control', 'private, max-age=3600');
    res.setHeader('accept-ranges', 'bytes');

    const range = req.get('range');
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('content-length', String(end - start + 1));
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });

  return router;
}

function guessType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
    }[ext] ?? 'application/octet-stream'
  );
}
