import type { LibraryEntry } from '@/lib/db/queries/library'

/**
 * Tier 1 of search: local, instant, in memory.
 *
 * Matches title, publisher, and tags -- nothing else, because that is all
 * `LibraryEntry` carries. Finding a term buried in an ingredient, a step, or
 * the narrative is tier 2's job (`GET /api/search`, over `searchRecipes`),
 * which is the whole reason the two tiers exist rather than one that tries
 * to do everything.
 *
 * Only the three fields `searchEntries` reads, so callers (and tests) can
 * pass a plain object instead of a full `LibraryEntry`.
 */
export type SearchableEntry = Pick<LibraryEntry, 'title' | 'publisher' | 'tags'>

/**
 * Strips combining diacritical marks after a canonical decomposition, so an
 * accented letter and its unaccented base compare equal.
 *
 * This has to mirror what FTS5's `unicode61` tokenizer already does to the
 * *server*-side index, or the two search tiers disagree about what "saute"
 * finds -- and disagreeing tiers feel like a broken app no matter which one
 * is "right". `NFD` decomposes an accented letter into its base letter plus
 * one or more combining marks; `\p{Mn}` (Unicode category "Mark,
 * nonspacing", used with the `u` flag) matches exactly those combining
 * marks, so stripping it leaves the base letters behind.
 */
function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{Mn}/gu, '')
}

function normalize(value: string): string {
  return foldAccents(value).toLowerCase()
}

/**
 * The text a query is matched against: title, publisher, and tags, folded
 * to one case- and accent-insensitive string.
 *
 * Tags are joined in as their raw `"facet:value"` strings rather than just
 * the value half -- `"ingredient:seafood"` still contains `"seafood"` as a
 * substring, so a plain query still finds it, and nothing is lost by not
 * splitting them first.
 */
function haystackFor(entry: SearchableEntry): string {
  return normalize([entry.title, entry.publisher ?? '', ...entry.tags].join(' '))
}

/**
 * Filters `entries` to the ones whose title, publisher, or tags match
 * `query` -- case- and accent-insensitively.
 *
 * The query is split into whitespace-separated terms and every term must
 * appear somewhere in the haystack (an AND, same as the server tier's
 * multi-word search). Splitting first is also what makes a query with a
 * leading/trailing space or doubled internal spaces behave exactly like the
 * trimmed, single-spaced version: `split(/\s+/).filter(Boolean)` throws the
 * empty strings away rather than requiring them to literally appear in the
 * haystack.
 *
 * An empty or whitespace-only query returns every entry, in the order it
 * was given -- "not searching" and "searching for nothing" are the same
 * result. A query that matches nothing returns `[]`.
 */
export function searchEntries<T extends SearchableEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...entries]

  return entries.filter((entry) => {
    const haystack = haystackFor(entry)
    return terms.every((term) => haystack.includes(term))
  })
}
