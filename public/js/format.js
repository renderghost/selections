import { NEW_PLAYLIST_DAYS } from './constants.js';

const LOCALE = 'en-GB';
const numbers = new Intl.NumberFormat(LOCALE);
const dates = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

const plural = (n, one, many) => `${numbers.format(n)} ${n === 1 ? one : many}`;

export const formatTracks = (n) => (Number.isFinite(n) ? plural(n, 'track', 'tracks') : null);
// Zero followers says nothing useful, so it is left out.
export const formatFollowers = (n) => (Number.isFinite(n) && n > 0 ? plural(n, 'follower', 'followers') : null);

/** 3723 → "1 hr 2 min"; 2880 → "48 min". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} min`;
  return minutes % 60 ? `${hours} hr ${minutes % 60} min` : `${hours} hr`;
}

export function formatDate(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? dates.format(time) : null;
}

export function isNew(record, now = Date.now()) {
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) && now - created < NEW_PLAYLIST_DAYS * 86_400_000;
}

/** "42 tracks · 2 hr 13 min" — skipping anything unknown. */
export const joinStats = (...parts) => parts.filter(Boolean).join(' · ');
