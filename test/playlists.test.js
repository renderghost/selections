import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TidalAuthError } from '../src/errors.js';
import { fetchPublicPlaylists } from '../src/tidal/playlists.js';
import { createMockFetch } from '../src/tidal/mock.js';
import { createTokenProvider } from '../src/tidal/auth.js';
import { createTidalClient } from '../src/tidal/client.js';
import { artworkResource, playlistResource, silentLogger } from './helpers.js';

/** A client whose get/paginate answer from canned documents. */
function cannedClient({ pages, artworks = {} }) {
  const requests = [];
  return {
    requests,
    async *paginate(path, query) {
      requests.push({ path, query });
      for (const page of pages) yield page;
    },
    async get(path, query) {
      requests.push({ path, query });
      return { data: query['filter[id]'].map((id) => artworks[id]).filter(Boolean) };
    },
  };
}

const options = { ownerId: '42', countryCode: 'GB', authMode: 'client', logger: silentLogger };

describe('fetchPublicPlaylists', () => {
  it('asks TIDAL for the owner’s playlists with cover art, in one paginated query', async () => {
    const client = cannedClient({ pages: [{ data: [] }] });
    await fetchPublicPlaylists({ client, ...options });
    assert.deepEqual(client.requests[0], {
      path: '/playlists',
      query: { 'filter[owners.id]': '42', include: 'coverArt', countryCode: 'GB' },
    });
  });

  it('returns public playlists only, newest first, de-duplicated across pages', async () => {
    const client = cannedClient({
      pages: [
        { data: [playlistResource('old', { attributes: { createdAt: '2020-01-01T00:00:00Z' } }), playlistResource('secret', { attributes: { accessType: 'PRIVATE' } })], included: [artworkResource('art-old')] },
        { data: [playlistResource('new', { attributes: { createdAt: '2025-01-01T00:00:00Z' } }), playlistResource('old')], included: [artworkResource('art-new')] },
      ],
    });
    const records = await fetchPublicPlaylists({ client, ...options });
    assert.deepEqual(records.map((r) => r.id), ['new', 'old']);
    assert.ok(records.every((r) => r.art));
  });

  it('fetches artwork that TIDAL referenced but did not include', async () => {
    const client = cannedClient({ pages: [{ data: [playlistResource('a')] }], artworks: { 'art-a': artworkResource('art-a') } });
    const [record] = await fetchPublicPlaylists({ client, ...options });
    assert.equal(client.requests[1].path, '/artworks');
    assert.deepEqual(client.requests[1].query['filter[id]'], ['art-a']);
    assert.ok(record.art);
  });

  it('still returns playlists when artwork cannot be fetched', async () => {
    const client = cannedClient({ pages: [{ data: [playlistResource('a')] }] });
    client.get = async () => {
      throw new Error('artwork service down');
    };
    const [record] = await fetchPublicPlaylists({ client, ...options });
    assert.equal(record.art, null);
  });

  it('points to the fix when client credentials are not allowed to read playlists', async () => {
    const client = {
      async *paginate() {
        throw new TidalAuthError('TIDAL denied access (403): Forbidden', { status: 403 });
      },
    };
    await assert.rejects(fetchPublicPlaylists({ client, ...options }), /npm run tidal:login/);
  });

  it('works end to end against the mock TIDAL API', async () => {
    const fetch = createMockFetch({ count: 30, pageSize: 7, latencyMs: 0 });
    const tokens = createTokenProvider({ clientId: 'x', clientSecret: 'y', tokenUrl: 'https://auth.tidal.com/v1/oauth2/token', fetch });
    const client = createTidalClient({ baseUrl: 'https://openapi.tidal.com/v2', tokens, fetch, logger: silentLogger });
    const records = await fetchPublicPlaylists({ client, ...options });
    assert.equal(records.length, 29); // One of the 30 mock playlists is private.
    assert.ok(records.some((r) => r.tag === 'Björk'));
    assert.ok(records.some((r) => r.tag === null));
  });
});
