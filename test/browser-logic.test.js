// The browser modules' pure logic, run in Node.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_SORT, applyView, fold, parseOrder, parseSort, popularTags, searchText } from '../public/js/filter.js';
import { formatDuration, formatFollowers, formatTracks, isNew, joinStats } from '../public/js/format.js';
import { diffManifest, mergePlaylists, syncPlaylists } from '../public/js/sync.js';
import { jsonResponse } from './helpers.js';

const record = (id, extra = {}) => ({ id, rev: `${id}-1`, title: `Title ${id}`, tags: [], description: '', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', ...extra });

describe('search and filters', () => {
  const records = [
    record('a', { title: 'Night Bloom', tags: ['Björk'], description: 'Icelandic deep dive', createdAt: '2024-03-01T00:00:00Z' }),
    record('b', { title: 'Static Drive', tags: ['rock'], description: 'Guitars & motorways', createdAt: '2024-05-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }),
    record('c', { title: 'after Dark', tags: ['Rock', 'Jazz'], description: 'Late night rock', createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-09-01T00:00:00Z' }),
  ];
  const entries = records.map((r) => ({ record: r, text: searchText(r) }));
  const ids = (view) => applyView(entries, view).map((r) => r.id);

  it('ignores case and accents', () => {
    assert.equal(fold('Björk DVOŘÁK'), 'bjork dvorak');
    assert.deepEqual(ids({ query: 'bjork' }), ['a']);
  });

  it('searches titles, tags and descriptions; every word must match', () => {
    assert.deepEqual(ids({ query: 'motorways' }), ['b']);
    assert.deepEqual(ids({ query: 'night' }).sort(), ['a', 'c']);
    assert.deepEqual(ids({ query: 'night rock' }), ['c']);
    assert.deepEqual(ids({ query: 'jazz' }), ['c']);
    assert.deepEqual(ids({ query: '  ' }).length, 3);
  });

  it('filters by tag, case-insensitively, whichever of a playlist\'s tags it is', () => {
    assert.deepEqual(ids({ tag: 'ROCK' }), ['b', 'c']);
    assert.deepEqual(ids({ tag: 'jazz' }), ['c']);
  });

  it('lists tags shared by several playlists, most common first, counting each playlist once', () => {
    assert.deepEqual(popularTags(records), [{ key: 'rock', label: 'rock', count: 2 }]);
    assert.equal(popularTags(records, { min: 1 }).length, 3);
    assert.deepEqual(popularTags([record('x', { tags: ['Rock', 'rock'] })], { min: 1 }), [{ key: 'rock', label: 'Rock', count: 1 }]);
  });
});

describe('sorting', () => {
  const records = [
    record('a', { title: 'Night Bloom', createdAt: '2024-03-01T00:00:00Z', updatedAt: '2024-06-01T00:00:00Z' }),
    record('b', { title: 'Static Drive', createdAt: '2024-05-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }),
    record('c', { title: 'after Dark', createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-09-01T00:00:00Z' }),
  ];
  const entries = records.map((r) => ({ record: r, text: searchText(r) }));
  const ids = (view) => applyView(entries, view).map((r) => r.id);

  it('shows the newest created first by default', () => {
    assert.equal(DEFAULT_SORT, 'created');
    assert.deepEqual(ids({}), ['b', 'c', 'a']);
  });

  it('sorts by created, updated or title, each in the order people expect first', () => {
    assert.deepEqual(ids({ sort: 'created' }), ['b', 'c', 'a']);
    assert.deepEqual(ids({ sort: 'updated' }), ['c', 'a', 'b']);
    assert.deepEqual(ids({ sort: 'title' }), ['c', 'a', 'b']);
  });

  it('can reverse every sort', () => {
    assert.deepEqual(ids({ sort: 'created', order: 'asc' }), ['a', 'c', 'b']);
    assert.deepEqual(ids({ sort: 'updated', order: 'asc' }), ['b', 'a', 'c']);
    assert.deepEqual(ids({ sort: 'title', order: 'desc' }), ['b', 'a', 'c']);
    assert.deepEqual(ids({ sort: 'created', order: 'desc' }), ids({ sort: 'created' }));
  });

  it('breaks ties by title, whichever way the sort runs', () => {
    const tied = [record('x', { title: 'Zebra' }), record('y', { title: 'Apple' })].map((r) => ({ record: r, text: '' }));
    assert.deepEqual(applyView(tied, { sort: 'created' }).map((r) => r.id), ['y', 'x']);
    assert.deepEqual(applyView(tied, { sort: 'created', order: 'asc' }).map((r) => r.id), ['y', 'x']);
  });

  it('keeps playlists without a date at the end, either way round', () => {
    const undated = [...entries, { record: record('u', { title: 'Undated', createdAt: null }), text: '' }];
    assert.equal(applyView(undated, { sort: 'created' }).at(-1).id, 'u');
    assert.equal(applyView(undated, { sort: 'created', order: 'asc' }).at(-1).id, 'u');
  });

  it('falls back to the defaults for anything unknown', () => {
    assert.deepEqual(ids({ sort: 'nonsense' }), ['b', 'c', 'a']);
    assert.deepEqual(ids({ sort: 'title', order: 'sideways' }), ['c', 'a', 'b']);
    assert.equal(parseSort('constructor'), 'created');
    assert.equal(parseOrder('sideways', 'title'), 'asc');
    assert.equal(parseOrder(undefined, 'updated'), 'desc');
  });

  it('still understands the names used by links shared before directions existed', () => {
    assert.equal(parseSort('newest'), 'created');
    assert.equal(parseSort('az'), 'title');
    assert.deepEqual(ids({ sort: 'az' }), ids({ sort: 'title' }));
    assert.deepEqual(ids({ sort: 'newest' }), ids({ sort: 'created' }));
  });
});

describe('formatting', () => {
  it('formats counts and durations in British English', () => {
    assert.equal(formatTracks(1), '1 track');
    assert.equal(formatTracks(1500), '1,500 tracks');
    assert.equal(formatFollowers(0), null);
    assert.equal(formatDuration(2880), '48 min');
    assert.equal(formatDuration(3723), '1 hr 2 min');
    assert.equal(formatDuration(7200), '2 hr');
    assert.equal(joinStats('a', null, 'b'), 'a · b');
  });

  it('marks recent playlists as new', () => {
    const now = Date.parse('2024-02-01T00:00:00Z');
    assert.equal(isNew({ createdAt: '2024-01-25T00:00:00Z' }, now), true);
    assert.equal(isNew({ createdAt: '2023-12-01T00:00:00Z' }, now), false);
    assert.equal(isNew({ createdAt: null }, now), false);
  });
});

describe('sync', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => (globalThis.fetch = realFetch));

  /** Fake server: answers manifest/playlists requests from `server` and records them. */
  function serve(server) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push(url);
      const etag = server.etag;
      if (url === '/api/playlists/manifest') {
        if (init.headers?.['If-None-Match'] === `"${etag}"`) return new Response(null, { status: 304 });
        return jsonResponse({ etag, items: server.records.map((r) => [r.id, r.rev]) });
      }
      const ids = new URL(url, 'http://x').searchParams.get('ids');
      const wanted = ids ? server.records.filter((r) => ids.split(',').includes(r.id)) : server.records;
      return jsonResponse({ etag, playlists: wanted, missing: [] });
    };
    return calls;
  }

  it('diffs a manifest against the cache', () => {
    const cached = [record('a'), record('b'), record('c')];
    const diff = diffManifest(cached, [['a', 'a-1'], ['b', 'b-2'], ['d', 'd-1']]);
    assert.deepEqual(diff, { added: ['d'], changed: ['b'], removed: ['c'] });
    assert.deepEqual(mergePlaylists(cached, [record('d'), { ...record('b'), rev: 'b-2' }], diff.removed).map((r) => r.id), ['a', 'b', 'd']);
  });

  it('downloads everything on a first visit', async () => {
    const calls = serve({ etag: 'e1', records: [record('a'), record('b')] });
    const result = await syncPlaylists({ cache: null });
    assert.equal(result.mode, 'full');
    assert.equal(result.playlists.length, 2);
    assert.deepEqual(calls, ['/api/playlists']);
  });

  it('downloads nothing when nothing changed', async () => {
    const calls = serve({ etag: 'e1', records: [record('a')] });
    const result = await syncPlaylists({ cache: { etag: 'e1', playlists: [record('a')] } });
    assert.equal(result.mode, 'unchanged');
    assert.deepEqual(calls, ['/api/playlists/manifest']);
  });

  it('downloads only new and changed playlists', async () => {
    const cached = Array.from({ length: 40 }, (_, i) => record(`p${i}`));
    const server = { etag: 'e2', records: [...cached.slice(1), { ...cached[5], rev: 'changed', title: 'Renamed' }, record('new')] };
    server.records.splice(4, 1); // p5 appears once, in its changed form.
    const calls = serve(server);
    const result = await syncPlaylists({ cache: { etag: 'e1', playlists: cached } });
    assert.equal(result.mode, 'delta');
    assert.deepEqual(result.added, ['new']);
    assert.equal(result.changed, 1);
    assert.equal(result.removed, 1);
    assert.equal(calls[1], '/api/playlists?ids=new,p5');
    assert.equal(result.playlists.find((r) => r.id === 'p5').title, 'Renamed');
    assert.equal(result.playlists.length, 40);
    assert.equal(result.etag, 'e2');
  });

  it('falls back to one full download when most things changed', async () => {
    const cached = Array.from({ length: 30 }, (_, i) => record(`p${i}`));
    const calls = serve({ etag: 'e2', records: cached.map((r) => ({ ...r, rev: 'new' })) });
    const result = await syncPlaylists({ cache: { etag: 'e1', playlists: cached } });
    assert.equal(result.mode, 'full');
    assert.deepEqual(calls, ['/api/playlists/manifest', '/api/playlists']);
  });

  it('uses the request the page started early, when it matches the cache', async () => {
    const calls = serve({ etag: 'e1', records: [record('a')] });
    const boot = { etag: 'e1', request: Promise.resolve(new Response(null, { status: 304 })) };
    const result = await syncPlaylists({ cache: { etag: 'e1', playlists: [record('a')] }, boot });
    assert.equal(result.mode, 'unchanged');
    assert.deepEqual(calls, []);
  });

  it('rejects malformed responses with a clear error', async () => {
    globalThis.fetch = async () => jsonResponse({ playlists: 'nope' });
    await assert.rejects(syncPlaylists({ cache: null }), { name: 'ApiError', code: 'BAD_RESPONSE' });
  });

  it('turns server errors into ApiErrors carrying the request id', async () => {
    globalThis.fetch = async () => jsonResponse({ error: { code: 'CATALOGUE_UNAVAILABLE', message: 'later', requestId: 'req-1' } }, 503, { 'Retry-After': '30' });
    await assert.rejects(syncPlaylists({ cache: null }), { code: 'CATALOGUE_UNAVAILABLE', status: 503, requestId: 'req-1', retryAfter: 30 });
  });
});
