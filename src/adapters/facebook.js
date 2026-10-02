import fs from 'node:fs';
import { AdapterError } from '../lib/errors.js';
import { BaseAdapter, pollUntil, truncate } from './base.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Facebook Page video upload via the Graph API.
 * Uses `file_url` when a public URL exists (no egress from this box), and
 * falls back to a multipart `source` upload otherwise.
 * https://developers.facebook.com/docs/graph-api/reference/page/videos/
 */
export class FacebookAdapter extends BaseAdapter {
  static id = 'facebook';
  static label = 'Facebook Page';
  static scopes = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'];

  constructor(opts = {}) {
    super(opts);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async publish(ctx) {
    const { transport, credentials, asset, target, job, log } = ctx;
    this.requireCredentials(credentials, 'a connected Facebook Page');

    const pageId = credentials.accountId || credentials.meta?.pageId;
    if (!pageId) {
      throw new AdapterError('No Facebook Page id on this connection — reconnect through /oauth/facebook/start', {
        code: 'facebook_no_page',
        retryable: false,
      });
    }

    const params = target.params || {};
    const common = {
      title: truncate(params.title ?? job.title ?? '', 255),
      description: truncate(params.description ?? job.description ?? '', 5000),
      published: params.published === false ? 'false' : 'true',
      access_token: credentials.accessToken,
      ...(params.scheduledAt ? { published: 'false', scheduled_publish_time: String(Math.floor(new Date(params.scheduledAt).getTime() / 1000)) } : {}),
    };

    log(asset.publicUrl ? 'uploading by file_url' : 'uploading file as multipart');
    const upload = asset.publicUrl
      ? await transport.request({
          method: 'POST',
          url: `${GRAPH_BASE}/${pageId}/videos`,
          form: { ...common, file_url: asset.publicUrl },
        })
      : await transport.request({
          method: 'POST',
          url: `${GRAPH_BASE}/${pageId}/videos`,
          multipart: {
            ...common,
            source: { buffer: fs.readFileSync(asset.path), contentType: asset.mime || 'video/mp4', filename: 'video.mp4' },
          },
          timeoutMs: 600_000,
        });

    const uploadJson = upload.json() ?? {};
    if (!upload.ok || !uploadJson.id) {
      throw new AdapterError(`Facebook upload failed (HTTP ${upload.status}): ${JSON.stringify(uploadJson.error ?? upload.text()).slice(0, 400)}`, {
        code: 'facebook_upload_failed',
        status: upload.status,
        retryable: upload.status >= 500 || upload.status === 429,
      });
    }

    const videoId = uploadJson.id;
    const status = await pollUntil({
      fn: () =>
        transport.request({
          method: 'GET',
          url: `${GRAPH_BASE}/${videoId}`,
          query: { fields: 'status,permalink_url', access_token: credentials.accessToken },
        }),
      shouldContinue: (res) => {
        const value = res.json()?.status?.values?.[0]?.value;
        return value === 'uploading' || value === 'processing';
      },
      intervalMs: ctx.pollIntervalMs ?? 3000,
      timeoutMs: ctx.pollTimeoutMs ?? 180_000,
      sleep: this.sleep,
      log: (m) => log(`facebook ${m}`),
    });

    const finalValue = status.json()?.status?.values?.[0]?.value;
    if (finalValue && finalValue !== 'ready') {
      throw new AdapterError(`Facebook video is not ready (status: ${finalValue})`, {
        code: 'facebook_not_ready',
        retryable: false,
      });
    }

    return {
      externalId: videoId,
      externalUrl: status.json()?.permalink_url ?? `https://www.facebook.com/${pageId}/videos/${videoId}/`,
      state: 'published',
      detail: { pageId, status: finalValue ?? 'ready' },
    };
  }
}

export default FacebookAdapter;
