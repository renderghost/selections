import { TidalAuthError, TidalError } from '../errors.js';
import { withRetry } from './retry.js';

const EXPIRY_MARGIN_MS = 60_000;

/**
 * Supplies TIDAL access tokens, cached until shortly before they expire.
 * Concurrent callers share one in-flight token request.
 *
 * - 'client' mode: client-credentials grant (no user involved).
 * - 'user' mode: refresh-token grant, for when TIDAL requires a user's
 *   authorisation to read playlists. See scripts/tidal-login.js.
 */
export function createTokenProvider({
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl,
  fetch = globalThis.fetch,
  logger,
  now = Date.now,
  retryOptions,
}) {
  const mode = refreshToken ? 'user' : 'client';
  let currentRefreshToken = refreshToken;
  let cached = null;
  let pending = null;

  async function requestToken() {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    let body;
    if (mode === 'client') {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      body = new URLSearchParams({ grant_type: 'client_credentials' });
    } else {
      body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    }

    let res;
    try {
      res = await fetch(tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    } catch (cause) {
      throw new TidalError(`Could not reach the TIDAL token endpoint: ${cause.message}`, { url: tokenUrl, retryable: true, cause });
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = payload.error_description || payload.error || res.statusText || `HTTP ${res.status}`;
      const details = { status: res.status, tidalCode: payload.error, subStatus: payload.sub_status, url: tokenUrl };
      if (res.status === 429 || res.status >= 500) {
        throw new TidalError(`TIDAL token endpoint failed (${res.status}): ${reason}`, { ...details, retryable: true });
      }
      const fix = mode === 'client'
        ? 'Check TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET match your app at developer.tidal.com.'
        : 'TIDAL_REFRESH_TOKEN was rejected — run `npm run tidal:login` to get a new one.';
      throw new TidalAuthError(`TIDAL refused to issue an access token (${res.status}: ${reason}). ${fix}`, details);
    }
    if (!payload.access_token) {
      throw new TidalAuthError('TIDAL token response did not include an access token.', { url: tokenUrl });
    }

    if (mode === 'user' && payload.refresh_token && payload.refresh_token !== currentRefreshToken) {
      currentRefreshToken = payload.refresh_token;
      logger?.warn('TIDAL issued a new refresh token. If playlists stop loading after a restart, run `npm run tidal:login` again.');
    }

    const expiresInSeconds = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600;
    cached = { accessToken: payload.access_token, expiresAt: now() + expiresInSeconds * 1000 };
    logger?.debug({ mode, expiresInSeconds }, 'Obtained TIDAL access token');
    return cached.accessToken;
  }

  return {
    mode,
    async getToken() {
      if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.accessToken;
      pending ??= withRetry(requestToken, retryOptions).finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate() {
      cached = null;
    },
  };
}
