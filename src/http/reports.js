// Parsing for POST /api/reports. Everything here is untrusted visitor input:
// accept only known fields, cap every string, never echo anything back.

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const clipNumber = (value) => (Number.isFinite(value) ? value : undefined);

function clipContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(context).slice(0, 12)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) out[clip(key, 40)] = typeof value === 'string' ? clip(value, 300) : value;
  }
  return out;
}

const clientError = (body) => ({
  kind: 'client-error',
  name: clip(body.name, 100) || 'Error',
  message: clip(body.message, 500) || '(no message)',
  stack: clip(body.stack, 4000),
  url: clip(body.url, 500),
  userAgent: clip(body.userAgent, 300),
  release: clip(body.release, 40),
  context: clipContext(body.context),
});

const cspViolation = ({ documentURL, blockedURL, directive, sourceFile, lineNumber, disposition }) => ({
  kind: 'csp',
  documentURL: clip(documentURL, 500),
  blockedURL: clip(blockedURL, 500) || '(unknown)',
  directive: clip(directive, 100) || '(unknown)',
  sourceFile: clip(sourceFile, 500),
  lineNumber: clipNumber(lineNumber),
  disposition: clip(disposition, 20),
});

/**
 * Normalises any of the three report formats browsers send:
 * our own client-error beacon, legacy `report-uri` CSP reports, and the
 * Reporting API (`report-to`) batch format. Returns at most 10 reports.
 */
export function parseReports(body) {
  if (Array.isArray(body)) {
    return body
      .slice(0, 10)
      .filter((report) => report?.type === 'csp-violation' && report.body)
      .map(({ body: b }) =>
        cspViolation({
          documentURL: b.documentURL,
          blockedURL: b.blockedURL,
          directive: b.effectiveDirective,
          sourceFile: b.sourceFile,
          lineNumber: b.lineNumber,
          disposition: b.disposition,
        }),
      );
  }
  if (body?.['csp-report']) {
    const r = body['csp-report'];
    return [
      cspViolation({
        documentURL: r['document-uri'],
        blockedURL: r['blocked-uri'],
        directive: r['effective-directive'] || r['violated-directive'],
        sourceFile: r['source-file'],
        lineNumber: r['line-number'],
        disposition: r.disposition,
      }),
    ];
  }
  if (body?.type === 'client-error') return [clientError(body)];
  return [];
}

/** Fixed-window rate limiter: `perKey` events per key and `total` overall, per window. */
export function createRateLimiter({ perKey = 20, total = 600, windowMs = 60_000, now = Date.now } = {}) {
  let windowStart = now();
  let overall = 0;
  const counts = new Map();

  return function allow(key) {
    if (now() - windowStart >= windowMs) {
      windowStart = now();
      overall = 0;
      counts.clear();
    }
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    overall++;
    return count <= perKey && overall <= total;
  };
}
