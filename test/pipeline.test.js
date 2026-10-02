import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, fakeMp4, multipartBody, startFixtureServer, waitFor } from './helpers.js';
import { hmacSha256, verifyWebhookSignature } from '../src/lib/crypto.js';

const ALL_SOCIALS = ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'linkedin'];

async function submit(server, { targets, title = 'Pipeline run', bytes = 4096, extra = {} } = {}) {
  const { body, contentType } = multipartBody(
    { title, tags: 'test,e2e', visibility: 'public', targets: JSON.stringify(targets), ...extra },
    { field: 'video', name: 'clip.mp4', contentType: 'video/mp4', content: fakeMp4(bytes) },
  );
  const res = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': server.apiKey },
    body,
  });
  assert.equal(res.status, 202);
  const json = await res.json();
  return json.job;
}

test('a video submitted once is published to all six networks', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const job = await submit(server, { targets: ALL_SOCIALS });
  assert.equal(job.targets.length, 6);

  const processed = await server.runner.drain();
  assert.equal(processed, 1, 'exactly one job was claimed');

  const final = server.repo.jobs.get(job.id);
  assert.equal(final.status, 'published', `expected published, got ${final.status}: ${final.error ?? ''}`);
  assert.ok(final.completedAt, 'completion timestamp set');

  for (const target of final.targets) {
    assert.equal(target.status, 'published', `${target.provider} should be published (${target.lastError})`);
    assert.ok(target.externalId, `${target.provider} recorded an external id`);
    assert.equal(target.detail?.sandbox, true, 'no credentials were configured, so the sandbox transport was used');
  }

  const byProvider = Object.fromEntries(final.targets.map((x) => [x.provider, x]));
  assert.match(byProvider.youtube.externalUrl, /^https:\/\/www\.youtube\.com\/watch\?v=/);
  assert.match(byProvider.x.externalUrl, /^https:\/\/x\.com\/i\/web\/status\//);
  assert.match(byProvider.instagram.externalUrl, /^https:\/\/www\.instagram\.com\/reel\//);
  assert.ok(byProvider.tiktok.externalId, 'tiktok returns a publish_id');
  assert.ok(byProvider.linkedin.externalId, 'linkedin returns a share urn');
});

test('the job event log records the full publish trace', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const job = await submit(server, { targets: ['youtube', 'tiktok'] });
  await server.runner.drain();

  const events = server.repo.jobs.events(job.id);
  const messages = events.map((e) => e.message);
  assert.ok(messages.some((m) => m.includes('picked up by w_')), 'worker picked the job up');
  assert.ok(messages.some((m) => m.includes('youtube: publishing')), 'youtube attempt logged');
  assert.ok(messages.some((m) => m.includes('youtube: published')), 'youtube success logged');
  assert.ok(messages.some((m) => m.includes('finished with status "published"')));
});

test('a custom webhook target receives a signed payload over real HTTP', async (t) => {
  const server = await bootServer();
  const fixture = await startFixtureServer({ response: Buffer.from('{"ok":true}'), contentType: 'application/json' });
  t.after(async () => {
    await fixture.close();
    await server.close();
  });

  const job = await submit(server, {
    targets: [{ platform: 'webhook', url: fixture.url('/hooks/posterly'), secret: 'shared-secret' }],
  });
  await server.runner.drain();

  assert.equal(fixture.received.length, 1, 'the webhook endpoint was called');
  const delivery = fixture.received[0];
  assert.equal(delivery.method, 'POST');
  assert.equal(delivery.headers['x-poster-event'], 'poster.video.ready');

  const payload = JSON.parse(delivery.body.toString('utf8'));
  assert.equal(payload.event, 'poster.video.ready');
  assert.equal(payload.jobId, job.id);
  assert.equal(payload.video.bytes, 4096);
  assert.match(payload.video.url, /\/media\//, 'the payload carries a signed media URL');

  // The adapter signs the exact raw body with the target's shared secret.
  const raw = delivery.body.toString('utf8');
  const signature = delivery.headers['x-poster-signature'].replace('sha256=', '');
  assert.equal(signature, hmacSha256('shared-secret', raw), 'signature matches the shared secret');
  assert.notEqual(signature, hmacSha256('wrong-secret', raw), 'a different secret does not match');

  const final = server.repo.jobs.get(job.id);
  assert.equal(final.targets[0].status, 'published');
  assert.equal(final.targets[0].detail.sandbox, false, 'webhook targets use the real network, never the sandbox');
});

test('the callbackUrl receives the final job result', async (t) => {
  const server = await bootServer();
  const fixture = await startFixtureServer({ response: Buffer.from('ok'), contentType: 'text/plain' });
  t.after(async () => {
    await fixture.close();
    await server.close();
  });

  const job = await submit(server, { targets: ['youtube'], extra: { callbackUrl: fixture.url('/cb') } });
  await server.runner.drain();
  await waitFor(() => server.repo.jobs.get(job.id).callbackState === 'delivered', { label: 'callback delivery' });

  assert.equal(fixture.received.length, 1);
  const body = JSON.parse(fixture.received[0].body.toString('utf8'));
  assert.equal(body.event, 'poster.job.completed');
  assert.equal(body.status, 'published');
  assert.equal(body.targets[0].provider, 'youtube');

  // The signature must verify against POSTER_SECRET using the raw body.
  const raw = fixture.received[0].body.toString('utf8');
  assert.ok(
    verifyWebhookSignature(server.config.secret, fixture.received[0].headers['x-poster-signature'], raw),
    'callback signature verifies',
  );
});

test('scheduled jobs stay queued until their time arrives', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const job = await submit(server, { targets: ['youtube'], extra: { scheduledAt: future } });

  const processed = await server.runner.drain();
  assert.equal(processed, 0, 'a future job is not claimed');
  assert.equal(server.repo.jobs.get(job.id).status, 'queued');

  server.repo.jobs.update(job.id, { scheduleAt: Date.now() - 1000 });
  assert.equal(await server.runner.drain(), 1, 'once due, the job runs');
  assert.equal(server.repo.jobs.get(job.id).status, 'published');
});

test('a failing target is retried and then fails the job permanently', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const job = await submit(server, { targets: [{ platform: 'webhook', url: 'http://127.0.0.1:1/always-fails' }] });
  server.repo.jobs.update(job.id, { maxAttempts: 2 });

  await server.runner.drain();
  let current = server.repo.jobs.get(job.id);
  assert.ok(['retry', 'failed'].includes(current.status), `expected retry/failed, got ${current.status}`);

  // Second attempt exhausts maxAttempts.
  server.repo.jobs.update(job.id, { nextAttemptAt: null, status: 'retry' });
  await server.runner.drain();
  current = server.repo.jobs.get(job.id);
  assert.equal(current.status, 'failed');
  assert.equal(current.attempts, 2);
  assert.ok(current.error, 'the job records why it failed');
});

test('media pre-flight errors surface per target without blocking the others', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const job = await submit(server, { targets: ['x', 'youtube'], bytes: 2048 });
  // Pretend the probe found a 10 minute video: over X's 140s limit, fine for YouTube.
  server.repo.jobs.update(job.id, { durationMs: 600_000, width: 1920, height: 1080 });

  await server.runner.drain();
  const final = server.repo.jobs.get(job.id);
  const byProvider = Object.fromEntries(final.targets.map((x) => [x.provider, x]));

  assert.equal(byProvider.x.status, 'failed', 'x should be rejected by the duration limit');
  assert.match(byProvider.x.lastError, /140s max/);
  assert.equal(byProvider.youtube.status, 'published', 'youtube still publishes');
  assert.equal(final.status, 'partial');
});

test('per-target overrides reach the platform payload', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const job = await submit(server, {
    targets: [
      { platform: 'youtube', format: 'shorts', title: 'Shorts version', visibility: 'unlisted', categoryId: '24' },
      { platform: 'tiktok', privacyLevel: 'FOLLOWERS_OF_CREATOR' },
    ],
  });
  await server.runner.drain();

  const final = server.repo.jobs.get(job.id);
  const yt = final.targets.find((x) => x.provider === 'youtube');
  assert.equal(yt.status, 'published');
  assert.equal(yt.params.format, 'shorts');
  assert.equal(yt.params.categoryId, '24');
  assert.equal(yt.detail.shorts, true, 'the shorts branch of the YouTube adapter ran');
  assert.equal(yt.detail.status.privacyStatus, 'unlisted', 'per-target visibility wins');
});
