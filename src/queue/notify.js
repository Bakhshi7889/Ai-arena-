import { signWebhookPayload } from '../lib/crypto.js';
import { backoff } from '../lib/http.js';

/**
 * POST the final job result back to the caller's `callbackUrl`.
 * Signed the same way as every other Posterly webhook so the receiver can
 * verify authenticity and reject replays.
 */
export async function sendJobCallback({
  job,
  url,
  secret,
  fetchImpl = fetch,
  attempts = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = () => {},
}) {
  const payload = JSON.stringify({
    event: 'poster.job.completed',
    jobId: job.id,
    status: job.status,
    title: job.title,
    visibility: job.visibility,
    createdAt: new Date(job.createdAt).toISOString(),
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    error: job.error ?? null,
    targets: (job.targets ?? []).map((t) => ({
      provider: t.provider,
      status: t.status,
      externalId: t.externalId,
      externalUrl: t.externalUrl,
      error: t.lastError,
    })),
  });

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { header } = signWebhookPayload(secret, payload);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'posterly/0.1',
          'x-poster-signature': header,
          'x-poster-event': 'poster.job.completed',
          'x-poster-job': job.id,
        },
        body: payload,
      });
      if (res.ok) return { state: 'delivered', attempts: attempt, status: res.status };
      lastError = new Error(`HTTP ${res.status}`);
      logger('warn', `callback attempt ${attempt} returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      logger('warn', `callback attempt ${attempt} failed: ${err.message}`);
    }
    if (attempt < attempts) await sleep(backoff(attempt, 1000, 20_000));
  }
  return { state: 'failed', attempts, error: lastError?.message };
}
