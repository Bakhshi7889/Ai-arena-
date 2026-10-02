import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AdapterError, PosterError } from '../lib/errors.js';
import { backoff, withRetry } from '../lib/http.js';
import { createAdapter } from '../adapters/registry.js';
import { createSandboxTransport } from '../adapters/sandbox.js';
import { planVariants, variantSettings } from '../media/plan.js';
import { probe, resolveBinaries, transcode } from '../media/ffmpeg.js';
import { decryptJSON } from '../lib/crypto.js';
import { isExpiringSoon, refreshTokens } from '../oauth/index.js';
import { sendJobCallback } from './notify.js';

const CONNECTION_PROVIDER = { instagram: 'facebook' };

/** Which platform account a target publishes through. */
export function connectionProviderFor(provider) {
  return CONNECTION_PROVIDER[provider] ?? provider;
}

/**
 * Drives a job from `queued` to a terminal state:
 *   media prep -> per-target publish -> aggregate -> outbound callback
 *
 * Safe to run in more than one process: jobs are leased with an atomic
 * UPDATE and stale leases are reclaimed after 10 minutes.
 */
export class QueueRunner {
  constructor({ repo, storage, config, transport, logger = consoleLogger, sleep = defaultSleep }) {
    this.repo = repo;
    this.storage = storage;
    this.config = config;
    this.transport = transport;
    this.log = logger;
    this.sleep = sleep;
    this.workerId = `w_${crypto.randomBytes(4).toString('hex')}`;
    this.binaries = resolveBinaries(config.media);
    this.running = false;
    this.inFlight = new Set();
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.log('info', `queue worker ${this.workerId} started (concurrency ${this.config.queue.concurrency})`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.running) return;
    try {
      await this.drain();
    } catch (err) {
      this.log('error', `queue tick failed: ${err.message}`);
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => this.tick(), this.config.queue.pollMs);
      }
    }
  }

  /** Claim and process everything currently due. Returns jobs processed. */
  async drain() {
    const slots = this.config.queue.concurrency - this.inFlight.size;
    if (slots <= 0) return 0;
    const due = this.repo.jobs.due(slots);
    let processed = 0;
    for (const job of due) {
      if (!this.repo.jobs.claim(job.id, ['queued', 'retry'], this.workerId)) continue;
      this.inFlight.add(job.id);
      processed += 1;
      try {
        await this.processJob(job.id);
      } finally {
        this.inFlight.delete(job.id);
      }
    }
    return processed;
  }

  async processJob(jobId) {
    const job = this.repo.jobs.get(jobId);
    if (!job) return null;
    this.event(jobId, 'info', `job ${jobId} picked up by ${this.workerId}`);

    try {
      const prepared = await this.prepareMedia(job);
      const plan = prepared.plan;

      const targets = this.repo.targets.byJob(jobId);
      const pending = targets.filter((t) => t.status !== 'published');
      if (!pending.length) return this.finish(jobId, targets);

      const byProvider = Object.fromEntries(pending.map((t) => [t.provider, plan.find((p) => p.provider === t.provider)]));

      for (const target of pending) {
        const planEntry = byProvider[target.provider];
        if (planEntry?.errors?.length) {
          this.repo.targets.update(target.id, { status: 'failed', lastError: planEntry.errors.join('; ') });
          this.event(jobId, 'error', `${target.provider}: ${planEntry.errors.join('; ')}`, { provider: target.provider });
          continue;
        }
        await this.publishTarget(job, target, planEntry, prepared);
      }

      return this.finish(jobId, this.repo.targets.byJob(jobId));
    } catch (err) {
      this.log('error', `job ${jobId} crashed: ${err.stack ?? err.message}`);
      this.event(jobId, 'error', `job crashed: ${err.message}`);
      return this.scheduleRetry(job, err);
    }
  }

  // ---------------------------------------------------------------- media ---
  async prepareMedia(job) {
    const source = {
      path: job.videoPath,
      size: job.videoSize,
      mime: job.videoMime,
      width: job.width,
      height: job.height,
      durationMs: job.durationMs,
    };

    if (!source.path || !fs.existsSync(source.path)) {
      throw new PosterError('Source video is missing from storage', { status: 410, code: 'asset_missing' });
    }

    // Probe once if we have not already recorded dimensions.
    if (this.binaries.available && (source.width === null || source.width === undefined)) {
      const info = await probe(source.path, this.binaries);
      if (info.available) {
        Object.assign(source, {
          width: info.width,
          height: info.height,
          durationMs: info.durationMs,
          mime: source.mime ?? `video/${info.format ?? 'mp4'}`,
        });
        this.repo.jobs.update(job.id, {
          width: source.width,
          height: source.height,
          durationMs: source.durationMs,
          videoMime: source.mime,
        });
        this.event(job.id, 'info', `probed ${source.width}x${source.height}, ${Math.round((source.durationMs ?? 0) / 1000)}s`);
      }
    }

    const targets = this.repo.targets
      .byJob(job.id)
      .filter((t) => t.status !== 'published')
      .map((t) => ({ provider: t.provider, format: t.params?.format }));

    const plan = planVariants(source, targets, {
      ffmpegAvailable: this.binaries.available && this.config.media.enabled,
      autoReframe: true,
    });

    for (const entry of plan) {
      this.repo.targets.byJob(job.id)
        .filter((t) => t.provider === entry.provider)
        .forEach((t) => this.repo.targets.update(t.id, { variant: entry.variant }));
      for (const warning of entry.warnings) this.event(job.id, 'warn', `${entry.provider}: ${warning}`, { provider: entry.provider });
      for (const error of entry.errors) this.event(job.id, 'error', `${entry.provider}: ${error}`, { provider: entry.provider });
    }

    // Produce reframed variants where the plan calls for one.
    const variants = new Map();
    if (this.binaries.available && this.config.media.enabled) {
      const needed = [...new Set(plan.filter((p) => p.variant !== 'source').map((p) => `${p.provider}:${p.format}`))];
      for (const key of needed) {
        const [provider, format] = key.split(':');
        const settings = variantSettings(provider, format);
        if (!settings) continue;
        const outPath = path.join(this.config.paths.media, job.id, `${settings.name}.mp4`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        try {
          await transcode({ input: source.path, output: outPath, settings, binaries: this.binaries });
          const st = fs.statSync(outPath);
          variants.set(key, { path: outPath, size: st.size, mime: 'video/mp4', width: settings.width, height: settings.height, variant: settings.name });
          this.event(job.id, 'info', `rendered ${settings.name} (${settings.width}x${settings.height})`, { provider });
        } catch (err) {
          this.event(job.id, 'warn', `transcode failed for ${settings.name}, using source file: ${err.message}`, { provider });
        }
      }
    }

    return { source, plan, variants };
  }

  // ------------------------------------------------------------- publish ---
  async publishTarget(job, target, planEntry, prepared) {
    const provider = target.provider;
    const key = `${provider}:${planEntry?.format ?? target.params?.format ?? 'default'}`;
    const variant = prepared.variants.get(key);
    const asset = variant ?? prepared.source;

    const publicUrl = await this.publicUrlFor(job, asset);
    const context = {
      job,
      target,
      asset: { ...asset, publicUrl },
      config: this.config,
      log: (message) => this.event(job.id, 'info', `${provider}: ${message}`, { provider }),
    };

    const attempt = target.attempts + 1;
    this.repo.targets.update(target.id, { status: 'publishing', attempts: attempt, lastError: null });
    this.event(job.id, 'info', `${provider}: publishing (attempt ${attempt})`, { provider });

    try {
      const { credentials, transport, sandbox } = await this.credentialsFor(provider);
      const adapter = createAdapter(provider, { transport, config: this.config, sleep: this.sleep });
      if (!adapter) throw new AdapterError(`No adapter registered for "${provider}"`, { retryable: false });

      const result = await withRetry(() => adapter.publish({ ...context, credentials, transport }), {
        attempts: 2,
        baseMs: 1500,
        maxMs: 20_000,
        shouldRetry: (res) => res.status >= 500 || res.status === 429,
        sleep: this.sleep,
      });

      this.repo.targets.update(target.id, {
        status: result.state === 'published' ? 'published' : 'processing',
        externalId: result.externalId ?? null,
        externalUrl: result.externalUrl ?? null,
        detail: { ...(result.detail ?? {}), sandbox },
      });
      this.event(
        job.id,
        'info',
        `${provider}: ${result.state === 'published' ? 'published' : 'accepted, still processing'}${result.externalUrl ? ` → ${result.externalUrl}` : ''}`,
        { provider },
      );
    } catch (err) {
      const retryable = err.retryable !== false;
      this.repo.targets.update(target.id, {
        status: retryable ? 'retry' : 'failed',
        lastError: `${err.code ? `${err.code}: ` : ''}${err.message}`.slice(0, 1000),
      });
      this.event(job.id, 'error', `${provider}: ${err.message}`, { provider });
    }
  }

  async publicUrlFor(job, asset) {
    if (asset.path && fs.existsSync(asset.path) && this.storage.driver === 'local') {
      const key = path.relative(this.config.paths.media, asset.path).split(path.sep).join('/');
      return this.storage.publicUrl(key);
    }
    if (this.storage.driver === 'local' && job.videoPath) {
      const key = path.relative(this.config.paths.media, job.videoPath).split(path.sep).join('/');
      return this.storage.publicUrl(key);
    }
    return null;
  }

  /**
   * Resolve credentials + the transport a target should use.
   * Falls back to the sandbox transport when there is no real connection and
   * POSTER_SANDBOX allows it, so the pipeline is exercisable without API keys.
   */
  async credentialsFor(provider) {
    // Webhook targets carry no credentials — they always use the real network.
    if (provider === 'webhook' && this.config.sandbox !== 'always') {
      return { sandbox: false, transport: this.transport, credentials: {} };
    }

    const connectionProvider = connectionProviderFor(provider);
    const connection = this.repo.connections.findByProvider(connectionProvider)[0];
    const sandboxMode = this.config.sandbox;

    if (!connection) {
      if (sandboxMode === 'never') {
        throw new AdapterError(`No connected ${connectionProvider} account`, { code: 'not_connected', retryable: false });
      }
      return {
        sandbox: true,
        transport: createSandboxTransport({ catchAll: true }),
        credentials: sandboxCredentials(provider),
      };
    }

    const tokens = connection.tokens ? decryptJSON(connection.tokens, this.config.secret) : null;
    const useSandbox = connection.sandbox || (sandboxMode === 'always') || !tokens?.accessToken;
    if (useSandbox) {
      return { sandbox: true, transport: createSandboxTransport({ catchAll: true }), credentials: sandboxCredentials(provider) };
    }

    let current = tokens;
    if (tokens.refreshToken && isExpiringSoon(tokens)) {
      try {
        current = await refreshTokens(connection.provider, {
          refreshToken: tokens.refreshToken,
          config: this.config,
          transport: this.transport,
        });
        const { encryptJSON } = await import('../lib/crypto.js');
        this.repo.connections.upsert({
          ...connection,
          tokens: encryptJSON(current, this.config.secret),
        });
        this.log('info', `refreshed ${connection.provider} token`);
      } catch (err) {
        throw new AdapterError(`Could not refresh ${connection.provider} credentials: ${err.message}`, {
          code: 'token_refresh_failed',
          retryable: false,
        });
      }
    }

    return {
      sandbox: false,
      transport: this.transport,
      credentials: credentialsFor(provider, connection, current),
    };
  }

  // ---------------------------------------------------------- bookkeeping ---
  finish(jobId, targets = this.repo.targets.byJob(jobId)) {
    const statuses = targets.map((t) => t.status);
    const published = statuses.filter((s) => s === 'published').length;
    const processing = statuses.filter((s) => s === 'processing').length;
    const failed = statuses.filter((s) => s === 'failed' || s === 'retry').length;

    let status = 'published';
    let nextAttemptAt = null;
    if (published === 0 && failed === targets.length) status = 'failed';
    else if (failed > 0) status = published > 0 ? 'partial' : 'failed';
    else if (processing > 0) {
      status = 'publishing';
      nextAttemptAt = Date.now() + 30_000;
    }

    const job = this.repo.jobs.get(jobId);
    if (status === 'failed' && job.attempts + 1 < job.maxAttempts && targets.some((t) => t.status === 'retry')) {
      return this.scheduleRetry(job, new Error(targets.find((t) => t.lastError)?.lastError ?? 'all targets failed'));
    }

    const terminal = ['published', 'partial', 'failed'].includes(status);
    this.repo.jobs.update(jobId, {
      status,
      lockedAt: null,
      lockedBy: null,
      attempts: job.attempts + 1,
      nextAttemptAt: nextAttemptAt ?? (terminal ? null : job.nextAttemptAt),
      completedAt: terminal ? Date.now() : null,
      error: status === 'failed' ? targets.map((t) => `${t.provider}: ${t.lastError}`).filter(Boolean).join(' | ') : null,
    });
    this.event(jobId, status === 'failed' ? 'error' : 'info', `job finished with status "${status}"`);

    if (terminal) void this.notify(jobId);
    return this.repo.jobs.get(jobId);
  }

  scheduleRetry(job, err) {
    const attempts = job.attempts + 1;
    if (attempts >= job.maxAttempts) {
      this.repo.jobs.update(job.id, {
        status: 'failed',
        attempts,
        lockedAt: null,
        lockedBy: null,
        error: err.message,
        completedAt: Date.now(),
      });
      this.event(job.id, 'error', `job failed permanently after ${attempts} attempts: ${err.message}`);
      void this.notify(job.id);
      return this.repo.jobs.get(job.id);
    }
    const delay = backoff(attempts, 5000, 15 * 60_000);
    this.repo.jobs.update(job.id, {
      status: 'retry',
      attempts,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: Date.now() + delay,
      error: err.message,
    });
    this.event(job.id, 'warn', `retrying in ${Math.round(delay / 1000)}s: ${err.message}`);
    return this.repo.jobs.get(job.id);
  }

  event(jobId, level, message, { provider = null, data = null } = {}) {
    this.repo.jobs.addEvent(jobId, level, message, { provider, data });
    this.log(level === 'error' ? 'error' : 'info', `[${jobId}] ${message}`);
  }

  async notify(jobId) {
    const job = this.repo.jobs.get(jobId);
    if (!job?.callbackUrl) return;
    const result = await sendJobCallback({
      job,
      url: job.callbackUrl,
      secret: this.config.secret,
      fetchImpl: this.config.fetchImpl,
      logger: (level, msg) => this.log(level, `[${jobId}] ${msg}`),
    });
    this.repo.jobs.update(jobId, { callbackState: result.state });
    this.event(jobId, 'info', `callback ${result.state}${result.attempts > 1 ? ` after ${result.attempts} attempts` : ''}`);
  }
}

export function sandboxCredentials(provider) {
  const accountId = { instagram: '17840000000000000', facebook: '100000000000000' }[provider];
  return {
    accessToken: 'sandbox-access-token',
    refreshToken: null,
    expiresAt: null,
    accountId: accountId ?? 'sandbox-account',
    meta: {
      pageId: provider === 'facebook' ? '100000000000000' : undefined,
      instagramAccountId: provider === 'instagram' ? '17840000000000000' : undefined,
      personId: provider === 'linkedin' ? 'sandbox-person' : undefined,
    },
    sandbox: true,
  };
}

export function credentialsFor(provider, connection, tokens) {
  const meta = connection.meta ?? {};
  const base = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    accountId: connection.accountId,
    meta,
    sandbox: false,
  };
  if (provider === 'facebook') {
    return {
      ...base,
      accessToken: meta.pageAccessToken ?? tokens.pageAccessToken ?? tokens.accessToken,
      accountId: meta.pageId ?? connection.accountId,
    };
  }
  if (provider === 'instagram') {
    return { ...base, accountId: meta.instagramAccountId ?? null };
  }
  return base;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function consoleLogger(level, message) {
  const stamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`${stamp} ${String(level).toUpperCase().padEnd(5)} ${message}`);
}
