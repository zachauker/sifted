import { describe, it, expect } from 'vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import {
  DEFAULT_SORT,
  applyFilterState,
  effectiveTimeMinutes,
  entryTokens,
  filterEntries,
  filterStateToQuery,
  parseFilterState,
  sortEntries,
  timeBucketFor,
  toggleToken,
} from '@/lib/library/filter'

let counter = 0
function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  counter += 1
  return {
    id: `r${counter}`,
    slug: `recipe-${counter}`,
    title: `Recipe ${counter}`,
    thumbUrl: null,
    publisher: null,
    rating: null,
    status: null,
    claimedTimeMinutes: null,
    actualTimeMinutes: null,
    createdAt: counter,
    tags: [],
    ...overrides,
  }
}

const titles = (entries: readonly LibraryEntry[]) => entries.map((e) => e.title)

describe('filterEntries', () => {
  it('returns everything when nothing is selected', () => {
    const entries = [entry({ tags: ['course:main'] }), entry()]
    expect(filterEntries(entries, [])).toEqual(entries)
  })

  it('ORs two values within one facet', () => {
    const seafood = entry({ title: 'Salmon', tags: ['ingredient:seafood'] })
    const chicken = entry({ title: 'Katsu', tags: ['ingredient:chicken'] })
    const beef = entry({ title: 'Ragu', tags: ['ingredient:beef'] })

    const result = filterEntries([seafood, chicken, beef], [
      'ingredient:seafood',
      'ingredient:chicken',
    ])

    expect(titles(result)).toEqual(['Salmon', 'Katsu'])
  })

  it('ANDs values across two facets', () => {
    const seafoodMain = entry({ title: 'Salmon', tags: ['ingredient:seafood', 'course:main'] })
    const seafoodStarter = entry({ title: 'Ceviche', tags: ['ingredient:seafood', 'course:appetizer'] })
    const chickenMain = entry({ title: 'Katsu', tags: ['ingredient:chicken', 'course:main'] })

    const result = filterEntries(
      [seafoodMain, seafoodStarter, chickenMain],
      ['ingredient:seafood', 'course:main'],
    )

    expect(titles(result)).toEqual(['Salmon'])
  })

  it('restores everything when the filter is cleared', () => {
    const entries = [entry({ tags: ['course:main'] }), entry({ tags: ['course:dessert'] })]
    const narrowed = filterEntries(entries, ['course:main'])
    expect(narrowed).toHaveLength(1)
    expect(filterEntries(entries, [])).toHaveLength(2)
  })

  it('does not mutate or alias the entries it was given', () => {
    const entries = [entry(), entry()]
    const result = filterEntries(entries, [])
    expect(result).not.toBe(entries)
    result.reverse()
    expect(titles(entries)).toEqual(titles(entries))
  })

  it('filters on status, and excludes recipes with no status', () => {
    const made = entry({ title: 'Made', status: 'made_it' })
    const want = entry({ title: 'Want', status: 'want_to_make' })
    const neither = entry({ title: 'Neither', status: null })

    expect(titles(filterEntries([made, want, neither], ['status:made_it']))).toEqual(['Made'])
  })

  it('filters on rating, and excludes unrated recipes', () => {
    const five = entry({ title: 'Five', rating: 5 })
    const three = entry({ title: 'Three', rating: 3 })
    const unrated = entry({ title: 'Unrated', rating: null })

    expect(titles(filterEntries([five, three, unrated], ['rating:5', 'rating:3'])))
      .toEqual(['Five', 'Three'])
  })

  it('offers untagged recipes as their own filter, so they are reachable at all', () => {
    const tagged = entry({ title: 'Tagged', tags: ['course:main'] })
    const untagged = entry({ title: 'Untagged', tags: [] })

    expect(titles(filterEntries([tagged, untagged], ['untagged:yes']))).toEqual(['Untagged'])
  })
})

describe('time filtering', () => {
  it('prefers the measured time over the publisher claim', () => {
    // The whole reason both columns exist: the publisher says 20 minutes,
    // we know it took an hour and a half, so it is not a weeknight recipe.
    const optimistic = entry({ title: 'Optimistic', claimedTimeMinutes: 20, actualTimeMinutes: 90 })

    expect(effectiveTimeMinutes(optimistic)).toBe(90)
    expect(titles(filterEntries([optimistic], ['time:under-30']))).toEqual([])
    expect(titles(filterEntries([optimistic], ['time:1-2-hours']))).toEqual(['Optimistic'])
  })

  it('falls back to the claimed time when nothing has been measured', () => {
    const claimed = entry({ title: 'Claimed', claimedTimeMinutes: 25, actualTimeMinutes: null })
    expect(effectiveTimeMinutes(claimed)).toBe(25)
    expect(titles(filterEntries([claimed], ['time:under-30']))).toEqual(['Claimed'])
  })

  it('excludes a recipe with neither time rather than treating it as zero', () => {
    const unknown = entry({ title: 'Unknown', claimedTimeMinutes: null, actualTimeMinutes: null })
    const quick = entry({ title: 'Quick', claimedTimeMinutes: 10 })

    expect(effectiveTimeMinutes(unknown)).toBeNull()
    expect(entryTokens(unknown).some((t) => t.startsWith('time:'))).toBe(false)
    // Zero-coerced, "Unknown" would be the fastest recipe in the library.
    expect(titles(filterEntries([unknown, quick], ['time:under-30']))).toEqual(['Quick'])
  })

  it('puts each duration in exactly one bucket, inclusive at the top', () => {
    expect(timeBucketFor(30)).toBe('under-30')
    expect(timeBucketFor(31)).toBe('30-60')
    expect(timeBucketFor(60)).toBe('30-60')
    expect(timeBucketFor(120)).toBe('1-2-hours')
    expect(timeBucketFor(121)).toBe('over-2-hours')
    expect(timeBucketFor(null)).toBeNull()
  })
})

describe('sortEntries', () => {
  it('sorts by date, newest and oldest', () => {
    const old = entry({ title: 'Old', createdAt: 1_000 })
    const recent = entry({ title: 'Recent', createdAt: 9_000 })

    expect(titles(sortEntries([old, recent], 'newest'))).toEqual(['Recent', 'Old'])
    expect(titles(sortEntries([recent, old], 'oldest'))).toEqual(['Old', 'Recent'])
  })

  it('sorts by rating, highest first', () => {
    const three = entry({ title: 'Three', rating: 3 })
    const five = entry({ title: 'Five', rating: 5 })
    expect(titles(sortEntries([three, five], 'rating'))).toEqual(['Five', 'Three'])
  })

  it('sorts an unrated recipe last under "highest rated", never first', () => {
    // null is "nobody has rated this", not zero stars. Ordering it as zero
    // would still put it last here — but ordering it as a *missing* number
    // in a naive comparator routinely puts it first, and then the control
    // is useless: the 82 recipes nobody rated crowd out the five-star ones.
    const unrated = entry({ title: 'Unrated', rating: null })
    const one = entry({ title: 'One', rating: 1 })
    const five = entry({ title: 'Five', rating: 5 })

    expect(titles(sortEntries([unrated, one, five], 'rating'))).toEqual(['Five', 'One', 'Unrated'])
    expect(titles(sortEntries([one, unrated, five], 'rating'))).toEqual(['Five', 'One', 'Unrated'])
  })

  it('sorts by time, quickest first, with unknown times last', () => {
    const unknown = entry({ title: 'Unknown' })
    const slow = entry({ title: 'Slow', claimedTimeMinutes: 180 })
    const quick = entry({ title: 'Quick', claimedTimeMinutes: 15 })
    const measured = entry({ title: 'Measured', claimedTimeMinutes: 200, actualTimeMinutes: 20 })

    expect(titles(sortEntries([unknown, slow, quick, measured], 'time')))
      .toEqual(['Quick', 'Measured', 'Slow', 'Unknown'])
  })

  it('is stable for equal keys', () => {
    const a = entry({ title: 'A', rating: 4 })
    const b = entry({ title: 'B', rating: 4 })
    const c = entry({ title: 'C', rating: 4 })

    expect(titles(sortEntries([a, b, c], 'rating'))).toEqual(['A', 'B', 'C'])
    expect(titles(sortEntries([c, a, b], 'rating'))).toEqual(['C', 'A', 'B'])
    expect(titles(sortEntries([a, b, c], 'time'))).toEqual(['A', 'B', 'C'])
  })

  it('sorts a copy rather than the array it was given', () => {
    const entries = [entry({ title: 'B', createdAt: 1 }), entry({ title: 'A', createdAt: 2 })]
    sortEntries(entries, 'newest')
    expect(titles(entries)).toEqual(['B', 'A'])
  })
})

describe('applyFilterState', () => {
  it('filters and then sorts', () => {
    const entries = [
      entry({ title: 'Mid main', tags: ['course:main'], rating: 3 }),
      entry({ title: 'Best main', tags: ['course:main'], rating: 5 }),
      entry({ title: 'Best dessert', tags: ['course:dessert'], rating: 5 }),
    ]

    const result = applyFilterState(entries, { selected: ['course:main'], sort: 'rating' })
    expect(titles(result)).toEqual(['Best main', 'Mid main'])
  })
})

describe('toggleToken', () => {
  it('adds a token that is not selected and removes one that is', () => {
    expect(toggleToken([], 'course:main')).toEqual(['course:main'])
    expect(toggleToken(['course:main'], 'course:main')).toEqual([])
    expect(toggleToken(['course:main'], 'course:side')).toEqual(['course:main', 'course:side'])
  })
})

describe('URL state', () => {
  it('round-trips a filtered, sorted view', () => {
    const state = { selected: ['course:main', 'ingredient:seafood'], sort: 'rating' as const }
    const query = filterStateToQuery(state)
    const params = Object.fromEntries(new URLSearchParams(query.slice(1)))
    expect(parseFilterState(params)).toEqual(state)
  })

  it('leaves the URL clean for the default view', () => {
    expect(filterStateToQuery({ selected: [], sort: DEFAULT_SORT })).toBe('')
  })

  it('falls back to the default sort for an unknown one', () => {
    expect(parseFilterState({ sort: 'by-vibes' }).sort).toBe(DEFAULT_SORT)
  })

  it('drops malformed tokens and de-duplicates the rest', () => {
    const state = parseFilterState({ f: 'course:main,,garbage,:x,y:,course:main' })
    expect(state.selected).toEqual(['course:main'])
  })

  it('reads nothing as the default state', () => {
    expect(parseFilterState({})).toEqual({ selected: [], sort: DEFAULT_SORT })
    expect(parseFilterState(undefined)).toEqual({ selected: [], sort: DEFAULT_SORT })
  })

  it('takes the first value when a param is repeated', () => {
    expect(parseFilterState({ f: ['course:main', 'course:side'] }).selected).toEqual(['course:main'])
  })
})
