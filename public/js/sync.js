// Keeps the browser's copy of the playlists current while downloading as little
// as possible:
//
//   1. Ask for the manifest with the cached etag → usually a bodiless 304. Done.
//   2. Otherwise compare the manifest (id + revision per playlist) with the
//      cache, and fetch only playlists that are new or changed.
//   3. Fall back to one full download when most of it changed anyway.

import { ApiError, getJson, readJson } from './api.js';
import { isRecord } from './store.js';

const BATCH_SIZE = 50;
const FULL_DOWNLOAD_RATIO = 0.5;

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export function diffManifest(cached, items) {
  const known = new Map(cached.map((record) => [record.id, record.rev]));
  const live = new Set();
  const added = [];
  const changed = [];
  for (const [id, rev] of items) {
    live.add(id);
    if (!known.has(id)) added.push(id);
    else if (known.get(id) !== rev) changed.push(id);
  }
  const removed = cached.filter((record) => !live.has(record.id)).map((record) => record.id);
  return { added, changed, removed };
}

export function mergePlaylists(cached, fetched, removed) {
  const byId = new Map(cached.map((record) => [record.id, record]));
  for (const id of removed) byId.delete(id);
  for (const record of fetched) byId.set(record.id, record);
  return [...byId.values()];
}

function expectPlaylists(data) {
  if (typeof data?.etag !== 'string' || !Array.isArray(data.playlists) || !data.playlists.every(isRecord)) {
    throw new ApiError('The server sent playlists in an unexpected format.', { code: 'BAD_RESPONSE' });
  }
  return data;
}

function expectManifest(data) {
  if (typeof data?.etag !== 'string' || !Array.isArray(data.items) || !data.items.every((item) => Array.isArray(item) && item.length === 2)) {
    throw new ApiError('The server sent a manifest in an unexpected format.', { code: 'BAD_RESPONSE' });
  }
  return data;
}

async function downloadAll() {
  const { data } = await getJson('/api/playlists');
  return expectPlaylists(data);
}

/**
 * @param cache  { etag, playlists } from localStorage, or null
 * @param boot   { etag, request } started by the inline script in <head>, if any
 * @returns { playlists, etag, added, changed, removed, mode: 'unchanged' | 'delta' | 'full' }
 */
export async function syncPlaylists({ cache, boot }) {
  if (!cache) {
    // The boot script only requested everything when it found no cached etag.
    const data = boot && !boot.etag ? expectPlaylists((await readJson(boot.request)).data) : await downloadAll();
    return { playlists: data.playlists, etag: data.etag, added: [], changed: 0, removed: 0, mode: 'full' };
  }

  const response = boot?.etag === cache.etag ? await readJson(boot.request) : await getJson('/api/playlists/manifest', { etag: cache.etag });
  if (response.status === 304) {
    return { playlists: cache.playlists, etag: cache.etag, added: [], changed: 0, removed: 0, mode: 'unchanged' };
  }

  const manifest = expectManifest(response.data);
  const { added, changed, removed } = diffManifest(cache.playlists, manifest.items);
  const wanted = [...added, ...changed];

  if (wanted.length > Math.max(20, manifest.items.length * FULL_DOWNLOAD_RATIO)) {
    const data = await downloadAll();
    return { playlists: data.playlists, etag: data.etag, added, changed: changed.length, removed: removed.length, mode: 'full' };
  }

  const pages = await Promise.all(
    chunk(wanted, BATCH_SIZE).map(async (ids) => expectPlaylists((await getJson(`/api/playlists?ids=${ids.map(encodeURIComponent).join(',')}`)).data)),
  );
  // The catalogue changed between our two requests: simplest to start afresh.
  if (pages.some((page) => page.missing?.length)) {
    const data = await downloadAll();
    return { playlists: data.playlists, etag: data.etag, added, changed: changed.length, removed: removed.length, mode: 'full' };
  }

  return {
    playlists: mergePlaylists(cache.playlists, pages.flatMap((page) => page.playlists), removed),
    etag: manifest.etag,
    added,
    changed: changed.length,
    removed: removed.length,
    mode: 'delta',
  };
}
