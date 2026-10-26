// Demo data for local development and tests (TIDAL_MOCK=1). Serves responses
// shaped like TIDAL's JSON:API, so the real client and normalisation run.

const GENRES = ['rock', 'electronic', 'jazz', 'ambient', 'hip hop', 'soul', 'folk', 'techno', 'post-punk', 'disco'];
const ARTISTS = ['Björk', 'Radiohead', 'Talking Heads', 'Nina Simone', 'Aphex Twin', 'Kate Bush', 'Can', 'Sade', 'Dvořák', 'AC/DC'];
const WORDS = ['Night', 'Drive', 'Static', 'Bloom', 'Low Light', 'Tidal', 'Morning', 'Glass', 'Fever', 'Slow Motion', 'Deep Cuts', 'Echoes', 'Sundown', 'Neon', 'Weather'];
const PALETTE = ['#e4572e', '#29335c', '#f3a712', '#a8c686', '#669bbc', '#8e3b46', '#4c956c', '#c0a9b0', '#2d6a4f', '#ff006e', '#3a86ff', '#8338ec'];
const DAY = 86_400_000;

const pick = (list, i) => list[i % list.length];
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function buildPlaylists(count, now) {
  return Array.from({ length: count }, (_, i) => {
    const single = i % 3 === 0;
    // Mixes sometimes carry a second genre, and one title is long enough to be truncated.
    const tags = single ? [pick(ARTISTS, i)] : [pick(GENRES, i * 7), ...(i % 4 === 1 ? [pick(GENRES, i * 3 + 1)] : [])];
    const title = i === 7 ? 'A Very Long Playlist Title That Keeps Going and Going' : `${pick(WORDS, i * 5)} ${pick(WORDS, i * 11 + 3)}`;
    const name = `${title} ${tags.map((tag) => `(${tag})`).join(' ')}`;
    const tracks = 12 + ((i * 37) % 80);
    return {
      id: uuid(i + 1),
      type: 'playlists',
      attributes: {
        name: i === 4 ? 'Untitled mix without a tag' : name,
        description: single
          ? `A deep dive through the back catalogue of ${tags[0]}, from the hits to the B-sides.`
          : `Weekly selection of ${tags.join(' and ')} — new finds &amp; old favourites, sequenced for start-to-finish listening.`,
        accessType: i % 25 === 24 ? 'PRIVATE' : 'PUBLIC',
        bounded: true,
        createdAt: new Date(now - (i * 9 + 2) * DAY).toISOString(),
        lastModifiedAt: new Date(now - i * 4 * DAY).toISOString(),
        duration: `PT${Math.floor((tracks * 4) / 60)}H${(tracks * 4) % 60}M${i % 60}S`,
        numberOfItems: tracks,
        numberOfTrackItems: tracks,
        numberOfFollowers: (i * 13) % 140,
        playlistType: 'USER',
        externalLinks: [{ href: `https://tidal.com/browse/playlist/${uuid(i + 1)}`, meta: { type: 'TIDAL_SHARING' } }],
      },
      relationships: { coverArt: { data: i === 9 ? [] : [{ id: `art-${i + 1}`, type: 'artworks' }], links: { self: '' } } },
    };
  });
}

const buildArtwork = (i) => ({
  id: `art-${i}`,
  type: 'artworks',
  attributes: {
    mediaType: 'IMAGE',
    files: [160, 320, 640, 1080].map((width) => ({
      href: `/__mock/art/${i}.svg?w=${width}`,
      meta: { width, height: width },
    })),
    visualMetadata: { selectedPaletteColor: pick(PALETTE, i), status: 'OK' },
  },
});

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/vnd.api+json', ...headers } });

export function createMockFetch({ count = 150, pageSize = 20, latencyMs = 120, now = Date.now() } = {}) {
  const playlists = buildPlaylists(count, now);
  const delay = () => new Promise((resolve) => setTimeout(resolve, latencyMs));

  return async function mockFetch(input) {
    await delay();
    const url = new URL(typeof input === 'string' ? input : input.url);

    if (url.pathname.endsWith('/oauth2/token')) return json({ access_token: 'mock-token', token_type: 'Bearer', expires_in: 86_400 });

    if (url.pathname.endsWith('/playlists')) {
      const start = Number(url.searchParams.get('page[cursor]') || 0);
      const page = playlists.slice(start, start + pageSize);
      const next = start + pageSize < playlists.length ? String(start + pageSize) : undefined;
      const included = page.flatMap((p) => p.relationships.coverArt.data).map((ref) => buildArtwork(Number(ref.id.slice(4))));
      return json({ data: page, included, links: { self: url.pathname, ...(next && { next: `/playlists?page[cursor]=${next}`, meta: { nextCursor: next } }) } });
    }

    if (url.pathname.endsWith('/artworks')) {
      const ids = (url.searchParams.get('filter[id]') || '').split(',').filter(Boolean);
      return json({ data: ids.map((id) => buildArtwork(Number(id.slice(4)))), links: { self: url.pathname } });
    }

    return json({ errors: [{ status: '404', detail: 'Not found in mock' }] }, 404);
  };
}

/** Express handler drawing a simple generative cover for mock artwork. */
export function mockArtworkHandler(req, res) {
  const i = Number.parseInt(req.params.seed, 10) || 0;
  const a = pick(PALETTE, i);
  const b = pick(PALETTE, i * 5 + 3);
  const rings = Array.from({ length: 6 }, (_, n) => `<circle cx="${30 + ((i * 17) % 40)}%" cy="${30 + ((i * 29) % 40)}%" r="${12 + n * 14}%" fill="none" stroke="#fff" stroke-opacity="${0.08 + n * 0.03}" stroke-width="2"/>`).join('');
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="640" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>${rings}<text x="8" y="92" font-family="sans-serif" font-size="9" font-weight="700" fill="#fff" fill-opacity=".85">No. ${i}</text></svg>`,
  );
}
