import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { signMediaToken, verifyMediaToken } from '../lib/crypto.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * Storage back-ends expose:
 *   put({ key, sourcePath | buffer, contentType }) -> { key, size }
 *   getPath(key)          -> local filesystem path (local driver only)
 *   exists(key)           -> boolean
 *   publicUrl(key, ttl)   -> URL a platform can download from, or null
 *   remove(key)
 */
export function createStorage(config) {
  if (config.s3) {
    try {
      return createS3Storage(config);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[posterly] S3 storage unavailable (${err.message}); falling back to local disk.`);
    }
  }
  return createLocalStorage(config);
}

export function createLocalStorage(config) {
  const root = config.paths.media;
  fs.mkdirSync(root, { recursive: true });

  const resolve = (key) => {
    const full = path.join(root, key);
    if (!full.startsWith(root)) throw new Error('Invalid storage key');
    return full;
  };

  return {
    driver: 'local',
    async put({ key, sourcePath, buffer, contentType }) {
      const dest = resolve(key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (buffer) {
        await fs.promises.writeFile(dest, buffer);
      } else {
        await fs.promises.copyFile(sourcePath, dest);
      }
      const size = (await fs.promises.stat(dest)).size;
      return { key, size, path: dest, contentType };
    },
    getPath: (key) => resolve(key),
    async exists(key) {
      try {
        await fs.promises.access(resolve(key));
        return true;
      } catch {
        return false;
      }
    },
    /** Signed, time-limited URL served by this process. */
    publicUrl(key, { ttlSeconds = config.signedUrlTtlSeconds, secret = config.secret, baseUrl = config.publicBaseUrl } = {}) {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const token = signMediaToken(secret, key, expires);
      const params = new URLSearchParams({ exp: String(expires), sig: token });
      return `${baseUrl}/media/${encodeURIComponent(key)}?${params.toString()}`;
    },
    verifyUrl: (key, expires, token, secret = config.secret) => verifyMediaToken(secret, key, expires, token),
    async remove(key) {
      try {
        await fs.promises.unlink(resolve(key));
      } catch {
        /* already gone */
      }
    },
  };
}

/** S3-compatible driver. Lazily imported so the dependency stays optional. */
export function createS3Storage(config) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = loadSdk('@aws-sdk/client-s3');
  const { getSignedUrl } = loadSdk('@aws-sdk/s3-request-presigner');
  const { bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle } = config.s3;

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });

  return {
    driver: 's3',
    async put({ key, sourcePath, buffer, contentType }) {
      const body = buffer ?? fs.createReadStream(sourcePath);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      let size = buffer?.length;
      if (size === undefined) size = (await fs.promises.stat(sourcePath)).size;
      return { key, size, storageKey: `s3://${bucket}/${key}`, contentType };
    },
    getPath: () => null,
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    },
    async publicUrl(key, { ttlSeconds = config.signedUrlTtlSeconds } = {}) {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(client, command, { expiresIn: ttlSeconds });
    },
    verifyUrl: () => true, // presigned URLs are validated by S3 itself
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async getStream(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body;
    },
  };
}

function loadSdk(name) {
  try {
    return nodeRequire(name);
  } catch (err) {
    throw new Error(`optional dependency "${name}" is not installed (${err.code || err.message})`);
  }
}

export function mediaKey(jobId, variant, sourceName = 'video') {
  const ext = path.extname(sourceName || 'video') || '.mp4';
  const safe = `${jobId}/${variant}${ext}`;
  return safe.replace(/[^a-zA-Z0-9._/-]/g, '_');
}

export function randomKey(prefix = 'tmp') {
  return `${prefix}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString('base64url')}`;
}
