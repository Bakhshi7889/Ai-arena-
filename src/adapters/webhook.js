import { AdapterError } from '../lib/errors.js';
import { BaseAdapter } from './base.js';
import { hmacSha256 } from '../lib/crypto.js';

/**
 * "Any website" destination: POST the finished post to an arbitrary endpoint
 * with an HMAC signature, so a third-party site can ingest the video itself.
 */
export class WebhookAdapter extends BaseAdapter {
  static id = 'webhook';
  static label = 'Custom webhook';
  static scopes = [];

  async publish(ctx) {
    const { transport, target, job, asset, log } = ctx;
    const url = target.params?.url;
    if (!url) throw new AdapterError('webhook target needs params.url', { retryable: false });

    const payload = {
      event: 'poster.video.ready',
      jobId: job.id,
      title: job.title,
      description: job.description,
      tags: job.tags,
      visibility: job.visibility,
      video: {
        url: asset.publicUrl,
        mimeType: asset.mime,
        bytes: asset.size,
        durationMs: asset.durationMs ?? null,
        width: asset.width ?? null,
        height: asset.height ?? null,
      },
      createdAt: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    const signingSecret = target.params?.secret || ctx.config.secret;
    const signature = hmacSha256(signingSecret, body);

    log(`POST ${url}`);
    const res = await transport.request({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'posterly/0.1',
        'x-poster-signature': `sha256=${signature}`,
        'x-poster-event': 'poster.video.ready',
        'x-poster-delivery': target.id,
      },
      body,
    });

    if (!res.ok) {
      throw new AdapterError(`Webhook returned HTTP ${res.status}: ${res.text().slice(0, 300)}`, {
        code: 'webhook_failed',
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }

    return {
      externalId: target.id,
      externalUrl: url,
      state: 'published',
      detail: { deliveredTo: url, signature: `sha256=${signature}` },
    };
  }
}

export default WebhookAdapter;
