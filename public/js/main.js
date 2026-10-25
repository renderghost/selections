import './error-handlers.js';
import { ApiError } from './api.js';
import { createPlaylistDialog } from './dialog.js';
import { DEFAULT_SORT, applyView, isSort, popularTags, searchText, tagKey } from './filter.js';
import { formatDate } from './format.js';
import { createGrid } from './grid.js';
import { reportError } from './report.js';
import { loadCache, saveCache } from './store.js';
import { syncPlaylists } from './sync.js';
import { showToast } from './toast.js';

const RESYNC_AFTER_MS = 30 * 60_000;
const MAX_AUTO_RETRIES = 3;

const $ = (id) => document.getElementById(id);
const els = {
  main: $('playlists'),
  form: $('filters'),
  search: $('search'),
  sort: $('sort'),
  count: $('result-count'),
  announcer: $('announcer'),
  clear: $('clear-filters'),
  tags: $('tags'),
  notice: $('notice'),
  empty: $('empty'),
  grid: $('grid'),
  stats: $('masthead-stats'),
  brand: $('brand'),
};

const state = {
  playlists: [],
  entries: [],
  byId: new Map(),
  view: readViewFromUrl(),
  deepLink: new URL(location.href).searchParams.get('p'),
  lastSyncAt: 0,
  syncing: false,
  autoRetries: 0,
};

const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

// --- URL state ---------------------------------------------------------------------
// ?q= search, ?tag= artist/genre, ?sort=, ?p= open playlist. Shareable and bookmarkable.

function readViewFromUrl() {
  const params = new URL(location.href).searchParams;
  const sort = params.get('sort');
  return { query: params.get('q') ?? '', tag: params.get('tag') ?? '', sort: isSort(sort) ? sort : DEFAULT_SORT };
}

let urlTimer;
function flushViewToUrl() {
  clearTimeout(urlTimer);
  urlTimer = undefined;
  const url = new URL(location.href);
  const set = (key, value) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  set('q', state.view.query.trim());
  set('tag', state.view.tag);
  set('sort', state.view.sort === DEFAULT_SORT ? '' : state.view.sort);
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

/** Debounced, so typing doesn't spam the history API. */
function writeViewToUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(flushViewToUrl, 300);
}

// --- Rendering -------------------------------------------------------------------------

const grid = createGrid({
  list: els.grid,
  template: $('card-template'),
  onOpen: (id) => openPlaylist(id, { push: true }),
  onTag: (tag) => {
    setView({ tag });
    els.main.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  },
});

const sheet = createPlaylistDialog({ dialog: $('playlist-dialog'), onClose: handleDialogClosed });

function makeTagChip({ label, count, key }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tag-chip';
  chip.dataset.tag = key ? label : '';
  chip.dataset.key = key;
  chip.textContent = label;
  if (count) {
    const badge = document.createElement('span');
    badge.className = 'tag-count';
    badge.textContent = count;
    badge.setAttribute('aria-label', `(${plural(count, 'playlist')})`);
    chip.append(' ', badge);
  }
  return chip;
}

/** Chips for the common tags; built only when the playlists change, so focus is kept. */
function renderTags() {
  const tags = popularTags(state.playlists);
  els.tags.replaceChildren(makeTagChip({ label: 'All', key: '' }), ...tags.map(makeTagChip));
  els.tags.hidden = tags.length === 0;
}

function syncTagChips() {
  const active = tagKey(state.view.tag);
  let found = !active;
  for (const chip of els.tags.querySelectorAll('.tag-chip')) {
    const pressed = chip.dataset.key === active;
    chip.setAttribute('aria-pressed', String(pressed));
    found ||= pressed;
    if (chip.dataset.extra && !pressed) chip.remove();
  }
  // A tag picked from a card that isn't among the common ones: show it so it can be cleared.
  if (!found) {
    const chip = makeTagChip({ label: state.view.tag, key: active });
    chip.dataset.extra = 'true';
    chip.setAttribute('aria-pressed', 'true');
    els.tags.firstElementChild?.after(chip);
    els.tags.hidden = false;
  }
}

let announceTimer;
function renderView({ announce = false } = {}) {
  const visible = applyView(state.entries, state.view);
  grid.render(visible);

  const total = state.playlists.length;
  const filtered = Boolean(state.view.query.trim() || state.view.tag);
  els.count.textContent = filtered ? `${visible.length} of ${plural(total, 'playlist')}` : plural(total, 'playlist');
  els.clear.hidden = !filtered;
  syncTagChips();

  const noMatches = filtered && total > 0 && visible.length === 0;
  els.empty.hidden = !noMatches;
  if (noMatches) {
    const what = [state.view.query.trim() && `“${state.view.query.trim()}”`, state.view.tag && `the tag “${state.view.tag}”`].filter(Boolean).join(' and ');
    els.empty.querySelector('.empty-message').textContent = `No playlists match ${what}.`;
  }

  if (announce) {
    // Debounced so screen readers hear the result, not every keystroke.
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      els.announcer.textContent = filtered ? `${plural(visible.length, 'playlist')} found` : `Showing all ${plural(total, 'playlist')}`;
    }, 700);
  }
}

function setView(changes) {
  state.view = { ...state.view, ...changes };
  syncControls();
  renderView({ announce: true });
  writeViewToUrl();
}

function syncControls() {
  if (els.search.value !== state.view.query) els.search.value = state.view.query;
  els.sort.value = state.view.sort;
}

/** "Latest added 23 Oct 2026" in the masthead, from the newest playlist. */
function renderMastheadStats() {
  const newest = state.playlists.reduce((latest, record) => ((record.createdAt ?? '') > (latest?.createdAt ?? '') ? record : latest), null);
  const date = newest?.createdAt && formatDate(newest.createdAt);
  els.stats.hidden = !date;
  if (date) els.stats.textContent = `Latest added ${date}`;
}

function setPlaylists(playlists) {
  state.playlists = playlists;
  state.byId = new Map(playlists.map((record) => [record.id, record]));
  state.entries = playlists.map((record) => ({ record, text: searchText(record) }));
  grid.prune(state.byId);
  renderMastheadStats();
  renderTags();
  renderView();
}

// --- Dialog & history ----------------------------------------------------------------------

let closingFromHistory = false;

function openPlaylist(id, { push }) {
  const record = state.byId.get(id);
  if (!record) return false;
  if (push) {
    // Save the current filters into this history entry first, so Back returns to them.
    if (urlTimer) flushViewToUrl();
    const url = new URL(location.href);
    url.searchParams.set('p', id);
    history.pushState({ playlist: id }, '', url);
  }
  sheet.open(record);
  return true;
}

function handleDialogClosed() {
  if (closingFromHistory) {
    closingFromHistory = false;
    return;
  }
  // Opened from the grid: step back so Back doesn't reopen it. Arrived via a link: tidy the URL.
  if (history.state?.playlist) {
    history.back();
  } else {
    const url = new URL(location.href);
    url.searchParams.delete('p');
    history.replaceState(null, '', url);
  }
}

window.addEventListener('popstate', () => {
  const id = new URL(location.href).searchParams.get('p');
  if (id && state.byId.has(id)) {
    if (sheet.openId !== id) openPlaylist(id, { push: false });
  } else if (sheet.openId) {
    closingFromHistory = true;
    sheet.close();
  }
  state.view = readViewFromUrl();
  syncControls();
  renderView();
});

/** Opens ?p=<id> once its playlist is known; after a full sync, gives up politely. */
function openDeepLink({ final }) {
  if (!state.deepLink) return;
  if (openPlaylist(state.deepLink, { push: false })) {
    state.deepLink = null;
  } else if (final) {
    state.deepLink = null;
    handleDialogClosed();
    showToast('Sorry, that playlist isn’t available any more.');
  }
}

// --- Notices ---------------------------------------------------------------------------------

function showNotice(message, action) {
  els.notice.querySelector('.notice-message').textContent = message;
  const button = els.notice.querySelector('.notice-action');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.run;
  }
  els.notice.hidden = false;
}

const hideNotice = () => {
  els.notice.hidden = true;
};

function handleSyncError(error) {
  const known = error instanceof ApiError;
  // Network trouble is the visitor's, and 5xx errors are already logged by the server.
  const worthReporting = !known || error.code === 'BAD_RESPONSE' || (error.status >= 400 && error.status < 500);
  if (worthReporting) reportError(error, { where: 'sync', code: error.code, status: error.status, requestId: error.requestId });

  const retry = () => refresh();
  if (known && error.isOffline) window.addEventListener('online', retry, { once: true });

  if (state.playlists.length) {
    // We still have the saved copy on screen; mention it without getting in the way.
    showToast(known && error.isOffline ? 'You’re offline — showing your saved playlists.' : 'Couldn’t check for new playlists. Showing your saved copy.');
    return;
  }

  grid.render([]);
  els.count.textContent = '';
  if (known && error.isOffline) {
    showNotice('You’re offline. The playlists will load as soon as you reconnect.');
  } else if (known && error.code === 'CATALOGUE_UNAVAILABLE' && state.autoRetries < MAX_AUTO_RETRIES) {
    state.autoRetries++;
    const seconds = Math.min(error.retryAfter ?? 15, 60);
    showNotice('The playlists are temporarily unavailable — TIDAL may be having a moment. Trying again shortly…', { label: 'Try again now', run: retry });
    setTimeout(retry, seconds * 1000);
  } else {
    const reference = known && error.requestId ? ` (Reference: ${error.requestId.slice(0, 8)})` : '';
    showNotice(`Sorry, the playlists couldn’t be loaded.${reference}`, { label: 'Try again', run: retry });
  }
}

// --- Sync ------------------------------------------------------------------------------------

async function refresh({ boot } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  const cache = loadCache();
  try {
    const result = await syncPlaylists({ cache, boot });
    state.lastSyncAt = Date.now();
    state.autoRetries = 0;
    hideNotice();
    if (result.mode !== 'unchanged') saveCache(result);
    if (result.mode !== 'unchanged' || !state.playlists.length) setPlaylists(result.playlists);
    if (!result.playlists.length) showNotice('There are no playlists to show just yet. Please check back soon.');
    if (cache && result.added.length) {
      showToast(result.added.length === 1 ? 'A new playlist has been added since your last visit.' : `${result.added.length} new playlists have been added since your last visit.`);
    }
  } catch (error) {
    handleSyncError(error);
  } finally {
    state.syncing = false;
    openDeepLink({ final: true });
  }
}

// --- Controls --------------------------------------------------------------------------------

els.search.addEventListener('input', () => setView({ query: els.search.value }));
els.sort.addEventListener('change', () => setView({ sort: els.sort.value }));
els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  els.search.blur(); // Closes the on-screen keyboard on phones.
});
els.clear.addEventListener('click', () => {
  setView({ query: '', tag: '' });
  els.search.focus();
});
els.empty.querySelector('[data-action="clear-filters"]').addEventListener('click', () => {
  setView({ query: '', tag: '' });
  els.search.focus();
});
els.tags.addEventListener('click', (event) => {
  const chip = event.target.closest('.tag-chip');
  if (!chip) return;
  setView({ tag: chip.getAttribute('aria-pressed') === 'true' ? '' : chip.dataset.tag });
});

// The compact brand in the sticky bar returns to the top without adding a history entry.
els.brand.addEventListener('click', (event) => {
  event.preventDefault();
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

// Long-lived tabs: look for new playlists when the visitor comes back.
const resyncIfStale = () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastSyncAt > RESYNC_AFTER_MS) refresh();
};
document.addEventListener('visibilitychange', resyncIfStale);
window.addEventListener('pageshow', (event) => event.persisted && resyncIfStale());

// --- Start -------------------------------------------------------------------------------------

try {
  syncControls();
  const cached = loadCache();
  if (cached) {
    setPlaylists(cached.playlists); // Instant: no network needed to show the grid.
    openDeepLink({ final: false });
  }
  const boot = window.__selectionsBoot;
  window.__selectionsBoot = undefined;
  await refresh({ boot });
} catch (error) {
  reportError(error, { where: 'start' });
  showNotice('Sorry, something went wrong while starting up.', { label: 'Reload', run: () => location.reload() });
}
