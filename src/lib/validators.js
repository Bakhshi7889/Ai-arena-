import { z } from 'zod';
import { PUBLISHABLE } from '../adapters/registry.js';

const visibility = z.enum(['public', 'unlisted', 'private']).default('private');

const targetSchema = z
  .union([
    z.string(),
    z.object({
      platform: z.string(),
      format: z.string().optional(),
      title: z.string().max(500).optional(),
      description: z.string().max(5000).optional(),
      visibility: visibility.optional(),
      tags: z.array(z.string().max(60)).max(30).optional(),
      categoryId: z.union([z.string(), z.number()]).optional(),
      privacyLevel: z.string().optional(),
      shareToFeed: z.boolean().optional(),
      organization: z.union([z.string(), z.number()]).optional(),
      mediaCategory: z.string().optional(),
      replyTo: z.string().optional(),
      url: z.string().url().optional(),
      secret: z.string().optional(),
      publishAt: z.string().optional(),
      pullFromUrl: z.boolean().optional(),
      disableDuet: z.boolean().optional(),
      disableComment: z.boolean().optional(),
      disableStitch: z.boolean().optional(),
      coverTimestampMs: z.number().int().optional(),
      coverUrl: z.string().url().optional(),
      locationId: z.string().optional(),
      published: z.boolean().optional(),
    }),
  ])
  .transform((value) => (typeof value === 'string' ? { platform: value } : value));

export const createPostSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().max(60)).max(30).default([]),
    visibility,
    /** Either shorthand strings ("tiktok") or objects with per-target overrides. */
    targets: z.array(targetSchema).min(1).max(20),
    videoUrl: z.string().url().optional(),
    scheduledAt: z.coerce.date().optional(),
    callbackUrl: z.string().url().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    /** Accepted alias so callers can write `platforms` instead of `targets`. */
    platforms: z.array(targetSchema).optional(),
  })
  .transform((v) => {
    const targets = v.targets?.length ? v.targets : (v.platforms ?? []);
    return { ...v, targets };
  });

/**
 * Validate a create-post payload. The "either a file or a URL" rule lives here
 * rather than in a `.refine()`, because zod strips undeclared keys (like
 * `hasFile`) before refinements run.
 */
export function validateCreatePost(input, { hasFile = false } = {}) {
  const result = createPostSchema.safeParse(input);
  if (!result.success) return result;
  if (!hasFile && !result.data.videoUrl) {
    return {
      success: false,
      error: {
        issues: [
          {
            path: ['videoUrl'],
            message: 'Provide either a video file (multipart field "video") or a videoUrl',
          },
        ],
      },
    };
  }
  return result;
}

export function assertKnownTargets(targets) {
  const unknown = targets.map((t) => t.platform).filter((p) => !PUBLISHABLE.includes(p));
  if (unknown.length) {
    const err = new Error(
      `Unknown platform(s): ${[...new Set(unknown)].join(', ')}. Supported: ${PUBLISHABLE.join(', ')}`,
    );
    err.status = 400;
    err.code = 'unknown_platform';
    throw err;
  }
  const dupes = targets.map((t) => t.platform).filter((p, i, arr) => arr.indexOf(p) !== i);
  if (dupes.length) {
    const err = new Error(`Duplicate platform in request: ${[...new Set(dupes)].join(', ')}`);
    err.status = 400;
    err.code = 'duplicate_platform';
    throw err;
  }
}

export const createKeySchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(['publish', 'read', 'admin'])).default(['publish', 'read']),
  allowedOrigins: z.array(z.string().max(200)).default([]),
});

export const pasteTokenSchema = z.object({
  provider: z.enum(['youtube', 'tiktok', 'facebook', 'instagram', 'x', 'linkedin']),
  accessToken: z.string().min(8),
  refreshToken: z.string().optional(),
  expiresAt: z.coerce.number().optional(),
  accountId: z.string().optional(),
  displayName: z.string().max(120).optional(),
  meta: z.record(z.any()).default({}),
  sandbox: z.boolean().default(false),
});
