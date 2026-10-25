// The playlist dialog: artwork, details, TIDAL player, and open/copy actions.
// A native modal <dialog> provides the focus trap, Esc to close, an inert
// background and focus restoration; this module adds the rest.

import { embedUrl } from './constants.js';
import { formatDate, formatDuration, formatFollowers, formatTracks, joinStats } from './format.js';
import { setArtwork } from './grid.js';
import { reportError } from './report.js';

const PLAYER_SLOW_MS = 12_000;
const DIALOG_ART_SIZES = '(min-width: 52rem) 19rem, 5.5rem';

// --- Exit animations where the browser can't animate leaving the top layer ---

let displayTransitionSupport;
function canTransitionDisplay() {
  if (displayTransitionSupport !== undefined) return displayTransitionSupport;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete')) return (displayTransitionSupport = false);
  // Firefox parses allow-discrete without transitioning display, so probe for real.
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.append(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  displayTransitionSupport = getComputedStyle(probe).display === 'block';
  probe.remove();
  return displayTransitionSupport;
}

const supportsTopLayerExit = () => Boolean(window.CSS?.supports?.('overlay', 'auto')) && canTransitionDisplay();
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

async function closeTopLayer(dialog) {
  if (!dialog.open) return;
  if (!supportsTopLayerExit() && !prefersReducedMotion()) {
    dialog.setAttribute('data-closing', '');
    const transitions = dialog.getAnimations().filter((animation) => animation instanceof CSSTransition);
    if (transitions.length) {
      await Promise.race([Promise.allSettled(transitions.map((animation) => animation.finished)), new Promise((resolve) => setTimeout(resolve, 600))]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

// --- Clipboard -------------------------------------------------------------------

async function writeClipboard(text, container) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      return await navigator.clipboard.writeText(text);
    } catch (error) {
      if (error?.name !== 'NotAllowedError') reportError(error, { where: 'clipboard' });
    }
  }
  // Older browsers, or clipboard permission denied: the classic selection trick.
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.className = 'visually-hidden';
  container.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Copying to the clipboard was blocked');
}

// --- Dialog ------------------------------------------------------------------------

export function createPlaylistDialog({ dialog, onClose }) {
  const $ = (selector) => dialog.querySelector(selector);
  const ui = {
    img: $('.sheet-art img'),
    tag: $('.sheet-tag'),
    title: $('.sheet-title'),
    stats: $('.sheet-stats'),
    description: $('.sheet-description'),
    open: $('[data-action="open"]'),
    copy: $('[data-action="copy"]'),
    copyStatus: $('.copy-status'),
    close: $('.sheet-close'),
    player: $('.sheet-player'),
    playerMessage: $('.player-message'),
  };
  let current = null;
  let slowTimer;
  let copyTimer;

  function unloadPlayer() {
    clearTimeout(slowTimer);
    ui.player.querySelector('iframe')?.remove(); // Also stops playback.
    ui.player.dataset.state = 'idle';
    ui.playerMessage.hidden = true;
  }

  function loadPlayer(record) {
    unloadPlayer();
    const iframe = document.createElement('iframe');
    iframe.title = `TIDAL player: ${record.title}`;
    iframe.allow = 'encrypted-media; fullscreen; clipboard-write; autoplay';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.addEventListener(
      'load',
      () => {
        clearTimeout(slowTimer);
        ui.player.dataset.state = 'loaded';
        ui.playerMessage.hidden = true;
      },
      { once: true },
    );
    ui.player.dataset.state = 'loading';
    slowTimer = setTimeout(() => {
      if (ui.player.dataset.state === 'loading') ui.playerMessage.hidden = false;
    }, PLAYER_SLOW_MS);
    iframe.src = embedUrl(record.id);
    ui.player.append(iframe);
  }

  function fill(record) {
    dialog.classList.toggle('no-art', !record.art);
    dialog.style.setProperty('--art', record.art?.color ?? '');
    setArtwork(ui.img, record.art, { sizes: DIALOG_ART_SIZES, loading: 'eager' });
    ui.tag.textContent = record.tag ?? '';
    ui.tag.hidden = !record.tag;
    ui.title.textContent = record.title;
    ui.stats.textContent = joinStats(
      formatTracks(record.tracks),
      formatDuration(record.duration),
      formatFollowers(record.followers),
      record.createdAt && `Added ${formatDate(record.createdAt)}`,
    );
    ui.description.textContent = record.description ?? '';
    ui.open.href = record.url;
    ui.copy.textContent = 'Copy link';
    ui.copyStatus.textContent = '';
  }

  async function copyLink() {
    if (!current) return;
    clearTimeout(copyTimer);
    try {
      await writeClipboard(current.url, dialog);
      ui.copy.textContent = 'Copied ✓';
      ui.copyStatus.textContent = 'Link copied to your clipboard.';
      copyTimer = setTimeout(() => {
        ui.copy.textContent = 'Copy link';
        ui.copyStatus.textContent = '';
      }, 2500);
    } catch (error) {
      reportError(error, { where: 'copyLink' });
      ui.copyStatus.textContent = `Couldn't copy automatically. Here's the link: ${current.url}`;
    }
    ui.copy.focus();
  }

  const close = () => closeTopLayer(dialog);

  ui.close.addEventListener('click', close);
  ui.copy.addEventListener('click', copyLink);
  dialog.addEventListener('close', () => {
    unloadPlayer();
    const closed = current;
    current = null;
    onClose?.(closed);
  });

  // Route Esc through the animated close where the browser can't animate it natively.
  dialog.addEventListener('cancel', (event) => {
    if (supportsTopLayerExit() || prefersReducedMotion()) return;
    event.preventDefault();
    close();
  });

  // Light dismiss (click outside) for browsers without <dialog closedby="any">.
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = rect.top <= event.clientY && event.clientY <= rect.bottom && rect.left <= event.clientX && event.clientX <= rect.right;
      if (!inside) close();
    });
  }

  return {
    get openId() {
      return current?.id ?? null;
    },
    open(record) {
      current = record;
      fill(record);
      if (!dialog.open) dialog.showModal();
      dialog.scrollTop = 0;
      loadPlayer(record);
    },
    close,
  };
}
