// Shared by the browser and the server (which uses CARD_IMAGE_SIZES to preload
// the first artwork). Keep this file free of DOM access.

/** localStorage keys. Bump the version when the cached record shape changes. */
export const CACHE_KEY = 'selections:v2';
export const CACHE_ETAG_KEY = 'selections:v2:etag';
/** Keys from earlier record shapes (v1 had a single `tag`); removed so they don't linger in storage. */
export const LEGACY_CACHE_KEYS = ['selections:v1', 'selections:v1:etag'];

/** Approximate rendered width of a grid card's artwork; mirrors the grid in app.css. */
export const CARD_IMAGE_SIZES = '(min-width: 80rem) 14rem, (min-width: 40rem) 30vw, (min-width: 25rem) 50vw, 100vw';

/** Cards in the first rows load eagerly; the rest are lazy-loaded as you scroll. */
export const EAGER_CARD_COUNT = 6;

/** Playlists created within this many days get a "New" badge. */
export const NEW_PLAYLIST_DAYS = 21;

export const embedUrl = (id) => `https://embed.tidal.com/playlists/${encodeURIComponent(id)}`;

/** `srcset` value from a record's artwork sources. */
export const srcsetFor = (art) => art?.sources?.map(([url, width]) => `${url} ${width}w`).join(', ') ?? '';
