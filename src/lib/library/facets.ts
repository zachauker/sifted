import type { LibraryEntry } from '@/lib/db/queries/library'
import {
  FILTER_FACETS,
  RATING_VALUES,
  TIME_BUCKETS,
  entryTokens,
  facetOf,
  groupTokens,
  matchesFilters,
  valueOfToken,
  type FilterToken,
} from './filter'

/**
 * The two numbers that need the real library to settle, kept together and
 * in one obvious place.
 *
 * The plan's Task 1 measures the actual facet distribution; until it runs,
 * nobody knows whether `cuisine` has six values or thirty, or whether the
 * long tail is two recipes deep. So both knobs default to "show everything"
 * — the honest behaviour for an unmeasured library — and neither ever
 * *removes* a value: below-threshold and overflow values move behind the
 * facet's "Show all" control, where they are still reachable and still
 * counted.
 *
 *  - `minLibraryCount`: a value carried by fewer than this many recipes in
 *    the whole library is noise in a rail you scan. Raise to 3 if the tail
 *    turns out to be long.
 *  - `collapseAfter`: how many values a facet shows before the rest fold
 *    away. Selected values are always shown regardless.
 */
export const RAIL_TUNING = {
  minLibraryCount: 1,
  collapseAfter: 8,
}

export type FacetValueCount = {
  facet: string
  value: string
  token: FilterToken
  label: string
  /** Count under the current filters, with this facet's own filters excluded. */
  count: number
  /** Count across the whole library, ignoring every filter. */
  libraryCount: number
  selected: boolean
  /** Reachable but empty: rendered, greyed, and not clickable. */
  disabled: boolean
}

export type FacetGroup = {
  facet: string
  label: string
  values: FacetValueCount[]
}

export const FACET_LABELS: Record<string, string> = {
  course: 'Course',
  ingredient: 'Ingredient',
  method: 'Method',
  cuisine: 'Cuisine',
  tag: 'Tags',
  untagged: 'Untagged',
  status: 'Status',
  rating: 'Rating',
  time: 'Time',
}

const STATUS_LABELS: Record<string, string> = {
  made_it: 'Made it',
  want_to_make: 'Want to make',
}

const TIME_LABELS: Record<string, string> = Object.fromEntries(
  TIME_BUCKETS.map((bucket) => [bucket.value, bucket.label]),
)

/**
 * Facets whose values have an inherent order a reader expects — five stars
 * above four, quickest above slowest. Sorting these by count would shuffle
 * a scale into nonsense, and the "stable between renders" reason behind the
 * count-descending rule is served even better by an order that never
 * changes at all.
 */
const NATURAL_ORDER: Record<string, readonly string[]> = {
  rating: RATING_VALUES,
  time: TIME_BUCKETS.map((bucket) => bucket.value),
}

function titleCase(value: string): string {
  return value
    .split(/[-\s]+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function labelForValue(facet: string, value: string): string {
  if (facet === 'status') return STATUS_LABELS[value] ?? titleCase(value.replace(/_/g, ' '))
  if (facet === 'rating') return value === '1' ? '1 star' : `${value} stars`
  if (facet === 'time') return TIME_LABELS[value] ?? titleCase(value)
  if (facet === 'untagged') return 'No tags'
  return titleCase(value)
}

/**
 * Live counts for every facet value in the library.
 *
 * The rule that makes this worth its own module, and the one most easily
 * got wrong:
 *
 *   **A facet's counts are computed with that facet's own selections
 *   excluded.**
 *
 * With `course:main` selected, the ingredient counts answer "how much of
 * this is available *within* mains" — they honour the course filter. But
 * the course counts themselves answer "how big is each course in the rest
 * of the library I've narrowed to", ignoring the fact that `main` is
 * selected. Count them the naive way and every unselected course reads `0`
 * the instant you pick one, which looks broken even though clicking it
 * would work fine (selections OR within a facet, so a second course
 * *widens* the result).
 *
 * Cost is one pass per facet over the entries — nine passes over 156
 * entries — which is microseconds, and buys a rail whose numbers are always
 * the answer to the question the reader is actually asking.
 */
export function computeFacetCounts(
  entries: readonly LibraryEntry[],
  selected: readonly FilterToken[],
): FacetGroup[] {
  // Tokenize once. Every pass below reuses these sets rather than
  // re-deriving a recipe's tokens per facet.
  const tokenSets = entries.map((entry) => new Set(entryTokens(entry)))
  const selectedSet = new Set(selected)
  const byFacet = groupTokens(selected)

  // Which values exist at all, and how big each is with no filters applied.
  // A value nobody carries is not rendered; a value somebody carries is
  // always rendered, even when the current filters push its count to zero.
  const libraryCounts = new Map<string, number>()
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      libraryCounts.set(token, (libraryCounts.get(token) ?? 0) + 1)
    }
  }
  // A selected token that nothing carries (a stale shared link, say) still
  // gets a row, so it can be seen and switched off.
  for (const token of selectedSet) {
    if (!libraryCounts.has(token)) libraryCounts.set(token, 0)
  }

  const groups: FacetGroup[] = []

  for (const facet of FILTER_FACETS) {
    // The exclusion rule, in one line: this facet's own selections are
    // dropped from the filter these counts are measured against.
    const others = new Map(byFacet)
    others.delete(facet)

    const counts = new Map<string, number>()
    for (const tokens of tokenSets) {
      if (!matchesFilters(tokens, others)) continue
      for (const token of tokens) {
        if (facetOf(token) !== facet) continue
        counts.set(token, (counts.get(token) ?? 0) + 1)
      }
    }

    const values: FacetValueCount[] = []
    for (const [token, libraryCount] of libraryCounts) {
      if (facetOf(token) !== facet) continue
      const count = counts.get(token) ?? 0
      const isSelected = selectedSet.has(token)
      values.push({
        facet,
        value: valueOfToken(token),
        token,
        label: labelForValue(facet, valueOfToken(token)),
        count,
        libraryCount,
        selected: isSelected,
        // Zero under the current filters means "clicking this leads
        // nowhere" — so it is greyed out and left exactly where it was,
        // rather than removed. A rail that reflows as you use it makes you
        // miss the thing you were reaching for.
        disabled: count === 0 && !isSelected,
      })
    }

    // A facet with a fixed scale (`rating`, `time`) only ever shows the
    // values on that scale. `entry.rating` is a plain database column with
    // nothing enforcing 0–5 at read time, so a corrupt or pre-migration row
    // can carry a token like `rating:4.5` that isn't on the scale at all —
    // dropped here rather than sorted, because `natural.indexOf` returns
    // `-1` for it, and `-1` sorts *before* every real index, putting a
    // phantom "4.5 stars" row above "5 stars" instead of just misplacing it.
    const natural = NATURAL_ORDER[facet]
    const rows = natural ? values.filter((v) => natural.includes(v.value)) : values

    // A facet nothing in the library carries renders no heading at all.
    if (rows.length === 0) continue

    if (natural) {
      rows.sort((a, b) => natural.indexOf(a.value) - natural.indexOf(b.value))
    } else {
      // Count descending, then alphabetically — but against `libraryCount`,
      // the count across the whole library, so the order is computed once
      // and then frozen for every filter combination.
      //
      // Sorting by the *live* count instead would still be
      // count-descending, and would still be defensible on paper, but it
      // reorders the rail on every click: with `course:main` selected,
      // Ingredient goes from `Seafood 3, Chicken 2` to `Chicken 2,
      // Seafood 2` purely because of the alphabetical tiebreak. That is the
      // same disorientation the disabled-not-hidden rule exists to prevent,
      // arriving by a different route — and worse for being intermittent.
      // What people build up is spatial memory: Seafood is the second row
      // under Ingredient, always. A number changing in place is
      // information; a row changing places is noise.
      rows.sort((a, b) => b.libraryCount - a.libraryCount || a.label.localeCompare(b.label))
    }

    groups.push({ facet, label: FACET_LABELS[facet] ?? titleCase(facet), values: rows })
  }

  return groups
}

/**
 * Splits a facet's values into the ones shown by default and the ones
 * folded behind its "Show all" control, applying `RAIL_TUNING`.
 *
 * Which side of the fold a value lands on is decided entirely by
 * `libraryCount` and its position in the frozen order above — never by the
 * live count or by what is currently selected. Otherwise values hop across
 * the fold as filters change, which is the reordering problem wearing a
 * hat: a row you could see a moment ago is now behind "Show 4 more".
 *
 * Selection is the one addition, and it does not disturb anything: a
 * selected value below the fold is shown as well, but does not consume one
 * of the `collapseAfter` slots, so it cannot push a neighbouring row down
 * behind the fold. You must always be able to see and undo what you have
 * switched on, without that costing someone else their place.
 */
export function splitVisibleValues(
  values: readonly FacetValueCount[],
  tuning = RAIL_TUNING,
): { visible: FacetValueCount[]; folded: FacetValueCount[] } {
  const visible: FacetValueCount[] = []
  const folded: FacetValueCount[] = []
  let slotsUsed = 0

  for (const value of values) {
    const withinFold =
      value.libraryCount >= tuning.minLibraryCount && slotsUsed < tuning.collapseAfter
    if (withinFold) slotsUsed += 1
    if (withinFold || value.selected) visible.push(value)
    else folded.push(value)
  }

  return { visible, folded }
}
