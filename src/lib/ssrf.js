import dns from 'node:dns/promises';
import net from 'node:net';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal', 'instance-data'];

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((re) => re.test(ip));
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

/**
 * Guard against SSRF when Posterly downloads a video from a user supplied URL.
 * Resolves DNS and rejects anything that points at loopback / private ranges.
 */
export async function assertPublicUrl(rawUrl, { allowPrivate = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol "${parsed.protocol}" — use http or https`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (BLOCKED_HOSTS.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw new Error(`Refusing to fetch from internal hostname "${hostname}"`);
    }
    if (net.isIP(hostname)) {
      if (isPrivateIp(hostname)) throw new Error(`Refusing to fetch from private address "${hostname}"`);
    } else {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      if (!records.length) throw new Error(`Could not resolve "${hostname}"`);
      for (const rec of records) {
        if (isPrivateIp(rec.address)) {
          throw new Error(`Refusing to fetch "${hostname}" — resolves to private address ${rec.address}`);
        }
      }
    }
  }
  return parsed;
}

/**
 * Stream a remote file to disk with a hard size cap.
 * Returns { size, mime, truncated:false }.
 */
export async function downloadToFile(url, destPath, { maxBytes, fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && maxBytes && declared > maxBytes) {
    throw new Error(`Remote file is ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  if (!res.body) throw new Error('Empty response body');

  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) {
        cb(new Error(`Download exceeded the ${maxBytes} byte limit`));
        return;
      }
      cb(null, chunk);
    },
  });

  const out = createWriteStream(destPath);
  try {
    await pipeline(res.body, counter, out);
  } catch (err) {
    out.destroy();
    throw err;
  }
  return { size, mime: res.headers.get('content-type')?.split(';')[0] ?? null };
}
