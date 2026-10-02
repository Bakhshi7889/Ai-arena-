import fs from 'node:fs';

/**
 * Every platform adapter talks to the network through this tiny interface:
 *
 *   transport.request({ method, url, query, headers, json, form, multipart, body, timeoutMs })
 *     -> { status, ok, headers, text(), json(), buffer() }
 *
 * `FetchTransport` does the real thing. `SandboxTransport` answers the same
 * calls with recorded fixtures so the whole publish pipeline (including
 * chunked/resumable uploads and polling) can run without platform credentials.
 */
export class FetchTransport {
  constructor({ fetchImpl = fetch, defaultTimeoutMs = 120_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.name = 'fetch';
  }

  async request(spec) {
    const { method = 'GET', headers = {}, timeoutMs = this.defaultTimeoutMs, signal } = spec;
    const url = buildUrl(spec.url, spec.query);
    const init = { method, headers: { ...headers }, redirect: spec.redirect ?? 'follow' };

    if (spec.json !== undefined) {
      init.body = JSON.stringify(spec.json);
      init.headers['content-type'] ??= 'application/json';
    } else if (spec.form !== undefined) {
      init.body = new URLSearchParams(spec.form).toString();
      init.headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (spec.multipart !== undefined) {
      const fd = new FormData();
      for (const [key, value] of Object.entries(spec.multipart)) {
        if (value === undefined || value === null) continue;
        if (value && typeof value === 'object' && 'buffer' in value) {
          fd.append(key, new Blob([value.buffer], { type: value.contentType || 'application/octet-stream' }), value.filename || key);
        } else if (value instanceof Blob) {
          fd.append(key, value);
        } else {
          fd.append(key, String(value));
        }
      }
      init.body = fd;
    } else if (spec.body !== undefined) {
      init.body = spec.body;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const buf = Buffer.from(await res.arrayBuffer());
      return makeResponse(res.status, res.headers, buf);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function makeResponse(status, headers, buffer = Buffer.alloc(0)) {
  const map = new Map();
  const fill = (k, v) => map.set(String(k).toLowerCase(), String(v));
  if (headers) {
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      headers.forEach((v, k) => fill(k, v));
    } else if (typeof headers[Symbol.iterator] === 'function') {
      for (const [k, v] of headers) fill(k, v);
    } else {
      for (const [k, v] of Object.entries(headers)) fill(k, v);
    }
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => map.get(String(k).toLowerCase()) ?? null,
      has: (k) => map.has(String(k).toLowerCase()),
      entries: () => map.entries(),
      raw: map,
    },
    text: () => buffer.toString('utf8'),
    json: () => {
      try {
        return buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
      } catch {
        return null;
      }
    },
    buffer: () => buffer,
  };
}

function buildUrl(url, query) {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Exponential backoff with jitter, honouring Retry-After on 429/5xx. */
export async function withRetry(fn, { attempts = 3, baseMs = 500, maxMs = 15_000, shouldRetry, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fn(attempt);
      if (res && typeof res === 'object' && 'status' in res && !res.ok) {
        const retryable = shouldRetry ? shouldRetry(res) : [408, 425, 429, 500, 502, 503, 504].includes(res.status);
        if (retryable && attempt < attempts) {
          await sleep(backoff(attempt, baseMs, maxMs, res.headers?.get?.('retry-after')));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) throw err;
      await sleep(backoff(attempt, baseMs, maxMs));
    }
  }
  throw lastError;
}

export function backoff(attempt, baseMs = 500, maxMs = 15_000, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) return Math.min(maxMs, Math.max(0, seconds * 1000));
  }
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read a byte range of a file for chunked uploads. */
export function readRange(filePath, start, end) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = end - start + 1;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

export function fileStats(filePath) {
  const st = fs.statSync(filePath);
  return { size: st.size };
}

/**
 * Sandbox transport. Routes are matched by `METHOD <url-or-regexp>`; the first
 * match wins. Unknown routes return 404 so adapters fail loudly instead of
 * silently "succeeding".
 */
export class SandboxTransport {
  constructor({ routes = [], latencyMs = 0, sleep = defaultSleep } = {}) {
    this.routes = routes;
    this.calls = [];
    this.latencyMs = latencyMs;
    this.sleep = sleep;
    this.name = 'sandbox';
  }

  on(method, urlPattern, handler) {
    this.routes.push({ method: method.toUpperCase(), urlPattern, handler });
    return this;
  }

  async request(spec) {
    const method = (spec.method || 'GET').toUpperCase();
    const url = buildUrl(spec.url, spec.query);
    const call = {
      method,
      url,
      headers: spec.headers ?? {},
      json: spec.json,
      form: spec.form,
      multipart: spec.multipart ? Object.keys(spec.multipart) : undefined,
      bodyBytes: spec.body ? spec.body.length : 0,
      at: Date.now(),
    };
    this.calls.push(call);
    if (this.latencyMs) await this.sleep(this.latencyMs);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const matcher = route.urlPattern;
      const isMatch =
        typeof matcher === 'string' ? url.startsWith(matcher) || url.includes(matcher) : matcher.test(url);
      if (!isMatch) continue;
      const out = await route.handler({ ...spec, url, call, transport: this });
      const body = Buffer.isBuffer(out?.body) ? out.body : Buffer.from(out?.body ?? '', 'utf8');
      return makeResponse(out?.status ?? 200, out?.headers ?? {}, body);
    }
    return makeResponse(404, { 'content-type': 'application/json' }, JSON.stringify({ error: `sandbox: no route for ${method} ${url}` }));
  }
}

/** Transport whose behaviour is supplied by the caller — used by unit tests. */
export class ScriptedTransport {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.name = 'scripted';
  }

  async request(spec) {
    const url = buildUrl(spec.url, spec.query);
    this.calls.push({ ...spec, url });
    const out = await this.handler({ ...spec, url, calls: this.calls });
    const body = Buffer.isBuffer(out?.body) ? out.body : Buffer.from(out?.body ?? '', 'utf8');
    return makeResponse(out?.status ?? 200, out?.headers ?? {}, body);
  }
}
