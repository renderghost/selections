import { serialiseError } from './errors.js';

// Sentry's own process handlers would duplicate ours (see serve() in site.js).
const SKIPPED_SENTRY_INTEGRATIONS = new Set(['OnUncaughtException', 'OnUnhandledRejection']);

/**
 * One place for every error, from the server or the browser. Always writes a
 * structured log line; also forwards to Sentry when SENTRY_DSN is set. Sentry
 * is loaded lazily, so it costs nothing when unused.
 */
export async function createReporter({ logger, dsn, release, environment, background = () => {} }) {
  // Serverless functions can be frozen once they respond: send reports before that.
  const sendSoon = () => sentry && background(sentry.flush(2000).catch(() => false));

  let sentry = null;

  if (dsn) {
    try {
      sentry = await import('@sentry/node');
      sentry.init({
        dsn,
        release,
        environment,
        sendDefaultPii: false,
        integrations: (defaults) => defaults.filter((i) => !SKIPPED_SENTRY_INTEGRATIONS.has(i.name)),
      });
      logger.info('Error reporting to Sentry is enabled');
    } catch (err) {
      sentry = null;
      logger.error({ err }, 'Could not start Sentry; errors will only be logged');
    }
  }

  return {
    get sentryEnabled() {
      return Boolean(sentry);
    },

    /** Server-side exception. `level` is 'error' (default), 'warn' or 'fatal'. */
    exception(err, { level = 'error', msg, tags, extra } = {}) {
      logger[level]({ err, tags, ...extra }, msg ?? err?.message ?? 'Unknown error');
      sentry?.captureException(err, { level: level === 'warn' ? 'warning' : level, tags, extra });
      sendSoon();
    },

    /** Error reported by a visitor's browser via POST /api/reports. */
    browserError(report, { requestId }) {
      logger.warn({ source: 'browser', report, requestId }, `Browser error: ${report.name}: ${report.message}`);
      sentry?.captureEvent({
        level: 'error',
        platform: 'javascript',
        release: report.release || release,
        exception: { values: [{ type: report.name, value: report.message }] },
        fingerprint: ['browser', report.name, report.message],
        tags: { source: 'browser', ...(report.context?.where ? { where: String(report.context.where) } : {}) },
        request: { url: report.url, headers: { 'User-Agent': report.userAgent } },
        extra: { stack: report.stack, context: report.context, requestId },
      });
      sendSoon();
    },

    /** Content-Security-Policy violation reported by a browser. */
    cspViolation(violation, { requestId }) {
      logger.warn({ source: 'csp', violation, requestId }, `CSP blocked ${violation.blockedURL} (${violation.directive})`);
      sentry?.captureEvent({
        level: 'warning',
        message: `CSP violation: ${violation.directive} blocked ${violation.blockedURL}`,
        fingerprint: ['csp', violation.directive, violation.blockedURL],
        tags: { source: 'csp' },
        extra: { violation, requestId },
      });
      sendSoon();
    },

    async flush(timeoutMs = 2000) {
      if (!sentry) return true;
      try {
        return await sentry.flush(timeoutMs);
      } catch (err) {
        logger.warn({ err: serialiseError(err) }, 'Sentry flush failed');
        return false;
      }
    },
  };
}
