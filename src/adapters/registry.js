import { YouTubeAdapter } from './youtube.js';
import { TikTokAdapter } from './tiktok.js';
import { InstagramAdapter } from './instagram.js';
import { FacebookAdapter } from './facebook.js';
import { XAdapter } from './x.js';
import { LinkedInAdapter } from './linkedin.js';
import { WebhookAdapter } from './webhook.js';
import { PLATFORMS } from '../media/specs.js';

export const ADAPTERS = {
  youtube: YouTubeAdapter,
  tiktok: TikTokAdapter,
  instagram: InstagramAdapter,
  facebook: FacebookAdapter,
  x: XAdapter,
  linkedin: LinkedInAdapter,
  webhook: WebhookAdapter,
};

/** Platforms a caller can name in `platforms: [...]`. */
export const PUBLISHABLE = Object.keys(PLATFORMS);

export function createAdapter(provider, { transport, config, sleep } = {}) {
  const Klass = ADAPTERS[provider];
  if (!Klass) return null;
  return new Klass({ transport, config, sleep });
}

export function adapterMeta() {
  return Object.entries(ADAPTERS).map(([id, Klass]) => ({
    id,
    label: Klass.label,
    scopes: Klass.scopes,
    color: PLATFORMS[id]?.color ?? '#64748b',
    formats: Object.entries(PLATFORMS[id]?.formats ?? {}).map(([key, f]) => ({
      id: key,
      label: f.label,
      aspect: f.aspect,
      maxDurationSec: f.maxDurationSec,
      maxSizeMb: f.maxSizeMb,
    })),
    requiresPublicUrl: Boolean(PLATFORMS[id]?.requiresPublicUrl),
  }));
}
