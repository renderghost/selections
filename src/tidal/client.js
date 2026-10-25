import { TidalAuthError, TidalError } from '../errors.js';
import { parseRetryAfter, sleep, withRetry } from './retry.js';

const JSON_API = 'application/vnd.api+json';

export function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url.href;
}

/** Cursor for the next page, from `links.meta.nextCursor` or the `links.next` URL. */
export function nextCursor(doc) {
  const cursor = doc?.links?.meta?.nextCursor;
  if (cursor) return cursor;
  if (!doc?.links?.next) return undefined;
  return new URL(doc.links.next, 'https://placeholder.invalid').searchParams.get('page[cursor]') || undefined;
}

/**
 * Minimal client for TIDAL's JSON:API (https://openapi.tidal.com/v2).
 * Retries network errors, timeouts, 429s and 5xx responses; refreshes the
 * token once on a 401; raises typed errors with TIDAL's own error details.
 */
export function createTidalClient({ baseUrl, tokens, fetch = globalThis.fetch, logger, timeoutMs = 10_000, pageDelayMs = 0, retryOptions }) {
  async function attempt(url) {
    const token = await tokens.getToken();
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: JSON_API },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const what = cause?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : cause?.message;
      throw new TidalError(`TIDAL request ${what}`, { url, retryable: true, cause });
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch (cause) {
        throw new TidalError('TIDAL returned a response that is not valid JSON', { status: res.status, url, retryable: true, cause });
      }
    }

    const body = await res.json().catch(() => null);
    const first = body?.errors?.[0] ?? {};
    const details = {
      status: res.status,
      tidalCode: first.code,
      // TIDAL sits behind CloudFront; its id identifies the request if you ever need TIDAL support.
      requestId: res.headers.get('x-amz-cf-id') ?? res.headers.get('x-request-id') ?? first.id,
      url,
    };
    const reason = first.detail || res.statusText || 'no details';

    if (res.status === 401 || res.status === 403) {
      if (res.status === 401) tokens.invalidate();
      throw new TidalAuthError(`TIDAL denied access (${res.status}): ${reason}`, details);
    }
    if (res.status === 429 || res.status >= 500) {
      const error = new TidalError(`TIDAL is ${res.status === 429 ? 'rate limiting us' : 'having problems'} (${res.status}): ${reason}`, {
        ...details,
        retryable: true,
      });
      error.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      throw error;
    }
    throw new TidalError(`TIDAL request failed (${res.status}): ${reason}`, details);
  }

  async function get(path, query) {
    const url = buildUrl(baseUrl, path, query);
    let refreshedToken = false;
    return withRetry(
      async () => {
        try {
          return await attempt(url);
        } catch (error) {
          // An expired or revoked token: fetch a fresh one and try once more.
          if (error instanceof TidalAuthError && error.upstreamStatus === 401 && !refreshedToken) {
            refreshedToken = true;
            return attempt(url);
          }
          throw error;
        }
      },
      {
        ...retryOptions,
        // One line per retry: these are expected (e.g. rate limits) and recovered from.
        onRetry: ({ error, attempt: n, delay }) =>
          logger?.warn({ upstreamStatus: error.upstreamStatus, attempt: n, delayMs: Math.round(delay), path }, `Retrying TIDAL request: ${error.message}`),
      },
    );
  }

  /** Yields every page of a paginated collection. */
  async function* paginate(path, query, { maxPages = 50 } = {}) {
    const seen = new Set();
    let cursor;
    for (let page = 1; page <= maxPages; page++) {
      const doc = await get(path, cursor ? { ...query, 'page[cursor]': cursor } : query);
      yield doc;
      cursor = nextCursor(doc);
      if (!cursor) return;
      if (seen.has(cursor)) throw new TidalError('TIDAL returned the same page cursor twice', { url: buildUrl(baseUrl, path, query) });
      seen.add(cursor);
      // A short pause between pages keeps us under TIDAL's rate limit.
      if (pageDelayMs) await sleep(pageDelayMs);
    }
    logger?.warn({ path, maxPages }, 'Stopped paging TIDAL results at the page limit; some playlists may be missing');
  }

  return { get, paginate };
}
