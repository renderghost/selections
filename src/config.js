import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './errors.js';

const MINUTE = 60_000;

/** Loads `.env` (if present) into process.env without overriding real env vars. */
export function loadEnvFile(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path);
}

const toInt = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a whole number, got "${value}".`);
  return n;
};

const toUrl = (value, name) => {
  if (!value) return null;
  try {
    return new URL(value).href.replace(/\/$/, '');
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, got "${value}".`);
  }
};

/**
 * Reads and validates configuration. Throws a ConfigError listing every
 * problem at once, so a misconfigured deploy fails fast with a clear message.
 */
export function readConfig(env = process.env) {
  const problems = [];
  const mock = env.TIDAL_MOCK === '1' || env.TIDAL_MOCK === 'true';

  const tidal = {
    clientId: env.TIDAL_CLIENT_ID?.trim() || '',
    clientSecret: env.TIDAL_CLIENT_SECRET?.trim() || '',
    userId: env.TIDAL_USER_ID?.trim() || '',
    refreshToken: env.TIDAL_REFRESH_TOKEN?.trim() || '',
    countryCode: (env.TIDAL_COUNTRY_CODE?.trim() || 'GB').toUpperCase(),
    apiBaseUrl: 'https://openapi.tidal.com/v2',
    tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
    mock,
  };

  if (!mock) {
    if (!tidal.clientId || !tidal.clientSecret) {
      const legacy = env.CLIENT_ID || env.CLIENT_SECRET
        ? ' Found CLIENT_ID/CLIENT_SECRET, which were the old Spotify settings — rename them to TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET with your TIDAL values.'
        : '';
      problems.push(`TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET are required.${legacy}`);
    }
    // With a refresh token the owner is known ("me"); otherwise we must be told whose playlists to list.
    if (!tidal.userId && !tidal.refreshToken) {
      problems.push('TIDAL_USER_ID is required (run `npm run tidal:login` to find it).');
    }
    if (!/^[A-Z]{2}$/.test(tidal.countryCode)) {
      problems.push(`TIDAL_COUNTRY_CODE must be a two-letter country code, got "${tidal.countryCode}".`);
    }
  }

  // Vercel sets VERCEL=1 at build and run time, plus the VERCEL_* values used below.
  const onVercel = Boolean(env.VERCEL);
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;

  let config;
  try {
    config = {
      env: env.VERCEL_ENV || env.NODE_ENV || 'development',
      onVercel,
      isProduction: env.NODE_ENV === 'production',
      port: toInt(env.PORT, 3000, 'PORT'),
      logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
      trustProxy: toInt(env.TRUST_PROXY, 1, 'TRUST_PROXY'),
      tidal,
      catalogue: {
        // CACHE_DURATION keeps the name used by the previous version of the app.
        ttlMs: Math.max(toInt(env.CACHE_DURATION, 10 * MINUTE, 'CACHE_DURATION'), 30_000),
        // Only the temp directory is writable on Vercel.
        snapshotPath: env.SNAPSHOT_PATH || (onVercel ? join(tmpdir(), 'selections', 'playlists.json') : '.cache/playlists.json'),
        // How long Vercel's CDN may serve API responses before asking the function again.
        cdnMaxAgeSeconds: toInt(env.CDN_CACHE_SECONDS, 600, 'CDN_CACHE_SECONDS'),
      },
      site: {
        url: toUrl(env.SITE_URL, 'SITE_URL') || vercelUrl || 'http://localhost:3000',
        profileUrl: toUrl(env.TIDAL_PROFILE_URL, 'TIDAL_PROFILE_URL'),
      },
      sentry: {
        dsn: env.SENTRY_DSN?.trim() || '',
        release: env.VERCEL_GIT_COMMIT_SHA || env.SOURCE_VERSION || undefined,
      },
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(error.message);
  }

  if (problems.length) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}\nSee .env.example for every setting.`);
  }
  return config;
}
