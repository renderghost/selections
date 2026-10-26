import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanText, normalisePlaylist, parseDuration, parseTitle, pickArtwork } from '../src/tidal/normalise.js';
import { artworkResource, playlistResource } from './helpers.js';

describe('parseTitle', () => {
  const cases = [
    ['the name of the playlist (rock)', 'the name of the playlist', ['rock']],
    ['Deep cuts (Talking Heads)', 'Deep cuts', ['Talking Heads']],
    ['Songs (for) rainy days (jazz)', 'Songs (for) rainy days', ['jazz']],
    ['Spaced out ( ambient )', 'Spaced out', ['ambient']],
    ['  Extra   spaces   (soul)  ', 'Extra spaces', ['soul']],
    ['Thunderstruck (AC/DC)', 'Thunderstruck', ['AC/DC']],
    ['Two tags (rock) (jazz)', 'Two tags', ['rock', 'jazz']],
    ['Touching tags (rock)(jazz)', 'Touching tags', ['rock', 'jazz']],
    ['Three (a) (b) (c)', 'Three', ['a', 'b', 'c']],
    ['Brackets (mid) title (rock) (jazz)', 'Brackets (mid) title', ['rock', 'jazz']],
    ['Stops at an empty pair (rock) ()', 'Stops at an empty pair (rock) ()', []],
    ['No tag here', 'No tag here', []],
    ['Empty tag ()', 'Empty tag ()', []],
    ['(only a tag)', '(only a tag)', []],
    ['', '', []],
  ];
  for (const [name, title, tags] of cases) {
    it(`"${name}"`, () => assert.deepEqual(parseTitle(name), { title, tags }));
  }
});

describe('parseDuration', () => {
  it('parses ISO 8601 durations to seconds', () => {
    assert.equal(parseDuration('PT1H2M3S'), 3723);
    assert.equal(parseDuration('PT45M'), 2700);
    assert.equal(parseDuration('PT30.6S'), 31);
    assert.equal(parseDuration('P1DT1H'), 90_000);
  });
  it('returns null for missing or invalid values', () => {
    assert.equal(parseDuration(undefined), null);
    assert.equal(parseDuration('1 hour'), null);
  });
});

describe('cleanText', () => {
  it('decodes common entities and tidies whitespace', () => {
    assert.equal(cleanText('  Rock &amp; roll\t\tforever  '), 'Rock & roll forever');
    assert.equal(cleanText('a\n\n\n\nb'), 'a\n\nb');
    assert.equal(cleanText(null), '');
  });
});

describe('pickArtwork', () => {
  it('keeps useful sizes, smallest first, with the palette colour', () => {
    const art = pickArtwork(artworkResource('x'));
    assert.deepEqual(art.sources.map(([, w]) => w), [160, 320, 640, 1280]);
    assert.equal(art.color, '#aabbcc');
  });
  it('falls back to the smallest file when none is in range', () => {
    assert.deepEqual(pickArtwork(artworkResource('x', [3000, 4000])).sources.map(([, w]) => w), [3000]);
  });
  it('rejects insecure URLs, videos and missing artwork', () => {
    const insecure = artworkResource('x', [320]);
    insecure.attributes.files[0].href = 'http://example.com/a.jpg';
    assert.equal(pickArtwork(insecure), null);
    assert.equal(pickArtwork({ attributes: { mediaType: 'VIDEO', files: [] } }), null);
    assert.equal(pickArtwork(undefined), null);
  });
  it('ignores palette colours that are not hex', () => {
    const art = artworkResource('x');
    art.attributes.visualMetadata.selectedPaletteColor = 'red; background: url(x)';
    assert.equal(pickArtwork(art).color, null);
  });
});

describe('normalisePlaylist', () => {
  const artworks = new Map([['art-1', artworkResource('art-1')]]);

  it('builds a compact record', () => {
    const record = normalisePlaylist(playlistResource('1'), artworks);
    assert.equal(record.title, 'Playlist 1');
    assert.deepEqual(record.tags, ['rock']);
    assert.equal(record.tracks, 10);
    assert.equal(record.duration, 3723);
    assert.equal(record.followers, 3);
    assert.equal(record.createdAt, '2024-01-01T00:00:00.000Z');
    assert.equal(record.url, 'https://tidal.com/playlist/1');
    assert.equal(record.art.sources.length, 4);
    assert.match(record.rev, /^[\w-]{12}$/);
  });

  it('never includes private or unlisted playlists', () => {
    assert.equal(normalisePlaylist(playlistResource('1', { attributes: { accessType: 'PRIVATE' } })), null);
    assert.equal(normalisePlaylist(playlistResource('1', { attributes: { accessType: 'UNLISTED' } })), null);
  });

  it("prefers TIDAL's own sharing link, but only on tidal.com", () => {
    const shared = playlistResource('1', { attributes: { externalLinks: [{ href: 'https://tidal.com/browse/playlist/1', meta: { type: 'TIDAL_SHARING' } }] } });
    assert.equal(normalisePlaylist(shared).url, 'https://tidal.com/browse/playlist/1');
    const odd = playlistResource('1', { attributes: { externalLinks: [{ href: 'https://evil.example/1', meta: { type: 'TIDAL_SHARING' } }] } });
    assert.equal(normalisePlaylist(odd).url, 'https://tidal.com/playlist/1');
  });

  it('prefers track count over item count', () => {
    assert.equal(normalisePlaylist(playlistResource('1', { attributes: { numberOfTrackItems: 7 } })).tracks, 7);
  });

  it('changes revision when visible content changes, and only then', () => {
    const a = normalisePlaylist(playlistResource('1'), artworks);
    const b = normalisePlaylist(playlistResource('1'), artworks);
    const c = normalisePlaylist(playlistResource('1', { attributes: { numberOfFollowers: 4 } }), artworks);
    assert.equal(a.rev, b.rev);
    assert.notEqual(a.rev, c.rev);
  });
});
