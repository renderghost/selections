import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { createRateLimiter, parseReports } from '../src/http/reports.js';

describe('parseReports', () => {
  it('accepts our client-error beacon, keeping only known fields', () => {
    const [report] = parseReports({ type: 'client-error', name: 'TypeError', message: 'm', evil: 'x', context: { where: 'sync', nested: { a: 1 } } });
    assert.equal(report.kind, 'client-error');
    assert.equal(report.evil, undefined);
    assert.deepEqual(report.context, { where: 'sync' });
  });

  it('accepts legacy report-uri CSP reports', () => {
    const [report] = parseReports({ 'csp-report': { 'blocked-uri': 'https://x.example/a.js', 'violated-directive': 'script-src-elem', 'line-number': 3 } });
    assert.deepEqual([report.kind, report.blockedURL, report.directive, report.lineNumber], ['csp', 'https://x.example/a.js', 'script-src-elem', 3]);
  });

  it('accepts Reporting API batches, ignoring other report types', () => {
    const reports = parseReports([
      { type: 'csp-violation', body: { blockedURL: 'inline', effectiveDirective: 'script-src-elem' } },
      { type: 'deprecation', body: {} },
    ]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].blockedURL, 'inline');
  });

  it('ignores anything else', () => {
    assert.deepEqual(parseReports({ hello: 'world' }), []);
    assert.deepEqual(parseReports(null), []);
  });
});

describe('createRateLimiter', () => {
  it('limits per key and overall within a window', () => {
    let now = 0;
    const allow = createRateLimiter({ perKey: 2, total: 3, windowMs: 1000, now: () => now });
    assert.deepEqual([allow('a'), allow('a'), allow('a')], [true, true, false]);
    assert.equal(allow('b'), false); // Overall limit reached.
    now = 1000;
    assert.equal(allow('a'), true);
  });
});

describe('readConfig', () => {
  const valid = { TIDAL_CLIENT_ID: 'id', TIDAL_CLIENT_SECRET: 'secret', TIDAL_USER_ID: '123' };

  it('reads a valid configuration with sensible defaults', () => {
    const config = readConfig(valid);
    assert.equal(config.port, 3000);
    assert.equal(config.tidal.countryCode, 'GB');
    assert.equal(config.catalogue.ttlMs, 600_000);
    assert.equal(config.site.profileUrl, null);
  });

  it('lists every problem at once', () => {
    assert.throws(
      () => readConfig({ PORT: 'abc' }),
      (error) => error instanceof ConfigError && /TIDAL_CLIENT_ID/.test(error.message) && /TIDAL_USER_ID/.test(error.message) && /PORT/.test(error.message),
    );
  });

  it('spots the old Spotify variable names', () => {
    assert.throws(() => readConfig({ CLIENT_ID: 'spotify', CLIENT_SECRET: 'x', TIDAL_USER_ID: '1' }), /old Spotify settings/);
  });

  it('does not need a user id when a refresh token is set', () => {
    const config = readConfig({ TIDAL_CLIENT_ID: 'id', TIDAL_CLIENT_SECRET: 's', TIDAL_REFRESH_TOKEN: 'rt' });
    assert.equal(config.tidal.userId, '');
  });

  it('needs no TIDAL settings in mock mode', () => {
    assert.equal(readConfig({ TIDAL_MOCK: '1' }).tidal.mock, true);
  });

  it('adapts to Vercel: writable temp dir, site URL, release and environment', () => {
    const config = readConfig({
      ...valid,
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_PRODUCTION_URL: 'selections.vercel.app',
      VERCEL_GIT_COMMIT_SHA: 'abc123',
    });
    assert.equal(config.onVercel, true);
    assert.equal(config.env, 'preview');
    assert.match(config.catalogue.snapshotPath, /selections[\\/]playlists\.json$/);
    assert.doesNotMatch(config.catalogue.snapshotPath, /^\.cache/);
    assert.equal(config.site.url, 'https://selections.vercel.app');
    assert.equal(config.sentry.release, 'abc123');
    assert.equal(readConfig({ ...valid, VERCEL: '1', SITE_URL: 'https://example.com' }).site.url, 'https://example.com');
  });

  it('validates URLs', () => {
    assert.throws(() => readConfig({ ...valid, SITE_URL: 'not a url' }), /SITE_URL/);
    assert.equal(readConfig({ ...valid, TIDAL_PROFILE_URL: 'https://tidal.com/@beere/' }).site.profileUrl, 'https://tidal.com/@beere');
  });
});
