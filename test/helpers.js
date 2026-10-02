import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/index.js';
import { generateApiKey, hashApiKey } from '../src/lib/crypto.js';

export function makeTempDir(prefix = 'posterly-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Boot the real stack (Express app + repo + storage + queue runner) against a
 * throwaway data directory and an in-memory SQLite database.
 */
export async function bootServer({ sandbox = 'auto', allowPrivate = false } = {}) {
  const dir = makeTempDir();
  process.env.DATA_DIR = dir;
  process.env.POSTER_SECRET = 'test-secret-value-that-is-long-enough-1234567890';
  process.env.POSTER_SANDBOX = sandbox;
  process.env.PUBLIC_BASE_URL = 'http://localhost:4099';
  process.env.POSTER_ALLOW_PRIVATE_URLS = allowPrivate ? '1' : '0';
  process.env.POSTER_DISABLE_MEDIA = '0';

  const server = await createServer({ dbFile: ':memory:', logger: () => {}, sleep: async () => {} });
  const listener = await listen(server.app);
  // Signed media URLs must point at the port the test server actually got.
  server.config.publicBaseUrl = `http://127.0.0.1:${listener.address().port}`;

  const plaintext = generateApiKey();
  const key = server.repo.apiKeys.create({
    name: 'test',
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, 12),
    scopes: ['publish', 'read', 'admin'],
  });

  return {
    ...server,
    dir,
    listener,
    port: listener.address().port,
    base: `http://127.0.0.1:${listener.address().port}`,
    apiKey: plaintext,
    keyRecord: key,
    async close() {
      server.runner.stop();
      await new Promise((resolve) => listener.close(resolve));
      try {
        server.db.close();
      } catch {
        /* noop */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const listener = http.createServer(app).listen(0, '127.0.0.1', () => resolve(listener));
  });
}

/** A minimal but structurally plausible MP4 (ftyp + mdat) so sniffing works. */
export function fakeMp4(bytes = 2048) {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
  ]);
  const mdatHeader = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74]);
  const filler = Buffer.alloc(Math.max(0, bytes - ftyp.length - mdatHeader.length), 7);
  return Buffer.concat([ftyp, mdatHeader, filler]);
}

export function multipartBody(fields, file) {
  const boundary = `----posterlytest${Date.now()}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
      file.content,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Tiny HTTP server used to test `videoUrl` ingestion and outbound webhooks. */
export async function startFixtureServer({ response = fakeMp4(4096), contentType = 'video/mp4', onRequest } = {}) {
  const received = [];
  const listener = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const payload = Buffer.concat(chunks);
        received.push({ method: req.method, url: req.url, headers: req.headers, body: payload });
        onRequest?.({ req, res, payload });
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': contentType, 'content-length': String(response.length) });
        res.end(response);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  return {
    url: (p = '/') => `http://127.0.0.1:${listener.address().port}${p}`,
    received,
    async close() {
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
