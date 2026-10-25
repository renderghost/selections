// Talking to our own server. Every failure becomes an ApiError with a `code`
// the UI can explain to people, and the server's request id for support.

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', requestId, retryAfter, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }

  get isOffline() {
    return this.code === 'NETWORK' && navigator.onLine === false;
  }
}

const timeoutSignal = (ms) => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

/** Resolves a fetch() promise into { status, data }, or throws an ApiError. */
export async function readJson(responsePromise) {
  let res;
  try {
    res = await responsePromise;
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError';
    throw new ApiError(timedOut ? 'The request took too long.' : 'Could not reach the server.', {
      code: timedOut ? 'TIMEOUT' : 'NETWORK',
      cause,
    });
  }

  if (res.status === 304) return { status: 304 };

  let body = null;
  try {
    body = await res.json();
  } catch (cause) {
    if (res.ok) throw new ApiError('The server sent a response we could not read.', { status: res.status, code: 'BAD_RESPONSE', cause });
  }

  if (!res.ok) {
    throw new ApiError(body?.error?.message || `Request failed (${res.status}).`, {
      status: res.status,
      code: body?.error?.code || `HTTP_${res.status}`,
      requestId: body?.error?.requestId || res.headers.get('x-request-id') || undefined,
      retryAfter: Number(res.headers.get('retry-after')) || undefined,
    });
  }
  return { status: res.status, data: body };
}

// 503 means "the server has no playlists yet"; the caller waits Retry-After instead.
const isRetryable = (error) => ['NETWORK', 'TIMEOUT', 'BAD_RESPONSE'].includes(error.code) || (error.status >= 500 && error.status !== 503);

/** GET with a timeout, an optional ETag for a conditional request, and one retry on transient failures. */
export async function getJson(url, { etag, timeoutMs = 15_000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readJson(
        fetch(url, {
          headers: etag ? { 'If-None-Match': `"${etag}"` } : {},
          cache: 'no-store',
          signal: timeoutSignal(timeoutMs),
        }),
      );
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
}
