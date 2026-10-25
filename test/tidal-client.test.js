import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TidalAuthError, TidalError } from '../src/errors.js';
import { createTokenProvider } from '../src/tidal/auth.js';
import { buildUrl, createTidalClient, nextCursor } from '../src/tidal/client.js';
import { parseRetryAfter, withRetry } from '../src/tidal/retry.js';
import { jsonResponse, noWait, scriptedFetch, silentLogger } from './helpers.js';

const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const BASE = 'https://openapi.tidal.com/v2';
const token = (value = 'tok', expiresIn = 3600) => () => jsonResponse({ access_token: value, expires_in: expiresIn });

function makeClient(...apiHandlers) {
  const tokenCalls = [];
  const api = scriptedFetch(...apiHandlers);
  const fetch = async (url, init) => {
    if (url === TOKEN_URL) {
      tokenCalls.push(init);
      return jsonResponse({ access_token: `tok${tokenCalls.length}`, expires_in: 3600 });
    }
    return api.fetch(url, init);
  };
  const tokens = createTokenProvider({ clientId: 'id', clientSecret: 'secret', tokenUrl: TOKEN_URL, fetch, logger: silentLogger, retryOptions: noWait });
  const client = createTidalClient({ baseUrl: BASE, tokens, fetch, logger: silentLogger, retryOptions: noWait });
  return { client, tokenCalls, apiCalls: api.calls };
}

describe('withRetry', () => {
  it('retries retryable errors, then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        if (++attempts < 3) throw Object.assign(new Error('blip'), { retryable: true });
        return 'ok';
      },
      noWait,
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('does not retry other errors', async () => {
    let attempts = 0;
    await assert.rejects(withRetry(async () => { attempts++; throw new Error('nope'); }, noWait), /nope/);
    assert.equal(attempts, 1);
  });

  it('honours Retry-After, but gives up on very long waits', async () => {
    const waits = [];
    let attempts = 0;
    await withRetry(
      async () => {
        if (++attempts === 1) throw Object.assign(new Error('slow down'), { retryable: true, retryAfterMs: 2000 });
        return 'ok';
      },
      { wait: async (ms) => waits.push(ms) },
    );
    assert.deepEqual(waits, [2000]);
    await assert.rejects(withRetry(async () => { throw Object.assign(new Error('later'), { retryable: true, retryAfterMs: 120_000 }); }, noWait), /later/);
  });

  it('parses Retry-After seconds and dates', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
    assert.equal(parseRetryAfter(null), undefined);
  });
});

describe('token provider', () => {
  it('uses Basic auth for client credentials and caches the token', async () => {
    const { fetch, calls } = scriptedFetch(token());
    const tokens = createTokenProvider({ clientId: 'id', clientSecret: 'secret', tokenUrl: TOKEN_URL, fetch, retryOptions: noWait });
    assert.equal(tokens.mode, 'client');
    assert.equal(await tokens.getToken(), 'tok');
    assert.equal(await tokens.getToken(), 'tok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
    assert.equal(calls[0].init.body.get('grant_type'), 'client_credentials');
  });

  it('shares one request between concurrent callers', async () => {
    const { fetch, calls } = scriptedFetch(token());
    const tokens = createTokenProvider({ clientId: 'id', clientSecret: 's', tokenUrl: TOKEN_URL, fetch, retryOptions: noWait });
    await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()]);
    assert.equal(calls.length, 1);
  });

  it('renews shortly before expiry', async () => {
    let now = 0;
    const { fetch, calls } = scriptedFetch(token('a', 120), token('b', 120));
    const tokens = createTokenProvider({ clientId: 'id', clientSecret: 's', tokenUrl: TOKEN_URL, fetch, now: () => now, retryOptions: noWait });
    assert.equal(await tokens.getToken(), 'a');
    now = 61_000; // Within the 60 s safety margin of the 120 s lifetime.
    assert.equal(await tokens.getToken(), 'b');
    assert.equal(calls.length, 2);
  });

  it('uses the refresh-token grant in user mode', async () => {
    const { fetch, calls } = scriptedFetch(token());
    const tokens = createTokenProvider({ clientId: 'id', clientSecret: 's', refreshToken: 'rt', tokenUrl: TOKEN_URL, fetch, retryOptions: noWait });
    assert.equal(tokens.mode, 'user');
    await tokens.getToken();
    assert.equal(calls[0].init.body.get('grant_type'), 'refresh_token');
    assert.equal(calls[0].init.body.get('refresh_token'), 'rt');
  });

  it("explains TIDAL's rejection without retrying", async () => {
    // Shape observed from auth.tidal.com for unknown client ids.
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ error: 'invalid_grant', error_description: 'Client with token fakeid not found', status: 400, sub_status: 1005 }, 400));
    const tokens = createTokenProvider({ clientId: 'fakeid', clientSecret: 's', tokenUrl: TOKEN_URL, fetch, retryOptions: noWait });
    await assert.rejects(tokens.getToken(), (error) => {
      assert.ok(error instanceof TidalAuthError);
      assert.equal(error.subStatus, 1005);
      assert.match(error.message, /Client with token fakeid not found/);
      assert.match(error.message, /TIDAL_CLIENT_ID/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('retries when the token endpoint is down', async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({}, 503), token());
    const tokens = createTokenProvider({ clientId: 'id', clientSecret: 's', tokenUrl: TOKEN_URL, fetch, retryOptions: noWait });
    assert.equal(await tokens.getToken(), 'tok');
    assert.equal(calls.length, 2);
  });
});

describe('TIDAL client', () => {
  it('builds JSON:API query strings', () => {
    assert.equal(
      buildUrl(BASE, '/playlists', { 'filter[owners.id]': '42', include: ['coverArt'], empty: '', missing: undefined }),
      'https://openapi.tidal.com/v2/playlists?filter%5Bowners.id%5D=42&include=coverArt',
    );
  });

  it('sends the bearer token and JSON:API Accept header', async () => {
    const { client, apiCalls } = makeClient(() => jsonResponse({ data: [] }));
    await client.get('/playlists');
    assert.equal(apiCalls[0].init.headers.Authorization, 'Bearer tok1');
    assert.equal(apiCalls[0].init.headers.Accept, 'application/vnd.api+json');
  });

  it('gets a fresh token once after a 401', async () => {
    const { client, tokenCalls } = makeClient(
      () => jsonResponse({ errors: [{ code: 'UNAUTHORIZED', detail: 'Invalid token structure' }] }, 401),
      () => jsonResponse({ data: ['ok'] }),
    );
    assert.deepEqual(await client.get('/playlists'), { data: ['ok'] });
    assert.equal(tokenCalls.length, 2);
  });

  it('raises TidalAuthError with TIDAL details when access stays denied', async () => {
    const denied = () => jsonResponse({ errors: [{ code: 'FORBIDDEN', detail: 'Missing scope' }] }, 403, { 'x-amz-cf-id': 'cf-123' });
    const { client } = makeClient(denied);
    await assert.rejects(client.get('/playlists'), (error) => {
      assert.ok(error instanceof TidalAuthError);
      assert.equal(error.upstreamStatus, 403);
      assert.equal(error.tidalCode, 'FORBIDDEN');
      assert.equal(error.requestId, 'cf-123');
      assert.match(error.message, /Missing scope/);
      return true;
    });
  });

  it('retries 429 and 5xx responses and network failures', async () => {
    const { client, apiCalls } = makeClient(
      () => jsonResponse({ errors: [{ detail: 'Rate limit exceeded' }] }, 429, { 'Retry-After': '1' }),
      () => jsonResponse({}, 502),
      () => {
        throw new TypeError('fetch failed');
      },
      () => jsonResponse({ data: [] }),
    );
    assert.deepEqual(await client.get('/playlists'), { data: [] });
    assert.equal(apiCalls.length, 4);
  });

  it('gives up after the retry limit', async () => {
    const { client, apiCalls } = makeClient(() => jsonResponse({}, 500));
    await assert.rejects(client.get('/playlists'), TidalError);
    assert.equal(apiCalls.length, 4); // First attempt + 3 retries.
  });

  it('does not retry client errors', async () => {
    const { client, apiCalls } = makeClient(() => jsonResponse({ errors: [{ detail: 'bad filter' }] }, 400));
    await assert.rejects(client.get('/playlists'), /bad filter/);
    assert.equal(apiCalls.length, 1);
  });

  it('follows page cursors and stops at the last page', async () => {
    const { client, apiCalls } = makeClient(
      () => jsonResponse({ data: [1], links: { meta: { nextCursor: 'c2' } } }),
      () => jsonResponse({ data: [2], links: { next: '/playlists?page%5Bcursor%5D=c3' } }),
      () => jsonResponse({ data: [3], links: {} }),
    );
    const pages = [];
    for await (const page of client.paginate('/playlists', { include: 'coverArt' })) pages.push(...page.data);
    assert.deepEqual(pages, [1, 2, 3]);
    assert.match(apiCalls[1].url, /page%5Bcursor%5D=c2/);
    assert.match(apiCalls[2].url, /page%5Bcursor%5D=c3/);
    assert.match(apiCalls[2].url, /include=coverArt/);
  });

  it('refuses to loop on a repeated cursor', async () => {
    const { client } = makeClient(() => jsonResponse({ data: [], links: { meta: { nextCursor: 'same' } } }));
    await assert.rejects(async () => {
      for await (const page of client.paginate('/playlists')) void page;
    }, /same page cursor twice/);
  });

  it('reads cursors from either links.meta or links.next', () => {
    assert.equal(nextCursor({ links: { meta: { nextCursor: 'a' } } }), 'a');
    assert.equal(nextCursor({ links: { next: '/x?page[cursor]=b' } }), 'b');
    assert.equal(nextCursor({ links: {} }), undefined);
  });
});
