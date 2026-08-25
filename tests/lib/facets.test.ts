import { describe, it, expect } from 'vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { applyFilterState } from '@/lib/library/filter'
import {
  computeFacetCounts,
  labelForValue,
  splitVisibleValues,
  type FacetGroup,
} from '@/lib/library/facets'

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

function group(groups: FacetGroup[], facet: string): FacetGroup | undefined {
  return groups.find((g) => g.facet === facet)
}

/** `{ value: count }` for one facet, for compact assertions. */
function counts(groups: FacetGroup[], facet: string): Record<string, number> {
  return Object.fromEntries((group(groups, facet)?.values ?? []).map((v) => [v.value, v.count]))
}

/**
 * The worked example the exclusion rule is explained against, six recipes
 * wide so every number can be checked by hand:
 *
 *   main + seafood, main + seafood, appetizer + seafood,
 *   main + chicken, main + chicken, dessert (no ingredient)
 */
const LIBRARY: LibraryEntry[] = [
  entry({ title: 'Salmon Traybake', tags: ['course:main', 'ingredient:seafood'] }),
  entry({ title: 'Shrimp Tacos', tags: ['course:main', 'ingredient:seafood'] }),
  entry({ title: 'Ceviche', tags: ['course:appetizer', 'ingredient:seafood'] }),
  entry({ title: 'Katsu Curry', tags: ['course:main', 'ingredient:chicken'] }),
  entry({ title: 'Roast Chicken', tags: ['course:main', 'ingredient:chicken'] }),
  entry({ title: 'Brownies', tags: ['course:dessert'] }),
]

describe('computeFacetCounts, unfiltered', () => {
  it('counts how many recipes carry each value', () => {
    const groups = computeFacetCounts(LIBRARY, [])
    expect(counts(groups, 'course')).toEqual({ main: 4, appetizer: 1, dessert: 1 })
    expect(counts(groups, 'ingredient')).toEqual({ seafood: 3, chicken: 2 })
  })

  it('renders no heading for a facet nothing in the library carries', () => {
    const groups = computeFacetCounts(LIBRARY, [])
    // Nothing here has a cuisine, a rating, a status or a time.
    expect(group(groups, 'cuisine')).toBeUndefined()
    expect(group(groups, 'rating')).toBeUndefined()
    expect(group(groups, 'status')).toBeUndefined()
    expect(group(groups, 'time')).toBeUndefined()
  })

  it('lists facets in the rail order the spec chose', () => {
    const groups = computeFacetCounts(
      [
        entry({ tags: ['course:main', 'ingredient:beef', 'method:oven', 'cuisine:italian', 'tag:soup'] }),
        entry({ tags: [], rating: 4, status: 'made_it', claimedTimeMinutes: 20 }),
      ],
      [],
    )
    expect(groups.map((g) => g.facet)).toEqual([
      'course', 'ingredient', 'method', 'cuisine', 'tag', 'untagged', 'status', 'rating', 'time',
    ])
  })
})

describe('computeFacetCounts and the facet-exclusion rule', () => {
  it('counts a facet with that facet’s own filters excluded', () => {
    // THE RULE. With `course:main` selected:
    //
    //  - INGREDIENT counts honour the course filter, because that is the
    //    question being asked — "what can I cook, within mains?" Ceviche's
    //    seafood is not counted: it is an appetizer.
    //  - COURSE counts ignore the course filter, because within a facet
    //    selections OR together, so clicking `appetizer` *widens* the
    //    result to 5 recipes rather than narrowing it to none. Counting
    //    courses the naive way would show `appetizer 0` and `dessert 0`,
    //    which reads as "there is nothing there" beside a control that
    //    works perfectly.
    const groups = computeFacetCounts(LIBRARY, ['course:main'])

    expect(counts(groups, 'ingredient')).toEqual({ seafood: 2, chicken: 2 })
    expect(counts(groups, 'course')).toEqual({ main: 4, appetizer: 1, dessert: 1 })
  })

  it('applies every other facet’s filters when counting a facet', () => {
    // Both selected. Course counts drop the course filter but keep the
    // ingredient one: of the 3 seafood recipes, 2 are mains and 1 is an
    // appetizer, and no dessert has seafood — so `dessert` is 0 here, and
    // that zero is honest, unlike the one above.
    const groups = computeFacetCounts(LIBRARY, ['course:main', 'ingredient:seafood'])

    expect(counts(groups, 'course')).toEqual({ main: 2, appetizer: 1, dessert: 0 })
    expect(counts(groups, 'ingredient')).toEqual({ seafood: 2, chicken: 2 })
  })

  it('keeps a genuinely empty value visible but disabled, not hidden', () => {
    const groups = computeFacetCounts(LIBRARY, ['course:main', 'ingredient:seafood'])
    const dessert = group(groups, 'course')?.values.find((v) => v.value === 'dessert')

    expect(dessert).toMatchObject({ count: 0, disabled: true })
  })

  it('never disables a selected value, even at zero', () => {
    const groups = computeFacetCounts(LIBRARY, ['course:dessert', 'ingredient:seafood'])
    const dessert = group(groups, 'course')?.values.find((v) => v.value === 'dessert')

    // Zero results, but it has to stay clickable — switching it off is the
    // only way out of an empty grid.
    expect(dessert).toMatchObject({ selected: true, disabled: false })
  })

  it('gives a selected value nothing carries a row, so it can be switched off', () => {
    const groups = computeFacetCounts(LIBRARY, ['cuisine:martian'])
    expect(counts(groups, 'cuisine')).toEqual({ martian: 0 })
    expect(group(groups, 'cuisine')?.values[0]).toMatchObject({ selected: true, disabled: false })
  })
})

describe('computeFacetCounts ordering', () => {
  it('sorts by count descending, then alphabetically', () => {
    const groups = computeFacetCounts(
      [
        entry({ tags: ['cuisine:thai'] }),
        entry({ tags: ['cuisine:thai'] }),
        entry({ tags: ['cuisine:italian'] }),
        entry({ tags: ['cuisine:french'] }),
      ],
      [],
    )
    expect(group(groups, 'cuisine')?.values.map((v) => v.value)).toEqual([
      'thai', 'french', 'italian',
    ])
  })

  it('freezes the order against the unfiltered counts, so rows never move as you filter', () => {
    // The order is count-descending — but computed once, against the whole
    // library, and then held still. Unfiltered, Ingredient reads
    // `Seafood 3, Chicken 2`. Select `course:main` and the live counts
    // become 2 and 2, which under a live sort would hand the tie to the
    // alphabetical tiebreak and swap the two rows on an unrelated click.
    //
    // "Disabled, not hidden" exists so values do not move under the
    // cursor; re-sorting by live counts moves them anyway, and worse, only
    // sometimes. What a person builds up is spatial memory — Seafood is the
    // second row under Ingredient — so the numbers update in place and the
    // rows stay put.
    const before = group(computeFacetCounts(LIBRARY, []), 'ingredient')
    expect(before?.values.map((v) => [v.value, v.count])).toEqual([
      ['seafood', 3],
      ['chicken', 2],
    ])

    const after = group(computeFacetCounts(LIBRARY, ['course:main']), 'ingredient')
    expect(after?.values.map((v) => [v.value, v.count])).toEqual([
      ['seafood', 2],
      ['chicken', 2],
    ])
  })

  it('holds the order still even when a value drops to zero', () => {
    const groups = computeFacetCounts(LIBRARY, ['ingredient:chicken'])
    // Both chicken recipes are mains, so Appetizer and Dessert fall to
    // zero — and stay exactly where they were, rather than sinking below
    // Main or, worse, swapping with each other on the alphabetical
    // tiebreak that a live sort would now be deciding between them.
    expect(group(groups, 'course')?.values.map((v) => [v.value, v.count])).toEqual([
      ['main', 2],
      ['appetizer', 0],
      ['dessert', 0],
    ])
  })

  it('keeps rating and time in their natural order rather than by count', () => {
    // A star scale shuffled by popularity is nonsense, and a fixed order is
    // even more stable between renders than count-descending is.
    const groups = computeFacetCounts(
      [
        entry({ rating: 3, claimedTimeMinutes: 200 }),
        entry({ rating: 3, claimedTimeMinutes: 200 }),
        entry({ rating: 5, claimedTimeMinutes: 10 }),
      ],
      [],
    )
    expect(group(groups, 'rating')?.values.map((v) => v.value)).toEqual(['5', '3'])
    expect(group(groups, 'time')?.values.map((v) => v.value)).toEqual(['under-30', 'over-2-hours'])
  })
})

describe('derived facets', () => {
  it('counts status, rating and bucketed time', () => {
    const groups = computeFacetCounts(
      [
        entry({ status: 'made_it', rating: 5, claimedTimeMinutes: 25 }),
        entry({ status: 'made_it', rating: 4, actualTimeMinutes: 25, claimedTimeMinutes: 200 }),
        entry({ status: 'want_to_make' }),
      ],
      [],
    )
    expect(counts(groups, 'status')).toEqual({ made_it: 2, want_to_make: 1 })
    expect(counts(groups, 'rating')).toEqual({ '5': 1, '4': 1 })
    // The second recipe claims 200 minutes but was measured at 25.
    expect(counts(groups, 'time')).toEqual({ 'under-30': 2 })
  })

  it('offers an untagged escape hatch only when something is untagged', () => {
    expect(counts(computeFacetCounts(LIBRARY, []), 'untagged')).toEqual({})
    const withOrphan = [...LIBRARY, entry({ title: 'Grandma’s Rolls', tags: [] })]
    expect(counts(computeFacetCounts(withOrphan, []), 'untagged')).toEqual({ yes: 1 })
  })
})

describe('labels', () => {
  it('reads as prose rather than as database values', () => {
    expect(labelForValue('course', 'main')).toBe('Main')
    expect(labelForValue('method', 'slow-cooker')).toBe('Slow Cooker')
    expect(labelForValue('status', 'want_to_make')).toBe('Want to make')
    expect(labelForValue('rating', '5')).toBe('5 stars')
    expect(labelForValue('rating', '1')).toBe('1 star')
    expect(labelForValue('time', 'under-30')).toBe('30 minutes or less')
    expect(labelForValue('untagged', 'yes')).toBe('No tags')
  })
})

describe('the cost of one interaction', () => {
  it('recomputes the grid and every count for a 156-recipe library in well under a frame', () => {
    // The entire design rests on this: no network round trip per click
    // means a click has to be free, or it is just a slower version of a
    // request. Measured at ~0.28ms per interaction (filter + sort + all
    // nine facets' counts) on the development machine; the bound below is
    // ~17x that, loose enough never to flake on a loaded CI box and tight
    // enough to catch someone making this quadratic.
    const courses = ['main', 'side', 'appetizer', 'dessert', 'breakfast', 'sauce', 'bread', 'drink']
    const ingredients = ['chicken', 'beef', 'pork', 'seafood', 'egg', 'pasta', 'rice', 'vegetable']
    const methods = ['grill', 'oven', 'stovetop', 'slow-cooker', 'air-fryer', 'no-cook']
    const cuisines = ['american', 'italian', 'mexican', 'thai', 'indian', 'french']

    const entries = Array.from({ length: 156 }, (_, i) =>
      entry({
        rating: i % 3 === 0 ? null : (i % 5) + 1,
        status: i % 2 === 0 ? 'made_it' : 'want_to_make',
        claimedTimeMinutes: 20 + (i % 200),
        actualTimeMinutes: i % 4 === 0 ? 30 + (i % 180) : null,
        tags: [
          `course:${courses[i % courses.length]}`,
          `ingredient:${ingredients[i % ingredients.length]}`,
          `method:${methods[i % methods.length]}`,
          `cuisine:${cuisines[i % cuisines.length]}`,
        ],
      }),
    )
    const selected = ['course:main', 'status:made_it', 'time:30-60', 'rating:5']

    for (let i = 0; i < 20; i += 1) computeFacetCounts(entries, selected)

    const started = performance.now()
    const rounds = 100
    for (let i = 0; i < rounds; i += 1) {
      applyFilterState(entries, { selected, sort: 'rating' })
      computeFacetCounts(entries, selected)
    }
    const perInteraction = (performance.now() - started) / rounds

    expect(perInteraction).toBeLessThan(5)
  })
})

describe('splitVisibleValues', () => {
  const values = computeFacetCounts(LIBRARY, [])[0].values

  it('shows everything under the default tuning', () => {
    expect(splitVisibleValues(values).folded).toEqual([])
  })

  it('folds the long tail away when a threshold is set', () => {
    const { visible, folded } = splitVisibleValues(values, { minLibraryCount: 2, collapseAfter: 8 })
    expect(visible.map((v) => v.value)).toEqual(['main'])
    expect(folded.map((v) => v.value)).toEqual(['appetizer', 'dessert'])
  })

  it('caps how many values a facet shows before folding', () => {
    const { visible, folded } = splitVisibleValues(values, { minLibraryCount: 1, collapseAfter: 2 })
    expect(visible).toHaveLength(2)
    expect(folded).toHaveLength(1)
  })

  it('decides the fold from the unfiltered counts, so values never hop across it', () => {
    // Same reasoning as the ordering above: a row you could see a moment
    // ago must not retreat behind "Show 1 more" because of an unrelated
    // click. `libraryCount` is filter-independent, so the two sides of the
    // fold are identical whatever is selected.
    const tuning = { minLibraryCount: 1, collapseAfter: 2 }
    const unfiltered = splitVisibleValues(computeFacetCounts(LIBRARY, [])[0].values, tuning)
    const filtered = splitVisibleValues(
      computeFacetCounts(LIBRARY, ['ingredient:chicken'])[0].values,
      tuning,
    )

    expect(filtered.visible.map((v) => v.value)).toEqual(unfiltered.visible.map((v) => v.value))
    expect(filtered.folded.map((v) => v.value)).toEqual(unfiltered.folded.map((v) => v.value))
  })

  it('shows a selected value without costing a neighbour its slot', () => {
    // A selected value below the fold is shown as well, but does not
    // consume one of the `collapseAfter` slots — so switching something on
    // can never push an unrelated row down behind the fold.
    const values = computeFacetCounts(LIBRARY, ['course:dessert'])[0].values
    const { visible, folded } = splitVisibleValues(values, { minLibraryCount: 1, collapseAfter: 2 })

    expect(visible.map((v) => v.value)).toEqual(['main', 'appetizer', 'dessert'])
    expect(folded).toEqual([])
  })

  it('never folds away a value that is switched on', () => {
    const selected = computeFacetCounts(LIBRARY, ['course:dessert'])[0].values
    const { visible } = splitVisibleValues(selected, { minLibraryCount: 99, collapseAfter: 0 })
    expect(visible.map((v) => v.value)).toEqual(['dessert'])
  })
})
