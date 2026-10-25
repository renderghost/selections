// Searching, filtering and sorting. Pure functions: no DOM, easy to test.

const collator = new Intl.Collator('en-GB', { sensitivity: 'base', numeric: true });

/** Lower-case and strip accents, so "bjork" finds "Björk". */
export const fold = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

export const tagKey = (tag) => (tag ? fold(tag).trim() : '');

/** Text searched for a record: its title, artist/genre tag and description. */
export const searchText = (record) => fold([record.title, record.tag, record.description].filter(Boolean).join('\n'));

export const parseQuery = (query) => fold(query).split(/\s+/).filter(Boolean);

/** Every word of the query must appear somewhere in the record. */
export const matches = (text, terms) => terms.every((term) => text.includes(term));

export const SORTS = {
  newest: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || collator.compare(a.title, b.title),
  updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || collator.compare(a.title, b.title),
  az: (a, b) => collator.compare(a.title, b.title) || collator.compare(a.tag ?? '', b.tag ?? ''),
};

export const DEFAULT_SORT = 'newest';
export const isSort = (value) => Object.hasOwn(SORTS, value);

/**
 * Applies a view to `entries` ({ record, text }) and returns the visible
 * records in order.
 */
export function applyView(entries, { query = '', tag = '', sort = DEFAULT_SORT } = {}) {
  const terms = parseQuery(query);
  const key = tagKey(tag);
  return entries
    .filter((entry) => (!key || tagKey(entry.record.tag) === key) && matches(entry.text, terms))
    .map((entry) => entry.record)
    .sort(SORTS[isSort(sort) ? sort : DEFAULT_SORT]);
}

/**
 * Tags shared by at least `min` playlists, most common first — in practice
 * the genres, since single-artist deep dives tend to be one per artist.
 */
export function popularTags(records, { min = 2, limit = 24 } = {}) {
  const byKey = new Map();
  for (const { tag } of records) {
    const key = tagKey(tag);
    if (!key) continue;
    const entry = byKey.get(key) ?? { key, label: tag, count: 0 };
    entry.count++;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .filter((entry) => entry.count >= min)
    .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label))
    .slice(0, limit);
}
