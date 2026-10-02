import { AdapterError } from '../lib/errors.js';
import { BaseAdapter, pollUntil, truncate } from './base.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Instagram Reels via the Instagram Graph API.
 * Reels are ingested by URL, so the asset must be publicly downloadable.
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
export class InstagramAdapter extends BaseAdapter {
  static id = 'instagram';
  static label = 'Instagram Reels';
  static scopes = ['instagram_content_publish', 'pages_show_list', 'pages_read_engagement'];

  constructor(opts = {}) {
    super(opts);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async publish(ctx) {
    const { transport, credentials, asset, target, job, log } = ctx;
    this.requireCredentials(credentials, 'a connected Instagram Business account');

    const igUserId = credentials.accountId || credentials.meta?.instagramAccountId;
    if (!igUserId) {
      throw new AdapterError('No Instagram account id on this connection — reconnect through /oauth/instagram/start', {
        code: 'instagram_no_account',
        retryable: false,
      });
    }
    if (!asset.publicUrl) {
      throw new AdapterError('Instagram requires a publicly reachable video URL (set PUBLIC_BASE_URL)', {
        code: 'instagram_no_public_url',
        retryable: false,
      });
    }

    const params = target.params || {};
    const caption = truncate([params.title ?? job.title, params.description ?? job.description]
      .filter(Boolean)
      .join('\n\n'), 2200);

    log('creating Reels container');
    const create = await transport.request({
      method: 'POST',
      url: `${GRAPH_BASE}/${igUserId}/media`,
      form: {
        media_type: 'REELS',
        video_url: asset.publicUrl,
        caption,
        share_to_feed: params.shareToFeed === false ? 'false' : 'true',
        ...(params.coverUrl ? { cover_url: params.coverUrl } : {}),
        ...(params.locationId ? { location_id: params.locationId } : {}),
        access_token: credentials.accessToken,
      },
    });

    const createJson = create.json() ?? {};
    if (!create.ok || !createJson.id) {
      throw new AdapterError(`Instagram container creation failed (HTTP ${create.status}): ${JSON.stringify(createJson.error ?? create.text()).slice(0, 400)}`, {
        code: 'instagram_create_failed',
        status: create.status,
        retryable: create.status >= 500 || create.status === 429,
      });
    }
    const creationId = createJson.id;

    const processed = await pollUntil({
      fn: () =>
        transport.request({
          method: 'GET',
          url: `${GRAPH_BASE}/${creationId}`,
          query: { fields: 'status_code,status', access_token: credentials.accessToken },
        }),
      shouldContinue: (res) => res.json()?.status_code === 'IN_PROGRESS',
      intervalMs: ctx.pollIntervalMs ?? 3000,
      timeoutMs: ctx.pollTimeoutMs ?? 180_000,
      sleep: this.sleep,
      log: (m) => log(`instagram ${m}`),
    });

    const statusCode = processed.json()?.status_code;
    if (statusCode && statusCode !== 'FINISHED') {
      throw new AdapterError(`Instagram could not process the video (status ${statusCode})`, {
        code: 'instagram_processing_failed',
        retryable: false,
      });
    }

    log('publishing Reel');
    const publish = await transport.request({
      method: 'POST',
      url: `${GRAPH_BASE}/${igUserId}/media_publish`,
      form: { creation_id: creationId, access_token: credentials.accessToken },
    });
    const publishJson = publish.json() ?? {};
    if (!publish.ok || !publishJson.id) {
      throw new AdapterError(`Instagram publish failed (HTTP ${publish.status}): ${JSON.stringify(publishJson.error ?? publish.text()).slice(0, 400)}`, {
        code: 'instagram_publish_failed',
        status: publish.status,
      });
    }

    return {
      externalId: publishJson.id,
      externalUrl: `https://www.instagram.com/reel/${publishJson.id}/`,
      state: 'published',
      detail: { creationId, statusCode },
    };
  }
}

export default InstagramAdapter;
