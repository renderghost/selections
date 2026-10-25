import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { readConfig } from '../src/config.js';
import { CatalogueUnavailableError } from '../src/errors.js';
import { createAssets } from '../src/http/assets.js';
import { createApp, etagMatches } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { fakeReporter } from './helpers.js';

const silentLogger = createLogger({ level: 'silent' });

const records = [
  { id: 'aaaa-1', rev: 'r1', title: 'One', tag: 'rock', art: { color: '#112233', sources: [['https://resources.tidal.com/images/1/320x320.jpg', 320]] } },
  { id: 'bbbb-2', rev: 'r2', title: 'Two', tag: null, art: null },
];
const snapshot = {
  records,
  byId: new Map(records.map((r) => [r.id, r])),
  manifest: records.map((r) => [r.id, r.rev]),
  etag: 'etag123',
  fetchedAt: Date.now(),
};

async function startServer({ catalogue, production = false, vercel = false } = {}) {
  const config = readConfig({ TIDAL_MOCK: '1', NODE_ENV: production ? 'production' : 'test', ...(vercel && { VERCEL: '1' }) });
  const assets = await createAssets({ publicDir: fileURLToPath(new URL('../public', import.meta.url)), versioned: production });
  const reporter = fakeReporter();
  const app = createApp({ config, catalogue, reporter, logger: silentLogger, assets });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  return { base, server, reporter, assets };
}

const healthyCatalogue = {
  get: async () => snapshot,
  peek: () => snapshot,
  status: () => ({ ready: true, count: 2, lastError: null, refreshing: false }),
};

describe('HTTP API', () => {
  let ctx;
  before(async () => (ctx = await startServer({ catalogue: healthyCatalogue })));
  after(() => ctx.server.close());

  it('serves the manifest with an ETag, and 304 when unchanged', async () => {
    const res = await fetch(`${ctx.base}/api/playlists/manifest`);
    assert.equal(res.headers.get('vercel-cdn-cache-control'), null); // Only on Vercel.
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"etag123"');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(await res.json(), { etag: 'etag123', count: 2, items: [['aaaa-1', 'r1'], ['bbbb-2', 'r2']] });

    // Browsers send Cache-Control: no-cache with the app's cache: 'no-store' requests.
    const again = await fetch(`${ctx.base}/api/playlists/manifest`, { headers: { 'If-None-Match': '"etag123"', 'Cache-Control': 'no-cache' } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');

    const changed = await fetch(`${ctx.base}/api/playlists/manifest`, { headers: { 'If-None-Match': '"older"' } });
    assert.equal(changed.status, 200);
  });

  it('matches entity tags the way browsers send them', () => {
    assert.equal(etagMatches('"abc"', 'abc'), true);
    assert.equal(etagMatches('W/"abc"', 'abc'), true);
    assert.equal(etagMatches('"x", "abc"', 'abc'), true);
    assert.equal(etagMatches('*', 'abc'), true);
    assert.equal(etagMatches('"abcd"', 'abc'), false);
    assert.equal(etagMatches(undefined, 'abc'), false);
  });

  it('serves all playlists, or just the ones asked for', async () => {
    const all = await (await fetch(`${ctx.base}/api/playlists`)).json();
    assert.equal(all.playlists.length, 2);

    const some = await (await fetch(`${ctx.base}/api/playlists?ids=bbbb-2,missing-3`)).json();
    assert.deepEqual(some.playlists.map((p) => p.id), ['bbbb-2']);
    assert.deepEqual(some.missing, ['missing-3']);
  });

  it('rejects invalid or excessive ids with a helpful 400', async () => {
    const bad = await fetch(`${ctx.base}/api/playlists?ids=${encodeURIComponent('<script>')}`);
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.ok(body.error.requestId);

    const tooMany = await fetch(`${ctx.base}/api/playlists?ids=${Array.from({ length: 101 }, (_, i) => `id-${i}`).join(',')}`);
    assert.equal(tooMany.status, 400);
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await fetch(`${ctx.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });

  it('accepts browser error reports and CSP violations', async () => {
    const post = (body, type = 'application/json') => fetch(`${ctx.base}/api/reports`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
    assert.equal((await post({ type: 'client-error', name: 'TypeError', message: 'boom', stack: 'x'.repeat(10_000) })).status, 204);
    assert.equal((await post({ 'csp-report': { 'blocked-uri': 'https://evil.example', 'effective-directive': 'script-src' } }, 'application/csp-report')).status, 204);
    assert.equal(ctx.reporter.calls.browserError[0].report.message, 'boom');
    assert.equal(ctx.reporter.calls.browserError[0].report.stack.length, 4000);
    assert.equal(ctx.reporter.calls.cspViolation[0].violation.directive, 'script-src');
  });

  it('rejects malformed report bodies', async () => {
    const res = await fetch(`${ctx.base}/api/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
  });

  it('sets security headers, including a per-request CSP nonce', async () => {
    const res = await fetch(`${ctx.base}/`);
    const csp = res.headers.get('content-security-policy');
    const html = await res.text();
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.match(csp, /frame-src https:\/\/embed\.tidal\.com/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.notEqual((await fetch(`${ctx.base}/`)).headers.get('content-security-policy'), csp);
  });

  it('preloads the first artwork and every module on the page', async () => {
    const html = await (await fetch(`${ctx.base}/`)).text();
    assert.match(html, /rel="preload" as="image" imagesrcset="https:\/\/resources\.tidal\.com\/images\/1\/320x320\.jpg 320w"/);
    assert.match(html, /rel="modulepreload" href="\/static\/dev\/js\/main\.js"/);
    // Searches and deep links show different first cards, so no preload then.
    assert.doesNotMatch(await (await fetch(`${ctx.base}/?q=rock`)).text(), /as="image"/);
  });

  it('serves a friendly HTML 404 page', async () => {
    const res = await fetch(`${ctx.base}/nope`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Page not found/);
  });

  it('reports health without leaking error details', async () => {
    const body = await (await fetch(`${ctx.base}/healthz`)).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.catalogue.count, 2);
  });
});

describe('HTTP API when TIDAL is unavailable', () => {
  let ctx;
  before(async () => {
    const error = new CatalogueUnavailableError(new Error('down'));
    error.retryAfterSeconds = 30;
    ctx = await startServer({
      catalogue: {
        get: async () => Promise.reject(error),
        peek: () => null,
        status: () => ({ ready: false, refreshing: false, count: 0, lastError: { code: 'TIDAL_AUTH', message: 'secret detail', at: 'now' } }),
      },
    });
  });
  after(() => ctx.server.close());

  it('answers 503 with Retry-After and a visitor-friendly message', async () => {
    const res = await fetch(`${ctx.base}/api/playlists`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    const body = await res.json();
    assert.equal(body.error.code, 'CATALOGUE_UNAVAILABLE');
    assert.match(body.error.message, /temporarily unavailable/);
    // Already reported by the catalogue when the refresh failed; not double-reported.
    assert.equal(ctx.reporter.calls.exception.length, 0);
  });

  it('still serves the page, and health hides internal messages', async () => {
    assert.equal((await fetch(`${ctx.base}/`)).status, 200);
    const health = await (await fetch(`${ctx.base}/healthz`)).json();
    assert.equal(health.status, 'unavailable');
    assert.deepEqual(health.catalogue.lastError, { code: 'TIDAL_AUTH', at: 'now' });
  });
});

describe('static assets in production', () => {
  let ctx;
  before(async () => (ctx = await startServer({ catalogue: healthyCatalogue, production: true })));
  after(() => ctx.server.close());

  it('serves versioned assets as immutable, and others for revalidation', async () => {
    assert.match(ctx.assets.version, /^[0-9a-f]{10}$/);
    const current = await fetch(`${ctx.base}/static/${ctx.assets.version}/css/app.css`);
    assert.equal(current.status, 200);
    assert.equal(current.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const old = await fetch(`${ctx.base}/static/0000000000/css/app.css`);
    assert.equal(old.headers.get('cache-control'), 'public, max-age=0');
  });

});

describe('on Vercel', () => {
  let ctx;
  before(async () => (ctx = await startServer({ catalogue: healthyCatalogue, vercel: true })));
  after(() => ctx.server.close());

  it('lets the CDN cache playlist data, while browsers still revalidate', async () => {
    const res = await fetch(`${ctx.base}/api/playlists/manifest`);
    assert.equal(res.headers.get('vercel-cdn-cache-control'), 'max-age=600, stale-while-revalidate=86400');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('never lets the CDN cache errors or the page', async () => {
    assert.equal((await fetch(`${ctx.base}/api/playlists?ids=%3Cbad%3E`)).headers.get('vercel-cdn-cache-control'), null);
    assert.equal((await fetch(`${ctx.base}/`)).headers.get('vercel-cdn-cache-control'), null);
  });
});

describe('unexpected errors', () => {
  let ctx;
  before(async () => {
    ctx = await startServer({
      catalogue: { get: async () => Promise.reject(new Error('internal detail: db password hunter2')), peek: () => null, status: () => ({}) },
    });
  });
  after(() => ctx.server.close());

  it('are reported in full but never shown to visitors', async () => {
    const res = await fetch(`${ctx.base}/api/playlists`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'INTERNAL');
    assert.doesNotMatch(body.error.message, /hunter2/);
    assert.equal(res.headers.get('x-request-id'), body.error.requestId);
    assert.match(ctx.reporter.calls.exception[0].error.message, /hunter2/);
    assert.equal(ctx.reporter.calls.exception[0].options.extra.requestId, body.error.requestId);
  });
});
