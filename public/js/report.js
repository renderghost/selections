// Sends browser errors to the server (POST /api/reports), which logs them and
// forwards them to Sentry when configured. No third-party script required.

const ENDPOINT = '/api/reports';
const MAX_REPORTS_PER_PAGE = 10;

// Errors that are not ours or not actionable.
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i, /extension:\/\//i, /^AbortError/];

const sent = new Set();
let count = 0;

const release = () => document.documentElement.dataset.release;

function toError(value) {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Records an error: always logs to the console, and reports it to the server
 * at most once per distinct message, and at most 10 times per page view.
 */
export function reportError(value, context = {}) {
  const error = toError(value);
  console.error(error, context);

  const signature = `${error.name}: ${error.message}`;
  const haystack = `${signature}\n${error.stack ?? ''}`;
  if (IGNORED.some((pattern) => pattern.test(haystack))) return;
  if (sent.has(signature) || count >= MAX_REPORTS_PER_PAGE) return;
  sent.add(signature);
  count++;

  const payload = JSON.stringify({
    type: 'client-error',
    name: error.name,
    message: error.message,
    stack: error.stack,
    url: location.href,
    userAgent: navigator.userAgent,
    release: release(),
    context,
  });

  try {
    const blob = new Blob([payload], { type: 'application/json' });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
    fetch(ENDPOINT, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {
    // Reporting must never throw.
  }
}

/** Catches anything not handled elsewhere. */
export function installGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, { where: 'window.onerror', source: event.filename, line: event.lineno, column: event.colno });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { where: 'unhandledrejection' });
  });
}
