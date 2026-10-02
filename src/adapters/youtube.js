import { AdapterError } from '../lib/errors.js';
import { BaseAdapter, chunkedPut, truncate } from './base.js';

const API_BASE = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CATEGORY_DEFAULT = '22'; // People & Blogs

/**
 * YouTube Data API v3 — resumable upload.
 * https://developers.google.com/youtube/v3/docs/videos/insert
 */
export class YouTubeAdapter extends BaseAdapter {
  static id = 'youtube';
  static label = 'YouTube';
  static scopes = ['https://www.googleapis.com/auth/youtube.upload'];

  async publish(ctx) {
    const { transport, credentials, asset, target, job, log } = ctx;
    this.requireCredentials(credentials, 'a connected YouTube account');

    const params = target.params || {};
    const isShorts = params.format === 'shorts';
    const snippet = {
      title: truncate(params.title ?? job.title ?? 'Untitled', 100),
      description: truncate(params.description ?? job.description ?? '', 5000),
      tags: (params.tags ?? job.tags ?? []).slice(0, 20),
      categoryId: String(params.categoryId ?? CATEGORY_DEFAULT),
    };
    const body = {
      snippet,
      status: {
        privacyStatus: mapVisibility(params.visibility ?? job.visibility),
        selfDeclaredMadeForKids: Boolean(params.madeForKids),
        ...(params.publishAt ? { publishAt: params.publishAt } : {}),
      },
    };
    if (isShorts) body.snippet.description = `${snippet.description}\n#Shorts`.trim();

    log('requesting resumable upload session');
    const init = await transport.request({
      method: 'POST',
      url: API_BASE,
      query: { uploadType: 'resumable', part: 'snippet,status' },
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': asset.mime || 'video/mp4',
        'x-upload-content-length': String(asset.size),
      },
      json: body,
    });

    if (!init.ok) {
      throw new AdapterError(`YouTube rejected the upload request (HTTP ${init.status}): ${init.text().slice(0, 400)}`, {
        code: 'youtube_init_failed',
        status: init.status,
        retryable: init.status >= 500 || init.status === 429,
      });
    }

    const location = init.headers.get('location');
    if (!location) {
      throw new AdapterError('YouTube did not return a resumable upload URL', { code: 'youtube_no_location', retryable: false });
    }

    const result = await chunkedPut({
      transport,
      uploadUrl: location,
      filePath: asset.path,
      totalBytes: asset.size,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': asset.mime || 'video/mp4',
      },
      log: (m) => log(`youtube ${m}`),
    });

    const payload = result.json;
    const videoId = payload?.id;
    if (!videoId) {
      throw new AdapterError(`YouTube upload finished but returned no video id (${result.text.slice(0, 300)})`, {
        code: 'youtube_no_id',
        retryable: false,
      });
    }
    return {
      externalId: videoId,
      externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      state: 'published',
      detail: { kind: payload?.kind, snippet: payload?.snippet, status: payload?.status, shorts: isShorts },
    };
  }
}

function mapVisibility(visibility) {
  switch (visibility) {
    case 'public':
      return 'public';
    case 'unlisted':
      return 'unlisted';
    default:
      return 'private';
  }
}

export default YouTubeAdapter;
