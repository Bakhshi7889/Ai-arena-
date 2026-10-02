import { createConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { createRepo } from './db/repo.js';
import { createStorage } from './storage/index.js';
import { FetchTransport } from './lib/http.js';
import { QueueRunner, consoleLogger } from './queue/runner.js';
import { createApp } from './app.js';
import { generateApiKey, hashApiKey } from './lib/crypto.js';

/**
 * Wire everything together. Exported (rather than run inline) so tests can
 * boot the exact same stack the server uses.
 */
export async function createServer(overrides = {}) {
  const config = { ...createConfig(overrides.config ?? {}), ...overrides.configOverrides };
  const db = overrides.db ?? openDatabase(overrides.dbFile ?? config.paths.db);
  const repo = overrides.repo ?? createRepo(db);
  const storage = overrides.storage ?? createStorage(config);
  const transport = overrides.transport ?? new FetchTransport();
  const logger = overrides.logger ?? ((level, message) => consoleLogger(level, message));

  const runner = new QueueRunner({ repo, storage, config, transport, logger, sleep: overrides.sleep });
  const app = createApp({ repo, storage, config, runner, transport, logger });

  return { config, db, repo, storage, transport, runner, app, logger };
}

/** Make sure a first-run deployment has an API key to call itself with. */
export function ensureBootstrapKey(repo, { name = 'bootstrap' } = {}) {
  if (repo.apiKeys.list().length > 0) return null;
  const plaintext = generateApiKey();
  const key = repo.apiKeys.create({
    name,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, 12),
    scopes: ['publish', 'read', 'admin'],
  });
  return { key, plaintext };
}

async function main() {
  const server = await createServer();
  const { app, config, runner, repo } = server;

  const bootstrap = ensureBootstrapKey(repo);
  if (bootstrap) {
    // eslint-disable-next-line no-console
    console.log(`\n  Bootstrap API key (shown once):\n  ${bootstrap.plaintext}\n`);
  }

  if (config.queue.mode !== 'worker') {
    const http = await import('node:http');
    const listener = http.createServer(app).listen(config.port, config.host, () => {
      // eslint-disable-next-line no-console
      console.log(`  Posterly API      http://${config.host}:${config.port}`);
      // eslint-disable-next-line no-console
      console.log(`  Dashboard         ${config.publicBaseUrl}/`);
      // eslint-disable-next-line no-console
      console.log(`  Ingest endpoint   POST ${config.publicBaseUrl}/api/v1/posts`);
      // eslint-disable-next-line no-console
      console.log(`  Embed widget      <script src="${config.publicBaseUrl}/embed/poster.js"></script>\n`);
    });
    server.listener = listener;
  }

  if (config.queue.mode !== 'server') runner.start();

  const shutdown = async (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\n  ${signal} received, shutting down…`);
    runner.stop();
    server.listener?.close();
    try {
      server.db.close();
    } catch {
      /* noop */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start Posterly:', err);
    process.exit(1);
  });
}
