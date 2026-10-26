import { createHash } from 'node:crypto';

// Each trailing "(…)" holds a tag: the artist (single-artist playlists) or genre (mixes).
const TRAILING_TAG = /^(.*\S)\s*\(\s*([^()]*?)\s*\)\s*$/;
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const HEX_COLOUR = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

const MIN_ART_WIDTH = 100;
const MAX_ART_WIDTH = 1280;

/** "Night drive (rock) (jazz)" → { title: "Night drive", tags: ["rock", "jazz"] }. Brackets mid-title stay in the title. */
export function parseTitle(name) {
  let title = String(name ?? '').replace(/\s+/g, ' ').trim();
  const tags = [];
  for (let match = title.match(TRAILING_TAG); match?.[2]; match = title.match(TRAILING_TAG)) {
    tags.unshift(match[2]);
    title = match[1];
  }
  return { title, tags };
}

/** "PT1H2M3S" → 3723 (seconds), or null when missing/invalid. */
export function parseDuration(iso) {
  const match = typeof iso === 'string' ? iso.match(ISO_DURATION) : null;
  if (!match) return null;
  const [, d = 0, h = 0, m = 0, s = 0] = match;
  return Math.round(Number(d) * 86_400 + Number(h) * 3600 + Number(m) * 60 + Number(s));
}

export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, entity) => ENTITIES[entity])
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const toIsoDate = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const isHttpsOn = (href, domain) => {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
};

// HTTPS only; root-relative paths are same-origin (used by mock mode).
const isAllowedImageUrl = (href) => typeof href === 'string' && (href.startsWith('https://') || /^\/(?!\/)/.test(href));

/** Artwork resource → { color, sources: [[url, width], …] } sorted by width, or null. */
export function pickArtwork(artwork) {
  const attributes = artwork?.attributes;
  if (!attributes || (attributes.mediaType && attributes.mediaType !== 'IMAGE')) return null;

  const byWidth = new Map();
  for (const file of attributes.files ?? []) {
    const width = Number(file?.meta?.width);
    if (!isAllowedImageUrl(file?.href) || !(width > 0)) continue;
    if (!byWidth.has(width)) byWidth.set(width, file.href);
  }
  const all = [...byWidth.entries()].sort((a, b) => a[0] - b[0]);
  if (!all.length) return null;

  const inRange = all.filter(([width]) => width >= MIN_ART_WIDTH && width <= MAX_ART_WIDTH);
  const sources = (inRange.length ? inRange : [all[0]]).map(([width, url]) => [url, width]);

  const colour = attributes.visualMetadata?.selectedPaletteColor;
  const match = typeof colour === 'string' ? colour.trim().match(HEX_COLOUR) : null;
  return { color: match ? `#${match[1].toLowerCase()}` : null, sources };
}

/** Short, stable hash of a record's content. Changes whenever anything visible changes. */
export function revision(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('base64url').slice(0, 12);
}

/**
 * TIDAL playlist resource → the compact record sent to browsers.
 * Returns null for anything that is not public, so private and unlisted
 * playlists can never leak, whichever credentials fetched them.
 */
export function normalisePlaylist(resource, artworksById = new Map()) {
  const attributes = resource?.attributes;
  if (typeof resource?.id !== 'string' || !attributes) return null;
  if (attributes.accessType !== 'PUBLIC') return null;

  const { title, tags } = parseTitle(attributes.name);
  if (!title) return null;

  const share = attributes.externalLinks?.find((link) => link?.meta?.type === 'TIDAL_SHARING')?.href;
  const coverArtId = resource.relationships?.coverArt?.data?.[0]?.id;
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

  const record = {
    id: resource.id,
    title,
    tags,
    description: cleanText(attributes.description),
    tracks: count(attributes.numberOfTrackItems) ?? count(attributes.numberOfItems),
    duration: parseDuration(attributes.duration),
    followers: count(attributes.numberOfFollowers),
    createdAt: toIsoDate(attributes.createdAt),
    updatedAt: toIsoDate(attributes.lastModifiedAt),
    url: isHttpsOn(share, 'tidal.com') ? share : `https://tidal.com/playlist/${encodeURIComponent(resource.id)}`,
    art: pickArtwork(artworksById.get(coverArtId)),
  };
  return { ...record, rev: revision(record) };
}

/** Newest first; undated playlists last; ties broken by title. */
export function compareNewest(a, b) {
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.title.localeCompare(b.title);
}
