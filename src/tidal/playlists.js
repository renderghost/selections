import { TidalAuthError, TidalError } from '../errors.js';
import { compareNewest, normalisePlaylist } from './normalise.js';

const ARTWORK_BATCH = 20;

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * Fetches every public playlist owned by `ownerId`, with cover art, in as few
 * requests as TIDAL allows (one per page of results, rather than one per playlist).
 */
export async function fetchPublicPlaylists({ client, ownerId, countryCode, authMode, logger }) {
  const resources = new Map();
  const artworks = new Map();

  try {
    for await (const doc of client.paginate('/playlists', { 'filter[owners.id]': ownerId, include: 'coverArt', countryCode })) {
      if (!Array.isArray(doc?.data)) {
        throw new TidalError('Unexpected response from TIDAL: /playlists returned no data array');
      }
      for (const resource of doc.data) if (resource?.type === 'playlists') resources.set(resource.id, resource);
      for (const item of doc.included ?? []) if (item?.type === 'artworks') artworks.set(item.id, item);
    }
  } catch (error) {
    if (error instanceof TidalAuthError && authMode === 'client') {
      error.message +=
        ' — TIDAL may only allow reading playlists on behalf of a signed-in user. Run `npm run tidal:login` once and set TIDAL_REFRESH_TOKEN.';
    }
    throw error;
  }

  // Artwork TIDAL referenced but did not include: fetch it in batches. Not fatal.
  const missing = [...resources.values()]
    .map((resource) => resource.relationships?.coverArt?.data?.[0]?.id)
    .filter((id) => id && !artworks.has(id));
  for (const ids of chunk([...new Set(missing)], ARTWORK_BATCH)) {
    try {
      const doc = await client.get('/artworks', { 'filter[id]': ids, countryCode });
      for (const item of doc?.data ?? []) artworks.set(item.id, item);
    } catch (err) {
      logger?.warn({ err, count: ids.length }, 'Could not fetch some playlist artwork; showing placeholders');
    }
  }

  const records = [];
  let hidden = 0;
  for (const resource of resources.values()) {
    const record = normalisePlaylist(resource, artworks);
    if (record) records.push(record);
    else hidden++;
  }

  if (!records.length && hidden) {
    logger?.warn({ hidden }, 'TIDAL returned playlists but none are marked public (accessType PUBLIC); none will be shown');
  }
  const withoutArt = records.filter((record) => !record.art).length;
  if (withoutArt) logger?.warn({ withoutArt }, 'Some playlists have no usable artwork');
  logger?.info({ public: records.length, hidden }, 'Fetched playlists from TIDAL');

  return records.sort(compareNewest);
}
