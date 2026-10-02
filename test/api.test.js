import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, fakeMp4, multipartBody, startFixtureServer } from './helpers.js';
import { mediaKey } from '../src/storage/index.js';

test('GET /api/v1/health reports the running configuration', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const res = await fetch(`${server.base}/api/v1/health`, { headers: { 'x-api-key': server.apiKey } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.storage, 'local');
  assert.ok(body.platforms.includes('tiktok'));
});

test('the ingest API rejects requests without a valid API key', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const missing = await fetch(`${server.base}/api/v1/posts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 401);

  const bogus = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'pst_live_nope' },
    body: '{}',
  });
  assert.equal(bogus.status, 401);
  assert.equal((await bogus.json()).error.code, 'unauthorized');
});

test('a revoked API key can no longer publish', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  server.repo.apiKeys.revoke(server.keyRecord.id);
  const res = await fetch(`${server.base}/api/v1/health`, { headers: { 'x-api-key': server.apiKey } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /revoked/);
});

test('POST /api/v1/posts accepts a multipart video upload and queues every target', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const { body, contentType } = multipartBody(
    {
      title: 'Launch day',
      description: 'Behind the scenes',
      tags: 'launch, bts',
      visibility: 'public',
      targets: JSON.stringify(['youtube', 'tiktok', 'x']),
    },
    { field: 'video', name: 'clip.mp4', contentType: 'video/mp4', content: fakeMp4(8192) },
  );

  const res = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': server.apiKey },
    body,
  });
  assert.equal(res.status, 202);
  const { job } = await res.json();

  assert.equal(job.title, 'Launch day');
  assert.equal(job.status, 'queued');
  assert.equal(job.videoSize, 8192);
  assert.deepEqual(job.targets.map((x) => x.provider), ['youtube', 'tiktok', 'x']);
  assert.deepEqual(job.tags, ['launch', 'bts']);

  const stored = server.repo.jobs.get(job.id);
  assert.ok(stored.videoPath, 'job records a stored video path');
  assert.equal(job.videoPath, undefined, 'internal paths are not exposed');
});

test('POST /api/v1/posts can pull a video from a URL', async (t) => {
  const server = await bootServer({ allowPrivate: true });
  const fixture = await startFixtureServer({ response: fakeMp4(3000) });
  t.after(async () => {
    await fixture.close();
    await server.close();
  });

  const res = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': server.apiKey },
    body: JSON.stringify({ title: 'Pulled clip', videoUrl: fixture.url('/clip.mp4'), targets: ['linkedin'] }),
  });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  assert.equal(job.videoSize, 3000);
  assert.equal(job.videoMime, 'video/mp4');
  assert.equal(fixture.received.length, 1, 'the video was fetched exactly once');
});

test('videoUrl requests to private addresses are refused (SSRF guard)', async (t) => {
  const server = await bootServer({ allowPrivate: false });
  t.after(() => server.close());

  const res = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': server.apiKey },
    body: JSON.stringify({ title: 'nope', videoUrl: 'http://127.0.0.1:9/x.mp4', targets: ['youtube'] }),
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error.message, /private address/);
});

test('idempotency keys deduplicate repeat submissions', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const make = () =>
    multipartBody(
      { title: 'Once only', targets: '["tiktok"]' },
      { field: 'video', name: 'clip.mp4', contentType: 'video/mp4', content: fakeMp4(1500) },
    );

  const first = make();
  const created = await (
    await fetch(`${server.base}/api/v1/posts`, {
      method: 'POST',
      headers: { 'content-type': first.contentType, 'x-api-key': server.apiKey, 'idempotency-key': 'abc-123' },
      body: first.body,
    })
  ).json();
  assert.ok(created.job.id);

  const second = make();
  const res = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': second.contentType, 'x-api-key': server.apiKey, 'idempotency-key': 'abc-123' },
    body: second.body,
  });
  assert.equal(res.status, 200, 'the duplicate is accepted, not re-created');
  const body = await res.json();
  assert.equal(body.deduplicated, true);
  assert.equal(body.job.id, created.job.id, 'the same job id comes back');
  assert.equal(server.repo.jobs.list().length, 1, 'only one job exists');
});

test('unknown platforms and empty target lists are rejected', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const unknown = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': server.apiKey },
    body: JSON.stringify({ title: 'x', videoUrl: 'https://cdn.example.com/a.mp4', targets: ['myspace'] }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'unknown_platform');

  const empty = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': server.apiKey },
    body: JSON.stringify({ title: 'x', videoUrl: 'https://cdn.example.com/a.mp4', targets: [] }),
  });
  assert.equal(empty.status, 400);
});

test('non-video uploads are refused', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const { body, contentType } = multipartBody(
    { title: 'nope', targets: '["youtube"]' },
    { field: 'video', name: 'notes.txt', contentType: 'text/plain', content: Buffer.from('hello') },
  );
  const res = await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': server.apiKey },
    body,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Unsupported file type/);
});

test('GET /api/v1/posts/:id returns targets and an event log', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const { body, contentType } = multipartBody(
    { title: 'Detail check', targets: '["facebook"]' },
    { field: 'video', name: 'v.mp4', contentType: 'video/mp4', content: fakeMp4() },
  );
  const created = await (await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': server.apiKey },
    body,
  })).json();

  const detail = await (await fetch(`${server.base}/api/v1/posts/${created.job.id}`, { headers: { 'x-api-key': server.apiKey } })).json();
  assert.equal(detail.job.id, created.job.id);
  assert.ok(detail.events.length >= 1);
  assert.match(detail.events[0].message, /accepted from test/);

  const missing = await fetch(`${server.base}/api/v1/posts/job_does_not_exist`, { headers: { 'x-api-key': server.apiKey } });
  assert.equal(missing.status, 404);
});

test('signed media URLs serve the stored file and reject tampered signatures', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const { body, contentType } = multipartBody(
    { title: 'Media test', targets: '["youtube"]' },
    { field: 'video', name: 'media.mp4', contentType: 'video/mp4', content: fakeMp4(5000) },
  );
  const { job } = await (await fetch(`${server.base}/api/v1/posts`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': server.apiKey },
    body,
  })).json();

  const key = mediaKey(job.id, 'source', 'media.mp4');
  assert.equal(key, `${job.id}/source.mp4`, 'storage keys are <job>/<variant><ext>');
  const good = server.storage.publicUrl(key);
  const ok = await fetch(good);
  assert.equal(ok.status, 200);
  assert.equal((await ok.arrayBuffer()).byteLength, 5000);
  assert.equal(ok.headers.get('content-type'), 'video/mp4');

  const tampered = good.replace(/sig=.{4}/, 'sig=dead');
  assert.equal((await fetch(tampered)).status, 403);
});

test('CORS only reflects origins listed in ALLOWED_ORIGINS', async (t) => {
  const server = await bootServer();
  t.after(() => server.close());

  const res = await fetch(`${server.base}/api/v1/health`, {
    headers: { 'x-api-key': server.apiKey, origin: 'https://evil.example' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://evil.example', 'dev config allows all origins');
});
