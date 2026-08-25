import type { LibraryEntry } from '@/lib/db/queries/library'

/**
 * A filter token: `"facet:value"`, the same flat string shape
 * `LibraryEntry.tags` already uses. Everything the rail can filter on is
 * expressed this way — the taxonomy facets straight from the entry's tags,
 * and four *derived* facets (status, rating, time, untagged) computed from
 * scalar columns. Keeping them one uniform vocabulary is what lets
 * `filterEntries` and `computeFacetCounts` treat "seafood" and "made it"
 * and "under 30 minutes" with exactly one code path instead of four.
 */
export type FilterToken = string

/** Facets whose values come from `recipe_tags` (see `src/lib/taxonomy`). */
export const TAXONOMY_FACETS = ['course', 'ingredient', 'method', 'cuisine', 'tag'] as const

/** Facets derived from scalar columns rather than tags. */
export const DERIVED_FACETS = ['untagged', 'status', 'rating', 'time'] as const

/**
 * Rail order, chosen by the spec: Course, Ingredient, Method, Cuisine, free
 * tags, then status, rating and time. `untagged` sits with the tags because
 * that is what it is an escape hatch from.
 */
export const FILTER_FACETS = [...TAXONOMY_FACETS, ...DERIVED_FACETS] as const
export type FilterFacet = (typeof FILTER_FACETS)[number]

/**
 * Time buckets, matched against `actualTimeMinutes ?? claimedTimeMinutes`.
 * Boundaries are inclusive at the top (`max`), so 30 minutes is "30 minutes
 * or less" and 31 is not.
 */
export const TIME_BUCKETS = [
  { value: 'under-30', label: '30 minutes or less', max: 30 },
  { value: '30-60', label: '30 to 60 minutes', max: 60 },
  { value: '1-2-hours', label: '1 to 2 hours', max: 120 },
  { value: 'over-2-hours', label: 'Over 2 hours', max: Number.POSITIVE_INFINITY },
] as const

/** Highest first — the order a person reads a star scale in. */
export const RATING_VALUES = ['5', '4', '3', '2', '1'] as const

export const SORTS = ['newest', 'oldest', 'rating', 'time', 'title'] as const
export type SortKey = (typeof SORTS)[number]

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  rating: 'Highest rated',
  time: 'Quickest first',
  title: 'Title A–Z',
}

export const DEFAULT_SORT: SortKey = 'newest'

export type FilterState = {
  selected: FilterToken[]
  sort: SortKey
}

export const EMPTY_FILTER_STATE: FilterState = { selected: [], sort: DEFAULT_SORT }

/** The facet half of a token. `"course:main"` -> `"course"`. */
export function facetOf(token: FilterToken): string {
  const i = token.indexOf(':')
  return i === -1 ? token : token.slice(0, i)
}

/** The value half of a token. `"course:main"` -> `"main"`. */
export function valueOfToken(token: FilterToken): string {
  const i = token.indexOf(':')
  return i === -1 ? '' : token.slice(i + 1)
}

/**
 * The time a recipe actually takes.
 *
 * `actualTimeMinutes` wins over `claimedTimeMinutes` wherever it exists —
 * that is the entire reason the schema carries both columns. A publisher's
 * "35 minutes" is a marketing number; "it took us an hour ten" is the truth,
 * and once someone has recorded it, it is the only number worth filtering
 * or sorting on.
 *
 * Returns null when neither is known. Callers must not coerce that to zero:
 * a recipe with no time is *unknown*, not instant, and every time filter
 * excludes it rather than pretending it is the fastest thing in the library.
 */
export function effectiveTimeMinutes(entry: LibraryEntry): number | null {
  return entry.actualTimeMinutes ?? entry.claimedTimeMinutes ?? null
}

/** The bucket a duration falls in, or null when the duration is unknown. */
export function timeBucketFor(minutes: number | null): string | null {
  if (minutes === null) return null
  for (const bucket of TIME_BUCKETS) {
    if (minutes <= bucket.max) return bucket.value
  }
  return TIME_BUCKETS[TIME_BUCKETS.length - 1].value
}

/**
 * Every token a recipe carries. This is the projection the whole filtering
 * and counting layer works against.
 *
 * A null rating, a null status and an unknown time produce *no* token for
 * that facet, which is what makes "excluded by a filter on that facet" fall
 * out of the ordinary OR-within-a-facet rule with no special case.
 */
export function entryTokens(entry: LibraryEntry): FilterToken[] {
  const tokens: FilterToken[] = [...entry.tags]
  if (entry.tags.length === 0) tokens.push('untagged:yes')
  if (entry.status) tokens.push(`status:${entry.status}`)
  if (entry.rating !== null && entry.rating !== undefined) tokens.push(`rating:${entry.rating}`)
  const bucket = timeBucketFor(effectiveTimeMinutes(entry))
  if (bucket) tokens.push(`time:${bucket}`)
  return tokens
}

/** Groups selected tokens by facet, preserving selection order within each. */
export function groupTokens(selected: readonly FilterToken[]): Map<string, string[]> {
  const byFacet = new Map<string, string[]>()
  for (const token of selected) {
    const facet = facetOf(token)
    const existing = byFacet.get(facet)
    if (existing) {
      if (!existing.includes(token)) existing.push(token)
    } else {
      byFacet.set(facet, [token])
    }
  }
  return byFacet
}

/**
 * OR within a facet, AND across facets.
 *
 * "Seafood or chicken" is a broadening of one question; "seafood *and* a
 * main course" is two questions. Anything else surprises people: ANDing
 * within a facet would make selecting two courses always return nothing.
 */
export function matchesFilters(
  tokens: ReadonlySet<string>,
  byFacet: ReadonlyMap<string, string[]>,
): boolean {
  for (const values of byFacet.values()) {
    let hit = false
    for (const value of values) {
      if (tokens.has(value)) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

/**
 * The filtered library, in the order it was given. Returns a copy so callers
 * can sort it without disturbing the source array.
 */
export function filterEntries(
  entries: readonly LibraryEntry[],
  selected: readonly FilterToken[],
): LibraryEntry[] {
  const byFacet = groupTokens(selected)
  if (byFacet.size === 0) return [...entries]
  return entries.filter((entry) => matchesFilters(new Set(entryTokens(entry)), byFacet))
}

/**
 * Comparators put a missing value last under every sort.
 *
 * An unrated recipe is not a zero-star recipe, and a recipe with no time is
 * not a zero-minute recipe. Sorting by "highest rated" and getting the 82
 * recipes nobody has ever rated at the top would make the control useless.
 */
function nullsLast<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return compare(a, b)
}

const COMPARATORS: Record<SortKey, (a: LibraryEntry, b: LibraryEntry) => number> = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  rating: (a, b) => nullsLast(a.rating ?? null, b.rating ?? null, (x, y) => y - x),
  time: (a, b) => nullsLast(effectiveTimeMinutes(a), effectiveTimeMinutes(b), (x, y) => x - y),
  title: (a, b) => a.title.localeCompare(b.title),
}

/**
 * Sorts a copy. Relies on `Array.prototype.sort` being stable (required by
 * the language since ES2019), so entries that tie on the sort key keep the
 * order they arrived in — which for this pipeline is `buildLibraryIndex`'s
 * newest-first order. Without that, every re-render could reshuffle the
 * unrated tail of a "highest rated" sort under the reader's cursor.
 */
export function sortEntries(entries: readonly LibraryEntry[], sort: SortKey): LibraryEntry[] {
  return [...entries].sort(COMPARATORS[sort] ?? COMPARATORS[DEFAULT_SORT])
}

/** Filter, then sort. The one call the view needs. */
export function applyFilterState(
  entries: readonly LibraryEntry[],
  state: FilterState,
): LibraryEntry[] {
  return sortEntries(filterEntries(entries, state.selected), state.sort)
}

/** Adds or removes a token, returning a new selection. */
export function toggleToken(
  selected: readonly FilterToken[],
  token: FilterToken,
): FilterToken[] {
  return selected.includes(token)
    ? selected.filter((t) => t !== token)
    : [...selected, token]
}

// --- URL state ---------------------------------------------------------------
//
// Filter state lives in the query string so a filtered view survives a
// reload and can be sent to the other person in the household ("here are
// the seafood mains we haven't made"). It is written with
// `history.replaceState` rather than a router navigation, so a filter click
// stays a pure in-memory operation and never re-runs the server component.

const FILTER_PARAM = 'f'
const SORT_PARAM = 'sort'

/** A well-formed token has a non-empty facet and a non-empty value. */
function isWellFormedToken(token: string): boolean {
  const i = token.indexOf(':')
  return i > 0 && i < token.length - 1
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Reads filter state out of a query string. Everything here is user input —
 * a hand-edited URL, a stale link — so an unknown sort falls back to the
 * default and malformed tokens are dropped rather than trusted. Unknown but
 * well-formed tokens are kept: free tags are an open vocabulary, so there is
 * no list to validate them against, and an unrecognized one simply matches
 * nothing and is cleared with the same "Clear filters" control as any other.
 */
export function parseFilterState(
  params: Record<string, string | string[] | undefined> | undefined,
): FilterState {
  const raw = firstValue(params?.[FILTER_PARAM]) ?? ''
  const selected: FilterToken[] = []
  for (const token of raw.split(',')) {
    const trimmed = token.trim()
    if (!isWellFormedToken(trimmed)) continue
    if (!selected.includes(trimmed)) selected.push(trimmed)
  }

  const rawSort = firstValue(params?.[SORT_PARAM])
  const sort = (SORTS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SortKey)
    : DEFAULT_SORT

  return { selected, sort }
}

/**
 * The query string for a state — `""` when it is the default, so an
 * unfiltered library keeps a clean URL.
 */
export function filterStateToQuery(state: FilterState): string {
  const params = new URLSearchParams()
  if (state.selected.length > 0) params.set(FILTER_PARAM, state.selected.join(','))
  if (state.sort !== DEFAULT_SORT) params.set(SORT_PARAM, state.sort)
  const query = params.toString()
  return query ? `?${query}` : ''
}
