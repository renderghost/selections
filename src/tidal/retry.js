export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRY_AFTER_MS = 30_000;

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/**
 * Runs `fn`, retrying failures marked `retryable` with exponential backoff and
 * jitter. Honours a server-provided `retryAfterMs`, but gives up rather than
 * stall a request when the server asks for a very long wait.
 */
export async function withRetry(fn, { retries = 3, baseDelayMs = 500, maxDelayMs = 8000, wait = sleep, random = Math.random, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || error?.retryable !== true) throw error;
      if (error.retryAfterMs > MAX_RETRY_AFTER_MS) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt * (0.8 + random() * 0.2));
      const delay = error.retryAfterMs ?? backoff;
      onRetry?.({ error, attempt: attempt + 1, delay });
      await wait(delay);
    }
  }
}
