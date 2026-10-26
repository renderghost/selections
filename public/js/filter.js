// Searching, filtering and sorting. Pure functions: no DOM, easy to test.

const collator = new Intl.Collator('en-GB', { sensitivity: 'base', numeric: true });

/** Lower-case and strip accents, so "bjork" finds "Björk". */
export const fold = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

export const tagKey = (tag) => (tag ? fold(tag).trim() : '');

/** Text searched for a record: its title, artist/genre tags and description. */
export const searchText = (record) => fold([record.title, ...record.tags, record.description].filter(Boolean).join('\n'));

export const parseQuery = (query) => fold(query).split(/\s+/).filter(Boolean);

/** Every word of the query must appear somewhere in the record. */
export const matches = (text, terms) => terms.every((term) => text.includes(term));

// ISO 8601 dates sort chronologically as plain text.
const compareDates = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** What each sort looks at, and the direction people expect first: newest dates first, titles A–Z. */
export const SORTS = {
  created: { natural: 'desc', value: (record) => record.createdAt, compare: compareDates },
  updated: { natural: 'desc', value: (record) => record.updatedAt, compare: compareDates },
  title: { natural: 'asc', value: (record) => record.title, compare: collator.compare },
};

export const DEFAULT_SORT = 'created';
export const ORDERS = ['asc', 'desc'];

// Links shared before the sort menu had a direction.
const LEGACY_SORTS = new Map([
  ['newest', 'created'],
  ['az', 'title'],
]);

/** A known sort name, with old names translated; anything else is the default. */
export const parseSort = (value) => (Object.hasOwn(SORTS, value) ? value : (LEGACY_SORTS.get(value) ?? DEFAULT_SORT));

/** A known direction, or the one people expect for this sort. */
export const parseOrder = (value, sort) => (ORDERS.includes(value) ? value : SORTS[parseSort(sort)].natural);

function comparator(sort, order) {
  const { value, compare } = SORTS[sort];
  const sign = order === 'asc' ? 1 : -1;
  return (a, b) => {
    const x = value(a) ?? '';
    const y = value(b) ?? '';
    if (!x !== !y) return x ? -1 : 1; // A playlist missing the value (say, an unknown date) goes last either way.
    return (x && sign * compare(x, y)) || collator.compare(a.title, b.title) || collator.compare(a.tags.join(), b.tags.join());
  };
}

/**
 * Applies a view to `entries` ({ record, text }) and returns the visible
 * records in order.
 */
export function applyView(entries, { query = '', tag = '', sort = DEFAULT_SORT, order } = {}) {
  const terms = parseQuery(query);
  const key = tagKey(tag);
  const field = parseSort(sort);
  return entries
    .filter((entry) => (!key || entry.record.tags.some((t) => tagKey(t) === key)) && matches(entry.text, terms))
    .map((entry) => entry.record)
    .sort(comparator(field, parseOrder(order, field)));
}

/**
 * Tags shared by at least `min` playlists, most common first — in practice
 * the genres, since single-artist deep dives tend to be one per artist.
 */
export function popularTags(records, { min = 2, limit = 24 } = {}) {
  const byKey = new Map();
  for (const { tags } of records) {
    const seen = new Set(); // A playlist counts once towards a tag, however it is capitalised.
    for (const tag of tags) {
      const key = tagKey(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key) ?? { key, label: tag, count: 0 };
      entry.count++;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .filter((entry) => entry.count >= min)
    .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label))
    .slice(0, limit);
}
