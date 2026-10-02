import { AdapterError } from '../lib/errors.js';
import { readRange } from '../lib/http.js';

export const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Shared adapter surface.
 *
 * publish(ctx) -> { externalId, externalUrl, state: 'published' | 'processing', detail }
 *
 * ctx = { job, target, credentials, asset, transport, config, log }
 */
export class BaseAdapter {
  static id = 'base';

  constructor({ transport, config } = {}) {
    this.transport = transport;
    this.config = config;
  }

  // eslint-disable-next-line no-unused-vars
  async publish(_ctx) {
    throw new Error('not implemented');
  }

  requireCredentials(credentials, what = 'an access token') {
    if (!credentials?.accessToken) {
      throw new AdapterError(`This target needs ${what}. Connect the account first.`, {
        code: 'missing_credentials',
        retryable: false,
      });
    }
  }
}

/**
 * PUT a file to `uploadUrl` in fixed-size chunks using HTTP Content-Range,
 * which is what YouTube's resumable protocol and TikTok's FILE_UPLOAD use.
 */
export async function chunkedPut({
  transport,
  uploadUrl,
  filePath,
  totalBytes,
  headers = {},
  chunkSize = CHUNK_SIZE,
  log = () => {},
  onChunk,
}) {
  if (totalBytes <= 0) throw new AdapterError('Cannot upload an empty file', { retryable: false });

  for (let start = 0; start < totalBytes; ) {
    const end = Math.min(start + chunkSize, totalBytes) - 1;
    const body = readRange(filePath, start, end);
    const res = await transport.request({
      method: 'PUT',
      url: uploadUrl,
      headers: {
        'content-range': `bytes ${start}-${end}/${totalBytes}`,
        'content-length': String(body.length),
        ...headers,
      },
      body,
      timeoutMs: 300_000,
    });
    onChunk?.({ start, end, status: res.status });
    log(`chunk ${start}-${end}/${totalBytes} -> ${res.status}`);

    if (res.status === 200 || res.status === 201) {
      return { done: true, status: res.status, json: res.json(), text: res.text() };
    }
    // 308 Resume Incomplete: server tells us how much it already has.
    if (res.status === 308 || res.status === 206 || res.status === 503) {
      const range = res.headers.get('range');
      const received = range ? Number(range.split('-')[1]) + 1 : end + 1;
      start = Number.isFinite(received) ? received : end + 1;
      continue;
    }
    throw new AdapterError(`Chunk upload failed with HTTP ${res.status}: ${res.text().slice(0, 500)}`, {
      code: 'chunk_upload_failed',
      status: res.status,
    });
  }
  return { done: true, status: 200, json: null, text: '' };
}

export function truncate(text, max) {
  if (!text) return text;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function pollUntil({ fn, shouldContinue, intervalMs = 3000, timeoutMs = 120_000, sleep = defaultSleep, log = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      const value = await fn(attempt);
      if (!shouldContinue(value)) return value;
      if (Date.now() > deadline) return value;
      log(`still processing (attempt ${attempt})`);
      await sleep(intervalMs);
    }
  })();
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
