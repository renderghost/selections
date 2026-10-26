// The playlist grid. Cards are created once per playlist and reused: filtering
// and sorting only re-order existing elements, so loaded artwork is never
// re-requested and typing in the search box stays instant.

import { CARD_IMAGE_SIZES, EAGER_CARD_COUNT, srcsetFor } from './constants.js';
import { formatDuration, formatTracks, isNew, joinStats } from './format.js';
import { reportError } from './report.js';

/** A sensible single image for browsers that ignore srcset: the first ≥ 320px wide. */
export const fallbackSrc = (art) => (art.sources.find(([, width]) => width >= 320) ?? art.sources.at(-1))[0];

let reportedArtworkFailure = false;

// Per-image listeners (not delegated): a card can be detached by filtering while its image loads.
function onImageLoad(event) {
  event.currentTarget.classList.remove('is-loading');
}

function onImageError(event) {
  const img = event.currentTarget;
  img.classList.remove('is-loading');
  img.closest('.card, .sheet')?.classList.add('no-art');
  if (!reportedArtworkFailure) {
    reportedArtworkFailure = true;
    reportError(new Error('Playlist artwork failed to load'), { where: 'artwork', src: img.currentSrc || img.src });
  }
}

/** Points an <img> at a playlist's artwork, fading it in once loaded. */
export function setArtwork(img, art, { sizes, loading = 'lazy', priority = false }) {
  const srcset = srcsetFor(art);
  if (srcset && img.getAttribute('srcset') === srcset) return; // Unchanged: keep what is loaded.
  img.removeAttribute('srcset');
  img.removeAttribute('src');
  if (!art) return;
  // Order matters: `loading` must be set before the browser sees a source.
  img.loading = loading;
  if (priority) img.fetchPriority = 'high';
  img.classList.add('is-loading');
  img.addEventListener('load', onImageLoad);
  img.addEventListener('error', onImageError);
  img.sizes = sizes;
  img.srcset = srcset;
  img.src = fallbackSrc(art);
}

/** A clickable tag; the grid's delegated click handler turns it into a filter. */
function makeTagChip(tag) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tag-chip';
  chip.dataset.tag = tag;
  chip.textContent = tag;
  chip.setAttribute('aria-label', `Show all “${tag}” playlists`);
  return chip;
}

export function createGrid({ list, template, onOpen, onTag }) {
  const cards = new Map(); // id → { el, rev }
  let order = null; // null until the first render, so the loading skeletons are always replaced
  let firstRender = true;

  function fillImage(el, record, { eager, priority }) {
    el.classList.toggle('no-art', !record.art);
    el.style.setProperty('--art', record.art?.color ?? '');
    setArtwork(el.querySelector('img'), record.art, {
      loading: eager ? 'eager' : 'lazy',
      priority,
      // `auto` lets lazy images use their laid-out width; eager ones need the explicit list.
      sizes: eager ? CARD_IMAGE_SIZES : `auto, ${CARD_IMAGE_SIZES}`,
    });
  }

  function fillText(el, record) {
    el.dataset.id = record.id;
    const link = el.querySelector('.card-link');
    link.href = `?p=${encodeURIComponent(record.id)}`;
    link.textContent = record.title;
    link.title = record.title; // The card shows one line, so long titles are cut short.

    el.querySelector('.card-tags').replaceChildren(...record.tags.map(makeTagChip));
    el.querySelector('.card-stats').textContent = joinStats(formatTracks(record.tracks), formatDuration(record.duration));
    el.querySelector('.badge').hidden = !isNew(record);
  }

  function cardFor(record, index) {
    let card = cards.get(record.id);
    if (!card) {
      const el = template.content.firstElementChild.cloneNode(true);
      fillText(el, record);
      const eager = firstRender && index < EAGER_CARD_COUNT;
      fillImage(el, record, { eager, priority: eager && index === 0 });
      card = { el, rev: record.rev };
      cards.set(record.id, card);
    } else if (card.rev !== record.rev) {
      fillText(card.el, record);
      fillImage(card.el, record, { eager: false, priority: false });
      card.rev = record.rev;
    }
    return card.el;
  }

  /** Shows exactly `records`, in order. */
  function render(records) {
    const elements = records.map(cardFor);
    const ids = records.map((record) => record.id);
    if (!order || ids.length !== order.length || ids.some((id, i) => id !== order[i])) {
      const focusedId = document.activeElement?.closest?.('.card')?.dataset.id;
      list.replaceChildren(...elements);
      order = ids;
      // Re-ordering detaches the focused card; put focus back if it is still shown.
      if (focusedId && cards.has(focusedId) && ids.includes(focusedId)) {
        cards.get(focusedId).el.querySelector('.card-link').focus({ preventScroll: true });
      }
    }
    list.setAttribute('aria-busy', 'false');
    // An empty render (e.g. after a failed load) shouldn't use up the first-row priority hints.
    if (records.length) firstRender = false;
  }

  /** Forgets cards for playlists that no longer exist. */
  function prune(liveIds) {
    for (const id of cards.keys()) if (!liveIds.has(id)) cards.delete(id);
  }

  // Event delegation: one listener each, however many cards there are.
  list.addEventListener('click', (event) => {
    const tag = event.target.closest('.tag-chip');
    if (tag) return onTag(tag.dataset.tag);
    const link = event.target.closest('.card-link');
    // Let modified clicks (new tab, new window) behave as normal links.
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(link.closest('.card').dataset.id);
  });

  // Arrow keys move between cards, row by row, as well as Tab.
  list.addEventListener('keydown', (event) => {
    const link = event.target.closest?.('.card-link');
    if (!link) return;
    const links = [...list.querySelectorAll('.card-link')];
    const index = links.indexOf(link);
    const columns = getComputedStyle(list).gridTemplateColumns.split(' ').length;
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: links.length - 1 }[event.key];
    if (target === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    links[Math.max(0, Math.min(links.length - 1, target))].focus();
  });

  return { render, prune };
}
