import { AdapterError } from '../lib/errors.js';
import { BaseAdapter, CHUNK_SIZE, chunkedPut, pollUntil, truncate } from './base.js';

const API_BASE = 'https://open.tiktokapis.com/v2';

/**
 * TikTok Content Posting API.
 * https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 */
export class TikTokAdapter extends BaseAdapter {
  static id = 'tiktok';
  static label = 'TikTok';
  static scopes = ['video.publish', 'video.upload', 'user.info.basic'];

  constructor(opts = {}) {
    super(opts);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async publish(ctx) {
    const { transport, credentials, asset, target, job, log } = ctx;
    this.requireCredentials(credentials, 'a connected TikTok account');

    const params = target.params || {};
    const title = truncate([params.title ?? job.title, ...(params.tags ?? job.tags ?? []).map((t) => `#${t.replace(/\s+/g, '')}`)]
      .filter(Boolean)
      .join(' '), 2200);

    const usePull = Boolean(params.pullFromUrl && asset.publicUrl);
    const source = usePull ? 'PULL_FROM_URL' : 'FILE_UPLOAD';
    const chunkSize = Math.min(CHUNK_SIZE, asset.size);
    const totalChunks = Math.max(1, Math.ceil(asset.size / chunkSize));

    log(`initialising ${source} post`);
    const init = await transport.request({
      method: 'POST',
      url: `${API_BASE}/post/publish/video/init/`,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      json: {
        post_info: {
          title,
          privacy_level: params.privacyLevel ?? (job.visibility === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY'),
          disable_duet: Boolean(params.disableDuet),
          disable_comment: Boolean(params.disableComment),
          disable_stitch: Boolean(params.disableStitch),
          video_cover_timestamp_ms: params.coverTimestampMs ?? 1000,
        },
        source_info: {
          source,
          video_size: asset.size,
          chunk_size: usePull ? asset.size : chunkSize,
          total_chunk_count: usePull ? 1 : totalChunks,
          ...(usePull ? { video_url: asset.publicUrl } : {}),
        },
      },
    });

    const initJson = init.json() ?? {};
    if (!init.ok || initJson.error?.code !== 'ok') {
      throw new AdapterError(
        `TikTok publish init failed (HTTP ${init.status}): ${initJson.error?.message ?? init.text().slice(0, 300)}`,
        { code: `tiktok_${initJson.error?.code ?? 'init_failed'}`, status: init.status },
      );
    }

    const { publish_id: publishId, upload_url: uploadUrl } = initJson.data ?? {};
    if (!publishId) throw new AdapterError('TikTok did not return a publish_id', { code: 'tiktok_no_publish_id', retryable: false });

    if (!usePull) {
      if (!uploadUrl) throw new AdapterError('TikTok did not return an upload_url', { code: 'tiktok_no_upload_url', retryable: false });
      await chunkedPut({
        transport,
        uploadUrl,
        filePath: asset.path,
        totalBytes: asset.size,
        chunkSize,
        headers: { 'content-type': 'video/mp4' },
        log: (m) => log(`tiktok ${m}`),
      });
    }

    const finalState = await pollUntil({
      fn: () =>
        transport.request({
          method: 'POST',
          url: `${API_BASE}/post/publish/status/fetch/`,
          headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
          json: { publish_id: publishId },
        }),
      shouldContinue: (res) => {
        const status = res.json()?.data?.status;
        return status === 'PROCESSING_UPLOAD' || status === 'PROCESSING_DOWNLOAD' || status === 'SENDING_TO_USER_FEED';
      },
      intervalMs: ctx.pollIntervalMs ?? 3000,
      timeoutMs: ctx.pollTimeoutMs ?? 120_000,
      sleep: this.sleep,
      log: (m) => log(`tiktok ${m}`),
    });

    const status = finalState.json()?.data?.status;
    if (status === 'FAILED') {
      throw new AdapterError(`TikTok rejected the video: ${JSON.stringify(finalState.json()?.data?.fail_reason ?? {})}`, {
        code: 'tiktok_publish_failed',
        retryable: false,
      });
    }

    return {
      externalId: publishId,
      externalUrl: null,
      state: status === 'PUBLISH_COMPLETE' ? 'published' : 'processing',
      detail: { publishId, status },
    };
  }
}

export default TikTokAdapter;
