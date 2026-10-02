const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  summary: null,
  jobs: [],
  selected: new Set(),
  timer: null,
};

function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body && !(options.body instanceof FormData) && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  clearInterval(state.timer);
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  refresh();
  state.timer = setInterval(() => { if (!$('#jobs').closest('.panel')?.classList.contains('active')) return; loadJobs(); }, 4000);
}

// ------------------------------------------------------------- overview ----
async function loadSummary() {
  const data = await api('/admin/api/summary');
  state.summary = data;
  const counts = data.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('#stats').innerHTML = [
    ['Jobs', total],
    ['Published', counts.published ?? 0],
    ['In flight', (counts.queued ?? 0) + (counts.processing ?? 0) + (counts.publishing ?? 0)],
    ['Failed', (counts.failed ?? 0) + (counts.partial ?? 0)],
    ['Connections', data.connections.length],
    ['API keys', data.keys.filter((k) => !k.revoked).length],
  ]
    .map(([label, value]) => `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`)
    .join('');

  const connections = data.connections;
  $('#platforms').innerHTML = data.platforms
    .map((p) => {
      const connection = connections.find((c) => c.provider === p.id || (p.id === 'instagram' && c.provider === 'facebook'));
      const connected = Boolean(connection);
      return `<div class="platform">
        <div class="row">
          <span class="name"><span class="dot" style="background:${p.color}"></span>${p.label}</span>
          <span class="badge ${connected ? 'published' : ''}">${connected ? 'connected' : 'not connected'}</span>
        </div>
        <div class="muted small">${connection ? `${connection.displayName}${connection.sandbox ? ' · sandbox' : ''}` : 'Formats: ' + p.formats.map((f) => `${f.label} (${f.aspect})`).join(', ')}</div>
        ${p.requiresPublicUrl ? '<div class="muted small">Ingests by URL — PUBLIC_BASE_URL must be public</div>' : ''}
      </div>`;
    })
    .join('');

  const cfg = data.config;
  $('#env').innerHTML = `storage: ${cfg.storageDriver}<br/>ffmpeg: ${cfg.ffmpeg ? 'yes' : 'no (source passthrough)'}<br/>mode: ${cfg.sandbox}`;
}

// --------------------------------------------------------------- upload ----
function renderTargetChips() {
  const platforms = state.summary?.platforms ?? [];
  $('#upload-targets').innerHTML = platforms
    .map((p) => `<span class="chip ${state.selected.has(p.id) ? 'on' : ''}" data-platform="${p.id}"><span class="dot" style="background:${p.color}"></span>${p.label}</span>`)
    .join('');
  $$('#upload-targets .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = chip.dataset.platform;
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      chip.classList.toggle('on');
    }),
  );
}

async function submitUpload(event) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = $('#upload-error');
  errorEl.classList.add('hidden');

  const source = data.get('source');
  const body = new FormData();
  body.append('title', data.get('title'));
  if (data.get('description')) body.append('description', data.get('description'));
  if (data.get('tags')) body.append('tags', data.get('tags'));
  body.append('visibility', data.get('visibility'));
  body.append('targets', JSON.stringify([...state.selected]));
  if (data.get('callbackUrl')) body.append('callbackUrl', data.get('callbackUrl'));

  if (source === 'file') {
    const file = data.get('video');
    if (!file || !file.size) return (errorEl.textContent = 'Choose a video file first.'), errorEl.classList.remove('hidden');
    body.append('video', file);
  } else {
    if (!data.get('videoUrl')) return (errorEl.textContent = 'Enter a video URL.'), errorEl.classList.remove('hidden');
    body.append('videoUrl', data.get('videoUrl'));
  }

  if (!state.selected.size) return (errorEl.textContent = 'Pick at least one network.'), errorEl.classList.remove('hidden');

  try {
    const key = (await api('/admin/api/keys')).keys.find((k) => !k.revoked);
    if (!key) throw new Error('Create an API key first (API keys tab).');
    const secret = sessionStorage.getItem('posterly_key');
    if (!secret) throw new Error('Your API key secret is not in this browser session. Re-create a key and keep the secret, or publish with curl.');

    const res = await fetch('/api/v1/posts', { method: 'POST', headers: { 'x-api-key': secret }, body });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message ?? 'Publish failed');
    $('#upload-result').innerHTML = renderJob(json.job);
    toast(`Job ${json.job.id} queued for ${json.job.targets.length} networks`);
    loadJobs();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

// ----------------------------------------------------------------- jobs ----
function renderTarget(t) {
  const label = state.summary?.platforms.find((p) => p.id === t.provider)?.label ?? t.provider;
  const link = t.externalUrl ? ` · <a href="${t.externalUrl}" target="_blank" rel="noreferrer">view</a>` : '';
  const sandbox = t.sandbox ? ' <span class="badge sandbox">sandbox</span>' : '';
  const error = t.error ? `<div class="muted small">${escapeHtml(t.error)}</div>` : '';
  return `<div class="target"><strong>${label}</strong> <span class="badge ${t.status}">${t.status}</span>${sandbox}${link}${error}</div>`;
}

function renderJob(job) {
  if (!job) return '';
  const when = new Date(job.createdAt).toLocaleString();
  return `<div class="job" data-job="${job.id}">
    <div class="head">
      <div>
        <div class="title">${escapeHtml(job.title ?? '(untitled)')}</div>
        <div class="meta">${job.id} · ${when} · ${job.visibility}${job.scheduledAt ? ' · scheduled' : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${job.status}">${job.status}</span>
        <button class="tiny ghost" data-action="events">log</button>
        <button class="tiny" data-action="retry">retry</button>
      </div>
    </div>
    <div class="targets">${(job.targets ?? []).map(renderTarget).join('')}</div>
    <div class="events hidden"></div>
  </div>`;
}

async function loadJobs() {
  const data = await api('/admin/api/jobs');
  state.jobs = data.jobs;
  $('#jobs').innerHTML = data.jobs.length ? data.jobs.map(renderJob).join('') : '<p class="muted">No jobs yet — post a video to get started.</p>';
  $$('#jobs .job').forEach((el) => {
    const id = el.dataset.job;
    el.querySelector('[data-action="events"]').addEventListener('click', async () => {
      const box = el.querySelector('.events');
      if (!box.classList.contains('hidden')) return box.classList.add('hidden');
      const detail = await api(`/admin/api/jobs/${id}`);
      box.innerHTML = detail.events
        .slice()
        .reverse()
        .map((e) => `<div class="${e.level}">${new Date(e.created_at).toLocaleTimeString()} · ${escapeHtml(e.message)}</div>`)
        .join('');
      box.classList.remove('hidden');
    });
    el.querySelector('[data-action="retry"]').addEventListener('click', async () => {
      await api(`/admin/api/jobs/${id}/retry`, { method: 'POST' });
      toast('Retry queued');
      loadJobs();
    });
  });
}

// ---------------------------------------------------------- connections ----
async function loadConnections() {
  const data = await api('/admin/api/connections');
  const oauth = state.summary?.oauth ?? [];
  $('#connections').innerHTML =
    data.connections.length === 0
      ? '<p class="muted">Nothing connected yet.</p>'
      : data.connections
          .map(
            (c) => `<div class="job"><div class="head">
              <div><div class="title">${escapeHtml(c.displayName ?? c.provider)}</div>
              <div class="meta">${c.provider} · ${escapeHtml(c.accountId ?? '')}${c.meta?.instagramUsername ? ' · IG @' + c.meta.instagramUsername : ''}${c.meta?.pageName ? ' · Page: ' + escapeHtml(c.meta.pageName) : ''}</div></div>
              <div style="display:flex;gap:8px"><span class="badge ${c.sandbox ? 'sandbox' : 'published'}">${c.sandbox ? 'sandbox' : 'live'}</span>
              <button class="tiny danger" data-remove="${c.id}">disconnect</button></div>
            </div></div>`,
          )
          .join('');

  $$('#connections [data-remove]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/admin/api/connections/${btn.dataset.remove}`, { method: 'DELETE' });
      toast('Disconnected');
      loadConnections();
      loadSummary();
    }),
  );

  const connectable = oauth.filter((o) => o.id !== 'instagram');
  $('#demo-connect').innerHTML =
    connectable
      .map((o) => `<span class="chip" data-oauth="${o.id}">${o.label}${o.configured ? '' : ' (no client id)'}</span>`)
      .join('') +
    ['youtube', 'tiktok', 'facebook', 'instagram', 'x', 'linkedin']
      .map((p) => `<span class="chip" data-demo="${p}">sandbox: ${p}</span>`)
      .join('');

  $$('#demo-connect [data-oauth]').forEach((chip) =>
    chip.addEventListener('click', () => {
      window.location.href = `/oauth/${chip.dataset.oauth}/start`;
    }),
  );
  $$('#demo-connect [data-demo]').forEach((chip) =>
    chip.addEventListener('click', async () => {
      await api('/admin/api/connections/demo', { method: 'POST', body: { provider: chip.dataset.demo } });
      toast(`${chip.dataset.demo} sandbox connection added`);
      loadConnections();
      loadSummary();
    }),
  );
}

// ----------------------------------------------------------------- keys ----
async function loadKeys() {
  const data = await api('/admin/api/keys');
  $('#keys').innerHTML = data.keys
    .map(
      (k) => `<div class="job"><div class="head">
        <div><div class="title">${escapeHtml(k.name)}</div>
        <div class="meta"><code>${escapeHtml(k.prefix)}…</code> · ${k.scopes.join(', ')}${k.lastUsedAt ? ' · last used ' + new Date(k.lastUsedAt).toLocaleString() : ''}</div></div>
        <div>${k.revoked ? '<span class="badge failed">revoked</span>' : `<button class="tiny danger" data-revoke="${k.id}">revoke</button>`}</div>
      </div></div>`,
    )
    .join('');
  $$('#keys [data-revoke]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/admin/api/keys/${btn.dataset.revoke}`, { method: 'DELETE' });
      loadKeys();
      loadSummary();
    }),
  );
}

// -------------------------------------------------------------- snippets ---
function renderSnippets() {
  const base = window.location.origin;
  $('#snippet-widget').textContent = `<!-- paste anywhere on your site -->
<script src="${base}/embed/poster.js"></script>
<button id="publish">Publish this video</button>
<script>
  Posterly.init({ apiKey: 'pst_live_…' });
  document.getElementById('publish').onclick = async () => {
    const file = document.querySelector('input[type=file]').files[0];
    const job = await Posterly.post({
      video: file,
      title: 'Our launch',
      targets: ['youtube', 'tiktok', 'instagram', 'x'],
    });
    console.log(job);
  };
<\/script>`;

  $('#snippet-curl').textContent = `curl -X POST ${base}/api/v1/posts \\
  -H "X-API-Key: pst_live_…" \\
  -F "video=@./clip.mp4" \\
  -F "title=Our launch" \\
  -F "tags=launch,product" \\
  -F "visibility=public" \\
  -F 'targets=["youtube","tiktok","instagram","facebook","x","linkedin"]' \\
  -F "callbackUrl=https://yoursite.com/hooks/posterly"`;

  $('#snippet-callback').textContent = `// Posterly POSTs the result to your callbackUrl with a signature:
//   X-Poster-Signature: t=<unix>,v1=<hmac-sha256 of "<t>.<raw body>">
// verify with your POSTER_SECRET:
const crypto = require('crypto');
const [t, v1] = req.get('X-Poster-Signature').split(',').map(s => s.split('=')[1]);
const expected = crypto.createHmac('sha256', process.env.POSTER_SECRET)
  .update(t + '.' + rawBody).digest('hex');
if (expected !== v1) return res.status(401).end();
// body: { event, jobId, status, targets: [{ provider, status, externalUrl }] }`;

  $('#snippet-js').textContent = `// Pull a video by URL instead of uploading it (server-side download):
await fetch('${base}/api/v1/posts', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'pst_live_…' },
  body: JSON.stringify({
    title: 'Our launch',
    videoUrl: 'https://cdn.example.com/clip.mp4',
    targets: [{ platform: 'youtube', format: 'shorts' }, { platform: 'tiktok' }],
    scheduledAt: '2026-01-01T15:00:00Z',
  }),
});`;
}

// --------------------------------------------------------------- helpers ---
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  try {
    await loadSummary();
    renderTargetChips();
    renderSnippets();
    await Promise.all([loadJobs(), loadConnections(), loadKeys()]);
  } catch (err) {
    if (err.message !== 'Session expired') toast(err.message);
  }
}

// ----------------------------------------------------------------- boot ----
$$('.sidebar nav button').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.sidebar nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
    if (btn.dataset.tab === 'jobs') loadJobs();
  }),
);

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api('/admin/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    $('#login-error').classList.add('hidden');
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' });
  sessionStorage.removeItem('posterly_key');
  showLogin();
});

$('#upload-form').addEventListener('submit', submitUpload);

$('#key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  const created = await api('/admin/api/keys', { method: 'POST', body: { name } });
  sessionStorage.setItem('posterly_key', created.secret);
  $('#new-key').className = 'key-secret';
  $('#new-key').innerHTML = `<strong>New API key — copy it now:</strong><br/><code>${created.secret}</code>`;
  event.target.reset();
  loadKeys();
  loadSummary();
});

$('#token-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/admin/api/connections', { method: 'POST', body: data });
  toast('Connection saved');
  event.target.reset();
  loadConnections();
  loadSummary();
});

// Try an existing session on load.
api('/admin/api/summary')
  .then(() => showApp())
  .catch(() => showLogin());
