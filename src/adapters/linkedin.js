import { AdapterError } from '../lib/errors.js';
import { BaseAdapter, truncate } from './base.js';
import { readRange } from '../lib/http.js';

const API_BASE = 'https://api.linkedin.com/v2/rest';
const LINKEDIN_VERSION = '202506';

/**
 * LinkedIn video post: registerUpload -> PUT bytes -> create post.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 */
export class LinkedInAdapter extends BaseAdapter {
  static id = 'linkedin';
  static label = 'LinkedIn';
  static scopes = ['w_member_social', 'openid', 'profile'];

  async publish(ctx) {
    const { transport, credentials, asset, target, job, log } = ctx;
    this.requireCredentials(credentials, 'a connected LinkedIn profile');

    const params = target.params || {};
    const personId = credentials.accountId || credentials.meta?.personId;
    const author = params.organization
      ? `urn:li:organization:${params.organization}`
      : `urn:li:person:${personId}`;
    if (!params.organization && !personId) {
      throw new AdapterError('No LinkedIn person id on this connection — reconnect through /oauth/linkedin/start', {
        code: 'linkedin_no_person',
        retryable: false,
      });
    }

    const headers = {
      authorization: `Bearer ${credentials.accessToken}`,
      'content-type': 'application/json',
      'linkedin-version': LINKEDIN_VERSION,
      'x-restli-protocol-version': '2.0.0',
    };

    log('registering upload');
    const register = await transport.request({
      method: 'POST',
      url: `${API_BASE}/videos`,
      query: { action: 'registerUpload' },
      headers,
      json: {
        registerUploadRequest: {
          owner: author,
          mediaType: 'VIDEO',
          fileSize: asset.size,
          uploadCaptions: false,
        },
      },
    });
    const registerJson = register.json() ?? {};
    const videoUrn = registerJson.value?.video;
    const instructions = registerJson.value?.uploadInstructions ?? [];
    if (!register.ok || !videoUrn || !instructions.length) {
      throw new AdapterError(`LinkedIn registerUpload failed (HTTP ${register.status}): ${register.text().slice(0, 300)}`, {
        code: 'linkedin_register_failed',
        status: register.status,
        retryable: register.status >= 500 || register.status === 429,
      });
    }

    for (const instruction of instructions) {
      const first = instruction.firstByte ?? 0;
      const last = instruction.lastByte ?? asset.size - 1;
      if (first >= asset.size) continue;
      const chunk = readRange(asset.path, first, Math.min(last, asset.size - 1));
      const put = await transport.request({
        method: 'PUT',
        url: instruction.uploadUrl,
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          'content-type': 'application/octet-stream',
          'content-length': String(chunk.length),
        },
        body: chunk,
        timeoutMs: 600_000,
      });
      if (!put.ok) {
        throw new AdapterError(`LinkedIn upload chunk failed (HTTP ${put.status}): ${put.text().slice(0, 300)}`, {
          code: 'linkedin_upload_failed',
          status: put.status,
        });
      }
      log(`uploaded bytes ${first}-${Math.min(last, asset.size - 1)}`);
    }

    const post = await transport.request({
      method: 'POST',
      url: `${API_BASE}/posts`,
      headers,
      json: {
        author,
        commentary: truncate(params.title ?? job.title ?? '', 3000),
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': params.visibility ?? 'PUBLIC' },
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: {
          media: {
            id: videoUrn,
            title: truncate(params.title ?? job.title ?? '', 200),
            ...(params.description ?? job.description ? { description: truncate(params.description ?? job.description, 200) } : {}),
          },
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
    });
    const postJson = post.json() ?? {};
    const postId = post.headers.get('x-restli-id') ?? postJson.id;
    if (!post.ok || !postId) {
      throw new AdapterError(`LinkedIn post creation failed (HTTP ${post.status}): ${post.text().slice(0, 300)}`, {
        code: 'linkedin_post_failed',
        status: post.status,
        retryable: post.status >= 500 || post.status === 429,
      });
    }

    return {
      externalId: postId,
      externalUrl: postJson.id ? `https://www.linkedin.com/feed/update/${postJson.id}` : null,
      state: 'published',
      detail: { videoUrn },
    };
  }
}

export default LinkedInAdapter;
