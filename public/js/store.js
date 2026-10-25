// The browser's copy of the playlists, kept in localStorage so repeat visits
// render instantly and only download what changed. ~100 KB for 150 playlists.

import { CACHE_ETAG_KEY, CACHE_KEY } from './constants.js';
import { reportError } from './report.js';

export const isRecord = (record) =>
  typeof record?.id === 'string' && typeof record.rev === 'string' && typeof record.title === 'string';

function storage() {
  try {
    return window.localStorage; // Throws when storage is blocked.
  } catch {
    return null;
  }
}

export function clearCache() {
  try {
    storage()?.removeItem(CACHE_KEY);
    storage()?.removeItem(CACHE_ETAG_KEY);
  } catch {
    // Nothing more we can do.
  }
}

/** The cached { etag, savedAt, playlists }, or null if missing or unusable. */
export function loadCache() {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data?.etag !== 'string' || !Array.isArray(data.playlists) || !data.playlists.every(isRecord)) {
      throw new Error('Cached playlists have an unexpected shape');
    }
    return data;
  } catch (error) {
    reportError(error, { where: 'loadCache' });
    clearCache();
    return null;
  }
}

export function saveCache({ etag, playlists }) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(CACHE_KEY, JSON.stringify({ etag, savedAt: Date.now(), playlists }));
    // Written last, read by the boot script in <head>: only set once the data it describes is saved.
    store.setItem(CACHE_ETAG_KEY, etag);
    return true;
  } catch (error) {
    clearCache();
    // A full disk is the browser's business, not a bug; anything else is worth knowing about.
    if (error?.name !== 'QuotaExceededError') reportError(error, { where: 'saveCache' });
    return false;
  }
}
