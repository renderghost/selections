import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { CACHE_ETAG_KEY, CARD_IMAGE_SIZES, srcsetFor } from '../../public/js/constants.js';
import { AppError, BadRequestError, NotFoundError } from '../errors.js';
import { mockArtworkHandler } from '../tidal/mock.js';
import { createRateLimiter, parseReports } from './reports.js';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));
const viewsDir = fileURLToPath(new URL('../../views', import.meta.url));

const MAX_IDS_PER_REQUEST = 100;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const REQUEST_ID_PATTERN = /^[\w.:-]{1,100}$/;

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function parseIds(raw) {
  if (raw === undefined) return null;
  const ids = [raw].flat().flatMap((value) => String(value).split(',')).map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new BadRequestError('`ids` must list at least one playlist id.');
  if (ids.length > MAX_IDS_PER_REQUEST) throw new BadRequestError(`Ask for at most ${MAX_IDS_PER_REQUEST} playlists at a time.`);
  if (!ids.every((id) => ID_PATTERN.test(id))) throw new BadRequestError('`ids` contains an invalid playlist id.');
  return [...new Set(ids)];
}

/** Whether an If-None-Match header names this entity tag. */
export function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(',').some((tag) => {
    const value = tag.trim().replace(/^W\//, '');
    return value === '*' || value === `"${etag}"`;
  });
}

/**
 * Sends 304 when the browser already has this version. Compared directly
 * rather than via `req.fresh`, which (correctly, for HTTP caches) never says
 * "fresh" when the request carries Cache-Control: no-cache — and browsers add
 * that header to the app's deliberate `cache: 'no-store'` conditional requests.
 */
function sendVersioned(req, res, etag, body) {
  res.set('ETag', `"${etag}"`);
  if (etagMatches(req.get('if-none-match'), etag)) return res.status(304).end();
  return res.json(body);
}

export function createApp({ config, catalogue, reporter, logger, assets }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);

  // --- Request identity, logging, security headers -------------------------
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-Id', req.id);
    res.locals.nonce = randomBytes(16).toString('base64');
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      quietReqLogger: true,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url.startsWith('/static/') || req.url.startsWith('/__mock/') },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https://*.tidal.com'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ['https://embed.tidal.com'],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          reportUri: ['/api/reports'],
          reportTo: ['csp'],
        },
      },
      // Keep the default browser behaviour so TIDAL's embed sees which site it is on.
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: config.isProduction ? undefined : false,
    }),
  );
  app.use((req, res, next) => {
    // Absolute URL: browsers that reject the endpoint would also stop using report-uri.
    res.set('Reporting-Endpoints', `csp="${req.protocol}://${req.get('host')}/api/reports"`);
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });

  app.use(compression());

  // --- Static files ----------------------------------------------------------
  const staticOptions = { index: false, redirect: false };
  const immutable = express.static(publicDir, { ...staticOptions, immutable: true, maxAge: '365d' });
  const revalidate = express.static(publicDir, { ...staticOptions, maxAge: 0 });
  app.use('/static/:version', (req, res, next) =>
    (req.params.version === assets.version && assets.version !== 'dev' ? immutable : revalidate)(req, res, next),
  );
  // Stable URL for the social sharing image.
  app.use('/media', express.static(`${publicDir}/media`, { ...staticOptions, maxAge: '1d' }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/media/avatar.jpg'));
  app.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send('User-agent: *\nAllow: /\n'));
  if (config.tidal.mock) app.get('/__mock/art/:seed.svg', mockArtworkHandler);

  // --- Health ------------------------------------------------------------------
  app.get('/healthz', (req, res) => {
    const catalogueStatus = catalogue.status();
    const status = !catalogueStatus.ready ? (catalogueStatus.refreshing ? 'starting' : 'unavailable') : catalogueStatus.lastError ? 'degraded' : 'ok';
    // Always 200 while the process can serve; the body says how healthy the data is.
    res.set('Cache-Control', 'no-store').json({
      status,
      version: assets.version,
      uptimeSeconds: Math.round(process.uptime()),
      errorReporting: reporter.sentryEnabled ? 'sentry' : 'logs',
      catalogue: { ...catalogueStatus, lastError: catalogueStatus.lastError && { code: catalogueStatus.lastError.code, at: catalogueStatus.lastError.at } },
    });
  });

  // --- API ---------------------------------------------------------------------
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    next();
  });

  // Ids and revisions of every playlist. Browsers compare it with their cache
  // to fetch only what is new or changed; usually it is a bodiless 304.
  api.get(
    '/playlists/manifest',
    asyncRoute(async (req, res) => {
      const snapshot = await catalogue.get();
      sendVersioned(req, res, snapshot.etag, { etag: snapshot.etag, count: snapshot.records.length, items: snapshot.manifest });
    }),
  );

  // All playlists, or just `?ids=a,b,c`.
  api.get(
    '/playlists',
    asyncRoute(async (req, res) => {
      const ids = parseIds(req.query.ids);
      const snapshot = await catalogue.get();
      if (!ids) return sendVersioned(req, res, snapshot.etag, { etag: snapshot.etag, playlists: snapshot.records });
      const playlists = ids.map((id) => snapshot.byId.get(id)).filter(Boolean);
      const missing = ids.filter((id) => !snapshot.byId.has(id));
      res.json({ etag: snapshot.etag, playlists, missing });
    }),
  );

  const allowReport = createRateLimiter();
  api.post(
    '/reports',
    (req, res, next) => (allowReport(req.ip) ? next() : res.status(429).end()),
    express.json({ type: ['application/json', 'application/csp-report', 'application/reports+json'], limit: '16kb' }),
    (req, res) => {
      for (const report of parseReports(req.body)) {
        if (report.kind === 'csp') reporter.cspViolation(report, { requestId: req.id });
        else reporter.browserError(report, { requestId: req.id });
      }
      res.status(204).end();
    },
  );

  api.use((req, res, next) => next(new NotFoundError('No such API endpoint.')));
  app.use('/api', api);

  // --- Page ----------------------------------------------------------------------
  app.get('/', (req, res) => {
    // On a plain visit the newest playlist is the first card: start its artwork
    // download now rather than after the scripts run.
    const plainVisit = !Object.keys(req.query).length;
    const first = plainVisit ? catalogue.peek()?.records[0] : null;
    res.set('Cache-Control', 'no-cache');
    res.render('index', {
      nonce: res.locals.nonce,
      asset: assets.url,
      modules: assets.modules,
      release: assets.version,
      site: config.site,
      preloadArt: first?.art ? { srcset: srcsetFor(first.art), sizes: CARD_IMAGE_SIZES } : null,
      cacheEtagKey: CACHE_ETAG_KEY,
      year: new Date().getFullYear(),
    });
  });

  // --- Errors --------------------------------------------------------------------
  app.use((req, res, next) => next(new NotFoundError()));

  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const exposed = err instanceof AppError ? err.expose : status < 500 && err.expose !== false;
    const code = err.code && typeof err.code === 'string' ? err.code : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';

    if (status >= 500 && code !== 'CATALOGUE_UNAVAILABLE') {
      // CATALOGUE_UNAVAILABLE was already reported when the refresh failed.
      reporter.exception(err, { msg: `Request failed: ${req.method} ${req.originalUrl}`, extra: { requestId: req.id } });
    }
    if (res.headersSent) return next(err);
    if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));

    const message = exposed ? err.message : status >= 500 ? 'Something went wrong on our side. Please try again.' : 'Bad request.';
    res.status(status).set('Cache-Control', 'no-store');
    if (req.originalUrl.startsWith('/api/') || !req.accepts('html')) {
      return res.json({ error: { code, message, requestId: req.id } });
    }
    res.render('error', { status, message, requestId: req.id, asset: assets.url });
  });

  return app;
}
