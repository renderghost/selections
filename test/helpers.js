// Shared test utilities.

export const silentLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger;
  },
};

/** Collects reporter calls instead of logging them. */
export function fakeReporter() {
  const calls = { exception: [], browserError: [], cspViolation: [] };
  return {
    calls,
    sentryEnabled: false,
    exception: (error, options) => calls.exception.push({ error, options }),
    browserError: (report, meta) => calls.browserError.push({ report, meta }),
    cspViolation: (violation, meta) => calls.cspViolation.push({ violation, meta }),
    flush: async () => true,
  };
}

export const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A fetch stub that answers from a queue of handlers and records every call. */
export function scriptedFetch(...handlers) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const handler = handlers.length > 1 ? handlers.shift() : handlers[0];
    if (!handler) throw new Error(`Unexpected fetch: ${url}`);
    return handler(url, init);
  };
  return { fetch, calls };
}

export const noWait = { wait: async () => {}, random: () => 0.5 };

/** A minimal TIDAL playlist resource. */
export function playlistResource(id, overrides = {}) {
  const { attributes, relationships } = overrides;
  return {
    id,
    type: 'playlists',
    attributes: {
      name: `Playlist ${id} (rock)`,
      description: 'Some songs',
      accessType: 'PUBLIC',
      createdAt: '2024-01-01T00:00:00Z',
      lastModifiedAt: '2024-02-01T00:00:00Z',
      duration: 'PT1H2M3S',
      numberOfItems: 10,
      numberOfFollowers: 3,
      externalLinks: [],
      ...attributes,
    },
    relationships: relationships ?? { coverArt: { data: [{ id: `art-${id}`, type: 'artworks' }] } },
  };
}

export function artworkResource(id, widths = [80, 160, 320, 640, 1280, 3000]) {
  return {
    id,
    type: 'artworks',
    attributes: {
      mediaType: 'IMAGE',
      files: widths.map((w) => ({ href: `https://resources.tidal.com/images/${id}/${w}x${w}.jpg`, meta: { width: w, height: w } })),
      visualMetadata: { selectedPaletteColor: '#AABBCC' },
    },
  };
}
