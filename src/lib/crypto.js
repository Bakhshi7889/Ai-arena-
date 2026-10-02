import crypto from 'node:crypto';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_KEYLEN = 32;

function deriveKey(secret, salt = 'posterly/v1') {
  return crypto.scryptSync(String(secret), salt, SCRYPT_KEYLEN);
}

/** API keys are stored hashed; the plaintext is shown exactly once. */
export function generateApiKey(prefix = 'pst_live') {
  const raw = crypto.randomBytes(24).toString('base64url');
  return `${prefix}_${raw}`;
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** AES-256-GCM. Returns `iv.tag.ciphertext`, all base64url. */
export function encryptJSON(plainObject, secret) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plainObject), 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptJSON(payload, secret) {
  if (!payload) return null;
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivB64, 'base64url'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(out.toString('utf8'));
}

export function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(message).digest('hex');
}

/** Stripe-style signature header so receivers can verify and detect replays. */
export function signWebhookPayload(secret, payloadString, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = hmacSha256(secret, `${timestamp}.${payloadString}`);
  return { header: `t=${timestamp},v1=${signature}`, signature, timestamp };
}

export function verifyWebhookSignature(secret, header, payloadString, toleranceSeconds = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((p) => p.split('='))
      .map(([k, v]) => [String(k).trim(), String(v).trim()]),
  );
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  const expected = hmacSha256(secret, `${parts.t}.${payloadString}`);
  return timingSafeEqual(expected, parts.v1);
}

/** Short-lived signed tokens for public media URLs. */
export function signMediaToken(secret, assetId, expiresAt) {
  return hmacSha256(secret, `${assetId}.${expiresAt}`);
}

export function verifyMediaToken(secret, assetId, expiresAt, token) {
  if (Number(expiresAt) < Math.floor(Date.now() / 1000)) return false;
  return timingSafeEqual(signMediaToken(secret, assetId, expiresAt), token);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const check = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), 64);
  return timingSafeEqual(check.toString('base64url'), hash);
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('base64url')}`;
}

export function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
