/**
 * Per-network publishing requirements. Values follow the public platform
 * documentation as of 2025; they are used for validation and to pick the
 * transcode variant each network receives.
 */
export const PLATFORMS = {
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    color: '#ff0000',
    auth: 'oauth2',
    formats: {
      standard: { label: 'Video', aspect: 'any', maxDurationSec: 43_200, maxSizeMb: 256_000 },
      shorts: { label: 'Shorts', aspect: '9:16', maxDurationSec: 180, maxSizeMb: 256_000 },
    },
    defaultFormat: 'standard',
    preferred: { width: 1920, height: 1080, videoBitrateK: 8000, audioBitrateK: 192, fps: 30 },
    container: 'mp4',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    color: '#00f2ea',
    auth: 'oauth2',
    formats: {
      video: { label: 'Video', aspect: '9:16', maxDurationSec: 600, maxSizeMb: 4096 },
    },
    defaultFormat: 'video',
    preferred: { width: 1080, height: 1920, videoBitrateK: 6000, audioBitrateK: 128, fps: 30 },
    container: 'mp4',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram Reels',
    color: '#e1306c',
    auth: 'oauth2',
    formats: {
      reels: { label: 'Reels', aspect: '9:16', maxDurationSec: 180, maxSizeMb: 1024 },
    },
    defaultFormat: 'reels',
    preferred: { width: 1080, height: 1920, videoBitrateK: 6000, audioBitrateK: 128, fps: 30 },
    container: 'mp4',
    /** The Graph API ingests by URL, so the file must be publicly reachable. */
    requiresPublicUrl: true,
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook Page',
    color: '#1877f2',
    auth: 'oauth2',
    formats: {
      video: { label: 'Video', aspect: 'any', maxDurationSec: 14_400, maxSizeMb: 10_240 },
    },
    defaultFormat: 'video',
    preferred: { width: 1920, height: 1080, videoBitrateK: 6000, audioBitrateK: 128, fps: 30 },
    container: 'mp4',
    supportsFileUrl: true,
  },
  x: {
    id: 'x',
    label: 'X (Twitter)',
    color: '#111111',
    auth: 'oauth2',
    formats: {
      video: { label: 'Video', aspect: 'any', maxDurationSec: 140, maxSizeMb: 512 },
    },
    defaultFormat: 'video',
    preferred: { width: 1920, height: 1080, videoBitrateK: 5000, audioBitrateK: 128, fps: 30 },
    container: 'mp4',
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    color: '#0a66c2',
    auth: 'oauth2',
    formats: {
      video: { label: 'Video', aspect: 'any', maxDurationSec: 600, maxSizeMb: 200 },
    },
    defaultFormat: 'video',
    preferred: { width: 1920, height: 1080, videoBitrateK: 4000, audioBitrateK: 128, fps: 30 },
    container: 'mp4',
  },
  webhook: {
    id: 'webhook',
    label: 'Custom webhook',
    color: '#64748b',
    auth: 'none',
    formats: { raw: { label: 'Source file', aspect: 'any', maxDurationSec: Infinity, maxSizeMb: Infinity } },
    defaultFormat: 'raw',
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

export function getPlatform(id) {
  return PLATFORMS[id];
}

export function aspectRatio(width, height) {
  if (!width || !height) return null;
  return width / height;
}

const ASPECT_TARGETS = {
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
  any: null,
};

export function isAspectCompatible(source, required, tolerance = 0.06) {
  const target = ASPECT_TARGETS[required] ?? null;
  if (target === null) return true;
  if (!source) return false;
  return Math.abs(source - target) <= tolerance;
}
