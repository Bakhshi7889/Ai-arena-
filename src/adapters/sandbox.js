import { SandboxTransport } from '../lib/http.js';

const rid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Simulated responses for every platform API Posterly talks to. Used when a
 * connection has no real credentials (POSTER_SANDBOX=auto) and by the test
 * suite, so request construction is exercised even without API access.
 *
 * The route table intentionally mirrors the real endpoints one-for-one.
 */
export function createSandboxRoutes({ catchAll = false, publishDelay = 0 } = {}) {
  const state = { tiktokPolls: 0, youtubeSessions: new Map() };

  const routes = [
    // --- YouTube: resumable session, then a single PUT ----------------------
    {
      method: 'POST',
      urlPattern: 'googleapis.com/upload/youtube/v3/videos',
      handler: async ({ json }) => {
        const uploadId = rid('ses');
        state.youtubeSessions.set(uploadId, json ?? {});
        return {
          status: 200,
          headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=${uploadId}` },
          body: '',
        };
      },
    },
    {
      method: 'PUT',
      urlPattern: 'googleapis.com/upload/youtube/v3/videos',
      handler: async ({ url }) => {
        // Echo back the snippet/status that the resumable session was opened with.
        const uploadId = new URL(url).searchParams.get('upload_id');
        const meta = state.youtubeSessions.get(uploadId) ?? {};
        const id = rid('sbx_yt');
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'youtube#video',
            id,
            snippet: {
              title: meta.snippet?.title ?? null,
              description: meta.snippet?.description ?? null,
              tags: meta.snippet?.tags ?? [],
              categoryId: meta.snippet?.categoryId ?? null,
            },
            status: {
              uploadStatus: 'processed',
              privacyStatus: meta.status?.privacyStatus ?? 'private',
              madeForKids: Boolean(meta.status?.selfDeclaredMadeForKids),
            },
          }),
        };
      },
    },

    // --- TikTok -------------------------------------------------------------
    {
      method: 'POST',
      urlPattern: '/post/publish/video/init/',
      handler: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: { publish_id: rid('sbx_tt'), upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=sandbox' },
          error: { code: 'ok', message: '', log_id: rid('log') },
        }),
      }),
    },
    {
      method: 'PUT',
      urlPattern: 'open-upload.tiktokapis.com',
      handler: async () => ({ status: 201, headers: {}, body: '' }),
    },
    {
      method: 'POST',
      urlPattern: '/post/publish/status/fetch/',
      handler: async () => {
        state.tiktokPolls += 1;
        const complete = publishDelay === 0 || state.tiktokPolls > publishDelay;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            data: {
              status: complete ? 'PUBLISH_COMPLETE' : 'PROCESSING_UPLOAD',
              publicaly_available_post_id: complete ? [rid('post')] : undefined,
            },
            error: { code: 'ok', message: '', log_id: rid('log') },
          }),
        };
      },
    },

    // --- Instagram / Facebook (both live on graph.facebook.com) -------------
    {
      method: 'POST',
      urlPattern: /\/media_publish(\?|$)/,
      handler: async ({ form }) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: `sbx_ig_media_${form?.creation_id ?? rid('x')}` }),
      }),
    },
    {
      method: 'POST',
      urlPattern: /graph\.facebook\.com\/[^/]+\/[^/]+\/media(\?|$)/,
      handler: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: rid('sbx_ig_creation') }),
      }),
    },
    {
      method: 'POST',
      urlPattern: /graph\.facebook\.com\/.*\/videos(\?|$)/,
      handler: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: rid('sbx_fb_video') }),
      }),
    },
    {
      method: 'GET',
      urlPattern: /graph\.facebook\.com/,
      handler: async ({ url }) => {
        const instagram = url.includes('status_code');
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            instagram
              ? { status_code: 'FINISHED', status: 'Video is ready' }
              : { status: { video_status: 'ready', values: [{ value: 'ready', description: 'ready' }] }, permalink_url: 'https://www.facebook.com/watch/?v=sandbox' },
          ),
        };
      },
    },

    // --- X (Twitter) --------------------------------------------------------
    {
      method: 'POST',
      urlPattern: 'api.x.com/2/media/upload',
      handler: async ({ form, multipart }) => {
        if (form?.command === 'INIT') {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { id: rid('sbx_x_media'), media_key: rid('key'), expires_after_secs: 86400, size: Number(form.total_bytes) } }),
          };
        }
        if (multipart && 'media' in multipart) return { status: 204, headers: {}, body: '' };
        if (form?.command === 'FINALIZE') {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { id: form.media_id, processing_info: { state: 'succeeded', type: 'video' } } }),
          };
        }
        return { status: 400, headers: {}, body: JSON.stringify({ error: 'unsupported command' }) };
      },
    },
    {
      method: 'GET',
      urlPattern: 'api.x.com/2/media/upload',
      handler: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { processing_info: { state: 'succeeded' } } }),
      }),
    },
    {
      method: 'POST',
      urlPattern: 'api.x.com/2/tweets',
      handler: async ({ json }) => ({
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { id: rid('sbx_x_tweet'), text: json?.text ?? '' } }),
      }),
    },

    // --- LinkedIn -----------------------------------------------------------
    {
      method: 'POST',
      urlPattern: 'api.linkedin.com/v2/rest/videos',
      handler: async ({ json }) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          value: {
            video: rid('urn:li:video:'),
            uploadInstructions: [
              {
                uploadUrl: 'https://api.linkedin.com/mediaUpload/sandbox',
                firstByte: 0,
                lastByte: (json?.registerUploadRequest?.fileSize ?? 1) - 1,
              },
            ],
            uploadToken: rid('token'),
          },
        }),
      }),
    },
    {
      method: 'PUT',
      urlPattern: 'api.linkedin.com/mediaUpload',
      handler: async () => ({ status: 201, headers: {}, body: '' }),
    },
    {
      method: 'POST',
      urlPattern: 'api.linkedin.com/v2/rest/posts',
      handler: async () => ({
        status: 201,
        headers: { 'content-type': 'application/json', 'x-restli-id': rid('urn:li:share:') },
        body: JSON.stringify({ id: rid('urn:li:share:') }),
      }),
    },
  ];

  if (catchAll) {
    routes.push({
      method: 'POST',
      urlPattern: /.*/,
      handler: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, sandbox: true }),
      }),
    });
  }

  return { routes, state };
}

export function createSandboxTransport(options = {}) {
  const { routes } = createSandboxRoutes(options);
  return new SandboxTransport({ routes });
}
