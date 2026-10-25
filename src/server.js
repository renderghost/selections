import { fileURLToPath } from 'node:url';
import { createCatalogue } from './catalogue.js';
import { loadEnvFile, readConfig } from './config.js';
import { createAssets } from './http/assets.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { createReporter } from './reporting.js';
import { createTokenProvider } from './tidal/auth.js';
import { createTidalClient } from './tidal/client.js';
import { createMockFetch } from './tidal/mock.js';
import { fetchPublicPlaylists } from './tidal/playlists.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function main() {
  loadEnvFile();

  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });
  const reporter = await createReporter({
    logger,
    dsn: config.sentry.dsn,
    release: config.sentry.release,
    environment: config.env,
  });

  // Last line of defence: record the crash, then exit and let the host restart us
  // (continuing after an unknown failure risks serving from a corrupt state).
  let crashing = false;
  const crash = async (error, origin) => {
    if (crashing) return;
    crashing = true;
    reporter.exception(error, { level: 'fatal', msg: `Fatal ${origin}; exiting`, tags: { origin } });
    await reporter.flush(2000);
    process.exit(1);
  };
  process.on('uncaughtException', (error) => crash(error, 'uncaughtException'));
  process.on('unhandledRejection', (reason) => crash(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection'));

  const { tidal } = config;
  const fetchImpl = tidal.mock ? createMockFetch() : globalThis.fetch;
  if (tidal.mock) logger.warn('TIDAL_MOCK is on: serving generated demo playlists, not your TIDAL account');

  const tokens = createTokenProvider({ ...tidal, fetch: fetchImpl, logger });
  const client = createTidalClient({ baseUrl: tidal.apiBaseUrl, tokens, fetch: fetchImpl, logger });
  const ownerId = tidal.userId || 'me';
  logger.info({ authMode: tokens.mode, ownerId }, 'TIDAL configured');

  const catalogue = createCatalogue({
    load: () => fetchPublicPlaylists({ client, ownerId, countryCode: tidal.countryCode, authMode: tokens.mode, logger }),
    ttlMs: config.catalogue.ttlMs,
    snapshotPath: tidal.mock ? null : config.catalogue.snapshotPath,
    logger,
    reporter,
  });

  const assets = await createAssets({
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    versioned: config.isProduction,
  });

  const app = createApp({ config, catalogue, reporter, logger, assets });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, assetVersion: assets.version, env: config.env }, `Listening on http://localhost:${config.port}`);
  });
  server.on('error', (error) => crash(error, 'server'));
  // Outlive load-balancer idle connections so they are never cut mid-request.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await catalogue.start();

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close(async () => {
      await reporter.flush(2000);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
