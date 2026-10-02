# Posterly — one endpoint, every social network

Send a video to **one HTTP endpoint** and Posterly publishes it to YouTube, TikTok,
Instagram Reels, Facebook Pages, X and LinkedIn — with per-platform reframing,
retries, scheduling and signed webhooks back to your site.

```
your website ──POST /api/v1/posts──▶ Posterly ──▶ YouTube / TikTok / Instagram
     ▲                                                  Facebook / X / LinkedIn
     └──────────── signed webhook (job result) ─────────┘
```

* **Any website can call it** — plain REST + CORS, or a drop-in `<script>` widget.
* **Two ways to send video** — multipart upload, or a `videoUrl` Posterly downloads for you.
* **Per-platform variants** — 9:16 for Shorts/Reels/TikTok, 16:9 for the rest (when ffmpeg is present).
* **Self-hosted** — SQLite + local disk or S3. No third-party SaaS in the middle.
* **Sandbox mode** — exercise the entire pipeline against simulated platform APIs before you have API access.

---

## Quickstart

```bash
npm install
cp .env.example .env      # set POSTER_SECRET (openssl rand -hex 32)
npm start                 # API + worker + dashboard on :4000
```

Open the dashboard, sign in, create an **API key**, then:

```bash
curl -X POST http://localhost:4000/api/v1/posts \
  -H "X-API-Key: pst_live_…" \
  -F "video=@./clip.mp4" \
  -F "title=Our launch" \
  -F "tags=launch,product" \
  -F "visibility=public" \
  -F 'targets=["youtube","tiktok","instagram","facebook","x","linkedin"]'
```

Response `202 Accepted`:

```json
{
  "job": {
    "id": "job_mur8re7kb-uUsG0",
    "status": "queued",
    "targets": [
      { "provider": "youtube", "status": "queued" },
      { "provider": "tiktok",  "status": "queued" }
    ]
  }
}
```

Poll `GET /api/v1/posts/:id`, or pass a `callbackUrl` and Posterly POSTs the result to you.

---

## Connect it to any website

### Option 1 — embed the widget

```html
<script src="https://your-posterly.example.com/embed/poster.js"></script>
<div id="publisher"></div>
<script>
  Posterly.init({ apiKey: 'pst_live_…' });
  Posterly.mount('#publisher', { targets: ['youtube', 'tiktok', 'instagram'] });
</script>
```

`Posterly.mount()` renders a drag-and-drop publisher with upload progress.
For your own UI, use `Posterly.post({ video: file, title, targets })` (returns a Promise).

### Option 2 — call the API

```js
await fetch('https://your-posterly.example.com/api/v1/posts', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'pst_live_…' },
  body: JSON.stringify({
    title: 'Our launch',
    videoUrl: 'https://cdn.example.com/clip.mp4',   // Posterly downloads it
    targets: [{ platform: 'youtube', format: 'shorts' }, { platform: 'tiktok' }],
    scheduledAt: '2026-01-01T15:00:00Z',
    callbackUrl: 'https://yoursite.com/hooks/posterly',
  }),
});
```

Add your site's origin to `ALLOWED_ORIGINS` in `.env`.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/posts` | Create a publish job (multipart or JSON) |
| `GET` | `/api/v1/posts` | List jobs |
| `GET` | `/api/v1/posts/:id` | Job detail + event log |
| `POST` | `/api/v1/posts/:id/retry` | Re-run failed targets |
| `DELETE` | `/api/v1/posts/:id` | Delete a job |
| `GET` | `/api/v1/platforms` | Supported networks + connection state |
| `GET` | `/api/v1/health` | Liveness, driver, ffmpeg availability |
| `GET` | `/media/:key?exp&sig` | Signed, time-limited video URL |
| `GET` | `/oauth/:provider/start` | Begin OAuth for a network |

Auth: `X-API-Key: pst_live_…` (or `Authorization: Bearer`).
Idempotency: send `Idempotency-Key: <uuid>` — a repeat returns the original job with `"deduplicated": true`.

### Request body

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | required, ≤200 chars |
| `description` | string | ≤5000 |
| `tags` | string[] | ≤30 |
| `visibility` | `public`\|`unlisted`\|`private` | default `private` |
| `targets` | string[] \| object[] | `"tiktok"` or `{ platform, format, title, … }` |
| `videoUrl` | string | alternative to uploading a file |
| `scheduledAt` | ISO date | publish later |
| `callbackUrl` | string | where results are POSTed |

Per-target overrides include `format`, `title`, `description`, `tags`, `visibility`,
`categoryId` (YouTube), `privacyLevel` (TikTok), `shareToFeed` (Instagram),
`organization` (LinkedIn page), `url`/`secret` (webhook).

### Targets

`youtube` (formats `standard`, `shorts`) · `tiktok` · `instagram` · `facebook` · `x` ·
`linkedin` · `webhook` (post the finished video to any URL of yours).

---

## Connecting your socials

| Network | OAuth app | Scopes Posterly requests |
| --- | --- | --- |
| YouTube | Google Cloud Console → YouTube Data API v3 | `youtube.upload` |
| TikTok | TikTok for Developers → Content Posting API | `video.publish`, `video.upload`, `user.info.basic` |
| Facebook + Instagram | Meta for Developers (Page + IG Business account) | `pages_manage_posts`, `instagram_content_publish`, … |
| X | X Developer Portal (OAuth 2.0 user context) | `tweet.write`, `media.write`, `offline.access` |
| LinkedIn | LinkedIn Developers → "Share on LinkedIn" + OpenID | `w_member_social`, `openid`, `profile` |

Put the client id/secret in `.env`, restart, then click **Connect** in the dashboard
(Connections tab). Tokens are AES-256-GCM encrypted at rest with `POSTER_SECRET` and
refreshed automatically.

You can also paste a raw access token (Connections → *Paste an access token*) or add a
**sandbox connection** to run the full pipeline against simulated APIs.

> Instagram and Facebook Page publishing ingest the video **by URL**, so
> `PUBLIC_BASE_URL` must be reachable from the public internet.

---

## Receiving results

Posterly POSTs to your `callbackUrl`:

```json
{
  "event": "poster.job.completed",
  "jobId": "job_…",
  "status": "published",
  "targets": [
    { "provider": "youtube", "status": "published", "externalUrl": "https://www.youtube.com/watch?v=…" }
  ]
}
```

Verify the `X-Poster-Signature: t=<unix>,v1=<hmac>` header:

```js
const crypto = require('crypto');
const [t, v1] = req.get('X-Poster-Signature').split(',').map((s) => s.split('=')[1]);
const expected = crypto.createHmac('sha256', process.env.POSTER_SECRET)
  .update(`${t}.${rawBody}`).digest('hex');
if (expected !== v1) return res.status(401).end();
```

---

## Architecture

```
src/
  routes/       REST API, dashboard API, OAuth, signed media
  queue/        SQLite-backed job runner (leases, retries, backoff) + outbound webhooks
  adapters/     youtube, tiktok, instagram, facebook, x, linkedin, webhook (+ sandbox)
  oauth/        provider definitions, PKCE, token refresh, account resolution
  media/        platform specs, variant planning, ffmpeg probe/transcode
  storage/      local disk (default) or S3-compatible
  db/           schema + repository
public/         dashboard (no build step) + embeddable widget
test/           node:test suite (20 tests)
```

The queue leases jobs with an atomic `UPDATE`, so you can run several workers:

```bash
POSTER_MODE=server npm start     # HTTP only
POSTER_MODE=worker npm run worker  # worker only
```

Retries use exponential backoff with jitter (5 attempts by default) and honour
`Retry-After`. Targets are independent: one network failing marks the job `partial`,
not `failed`.

---

## Tests

```bash
npm test
```

Covers the ingest API (auth, multipart, `videoUrl`, SSRF guard, idempotency,
validation), the full publish pipeline across all six networks, webhook delivery and
signature verification, scheduling, retry/attempt exhaustion, per-target overrides,
media pre-flight limits and signed media URLs.

## Deployment

```bash
docker build -t posterly . && docker run -p 4000:4000 --env-file .env posterly
```

Set `PUBLIC_BASE_URL` to your real domain, keep `POSTER_SECRET` stable (it encrypts
stored tokens), and mount `DATA_DIR` on persistent storage if you use local disk.
Install `ffmpeg` in the image to enable per-platform reframing; without it Posterly
validates and forwards your source file unchanged.

## Status / limits

* Real uploads require your own API access on each network — the code targets the
  current public APIs, and **sandbox mode** (simulated platform responses) is what runs
  until credentials are connected.
* `ffmpeg` is optional; without it no reframing/transcoding happens (a warning is
  logged per target).
* SQLite is fine to tens of thousands of jobs; the S3 driver covers shared storage.
