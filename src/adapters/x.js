import { AdapterError } from '../lib/errors.js';
import { BaseAdapter, CHUNK_SIZE, pollUntil, truncate } from './base.js';
import { readRange } from '../lib/http.js';

const MEDIA_ENDPOINT = 'https://api.x.com/2/media/upload';
const TWEET_ENDPOINT = 'https://api.x.com/2/tweets';

/**
 * X (Twitter) API v2 — chunked media upload followed by a post.
 * https://docs.x.com/x-api/media/media-upload
 */
export class XAdapter extends BaseAdapter {
  static id = 'x';
  static label = 'X (Twitter)';
  static scopes = ['tweet.write', 'users.read', 'offline.access', 'media.write'];

  constructor(opts = {}) {
    super(opts);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async publish(ctx) {
    const { transport, credentials, asset, target, job, log } = ctx;
    this.requireCredentials(credentials, 'a connected X account');

    const params = target.params || {};
    const auth = { authorization: `Bearer ${credentials.accessToken}` };
    const mimeType = asset.mime || 'video/mp4';

    log('INIT media upload');
    const init = await transport.request({
      method: 'POST',
      url: MEDIA_ENDPOINT,
      headers: auth,
      form: {
        command: 'INIT',
        media_type: mimeType,
        total_bytes: String(asset.size),
        media_category: params.mediaCategory ?? 'tweet_video',
      },
    });
    const initJson = init.json() ?? {};
    const mediaId = initJson.data?.id ?? initJson.media_id_string;
    if (!init.ok || !mediaId) {
      throw new AdapterError(`X media INIT failed (HTTP ${init.status}): ${init.text().slice(0, 300)}`, {
        code: 'x_init_failed',
        status: init.status,
        retryable: init.status >= 500 || init.status === 429,
      });
    }

    let segmentIndex = 0;
    for (let start = 0; start < asset.size; start += CHUNK_SIZE, segmentIndex += 1) {
      const end = Math.min(start + CHUNK_SIZE, asset.size);
      const chunk = readRange(asset.path, start, end - 1);
      const append = await transport.request({
        method: 'POST',
        url: MEDIA_ENDPOINT,
        headers: auth,
        multipart: {
          command: 'APPEND',
          media_id: mediaId,
          segment_index: String(segmentIndex),
          media: { buffer: chunk, contentType: 'application/octet-stream', filename: `chunk-${segmentIndex}` },
        },
      });
      if (!append.ok && append.status !== 204) {
        throw new AdapterError(`X media APPEND segment ${segmentIndex} failed (HTTP ${append.status}): ${append.text().slice(0, 300)}`, {
          code: 'x_append_failed',
          status: append.status,
        });
      }
      log(`appended segment ${segmentIndex} (${chunk.length} bytes)`);
    }

    log('FINALIZE media upload');
    const finalize = await transport.request({
      method: 'POST',
      url: MEDIA_ENDPOINT,
      headers: auth,
      form: { command: 'FINALIZE', media_id: mediaId },
    });
    const finalizeJson = finalize.json() ?? {};
    if (!finalize.ok) {
      throw new AdapterError(`X media FINALIZE failed (HTTP ${finalize.status}): ${finalize.text().slice(0, 300)}`, {
        code: 'x_finalize_failed',
        status: finalize.status,
      });
    }

    const processing = finalizeJson.data?.processing_info ?? finalizeJson.processing_info;
    if (processing?.state && processing.state !== 'succeeded') {
      await pollUntil({
        fn: () =>
          transport.request({
            method: 'GET',
            url: MEDIA_ENDPOINT,
            query: { command: 'STATUS', media_id: mediaId },
            headers: auth,
          }),
        shouldContinue: (res) => {
          const state = res.json()?.data?.processing_info?.state;
          return state === 'pending' || state === 'in_progress';
        },
        intervalMs: (processing?.check_after_secs ?? 5) * 1000,
        timeoutMs: ctx.pollTimeoutMs ?? 180_000,
        sleep: this.sleep,
        log: (m) => log(`x ${m}`),
      });
    }

    const text = truncate(params.title ?? job.title ?? '', 280) || 'New video';
    const tweet = await transport.request({
      method: 'POST',
      url: TWEET_ENDPOINT,
      headers: { ...auth, 'content-type': 'application/json' },
      json: {
        text,
        media: { media_ids: [mediaId] },
        ...(params.replyTo ? { reply: { in_reply_to_tweet_id: params.replyTo } } : {}),
      },
    });
    const tweetJson = tweet.json() ?? {};
    const tweetId = tweetJson.data?.id;
    if (!tweet.ok || !tweetId) {
      throw new AdapterError(`X post creation failed (HTTP ${tweet.status}): ${tweet.text().slice(0, 300)}`, {
        code: 'x_tweet_failed',
        status: tweet.status,
        retryable: tweet.status >= 500 || tweet.status === 429,
      });
    }

    return {
      externalId: tweetId,
      externalUrl: `https://x.com/i/web/status/${tweetId}`,
      state: 'published',
      detail: { mediaId, processing: processing?.state ?? 'succeeded' },
    };
  }
}

export default XAdapter;
