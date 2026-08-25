// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { EMPTY_FILTER_STATE } from '@/lib/library/filter'
import { LibraryView } from '@/components/library/library-view'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

/**
 * The same six-recipe library the counting tests use: four mains (two
 * seafood, two chicken), one seafood appetizer, one dessert.
 */
function library(): LibraryEntry[] {
  return [
    entry({ title: 'Salmon Traybake', tags: ['course:main', 'ingredient:seafood'] }),
    entry({ title: 'Shrimp Tacos', tags: ['course:main', 'ingredient:seafood'] }),
    entry({ title: 'Ceviche', tags: ['course:appetizer', 'ingredient:seafood'] }),
    entry({ title: 'Katsu Curry', tags: ['course:main', 'ingredient:chicken'] }),
    entry({ title: 'Roast Chicken', tags: ['course:main', 'ingredient:chicken'] }),
    entry({ title: 'Brownies', tags: ['course:dessert'] }),
  ]
}

function renderLibrary(entries = library()) {
  return render(<LibraryView entries={entries} initialState={{ ...EMPTY_FILTER_STATE }} />)
}

function cardTitles(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href')?.startsWith('/recipes/'))
    .map((link) => within(link).getByRole('heading').textContent ?? '')
    .sort()
}

/** Pretends the viewport is a phone, the way `useNarrowViewport` asks. */
function useNarrowViewport(matches: boolean) {
  window.innerWidth = matches ? 390 : 1440
  window.innerHeight = matches ? 844 : 900
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('filtering from the rail', () => {
  it('narrows the grid when a value is clicked', async () => {
    renderLibrary()
    expect(cardTitles()).toHaveLength(6)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))

    expect(cardTitles()).toEqual(['Ceviche', 'Salmon Traybake', 'Shrimp Tacos'])
    expect(screen.getByText('Showing 3 of 6 recipes')).toBeInTheDocument()
  })

  it('updates the other facets’ counts to what is available within the result', async () => {
    renderLibrary()
    expect(screen.getByRole('checkbox', { name: 'Main, 4 recipes' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))

    // Of the three seafood recipes, two are mains and one is an appetizer.
    expect(screen.getByRole('checkbox', { name: 'Main, 2 recipes' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Appetizer, 1 recipe' })).toBeInTheDocument()
  })

  it('keeps a facet’s own counts whole, so a second value in it never reads as a dead end', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 4 recipes' }))

    // Course counts ignore the course selection: clicking Dessert would
    // widen the result to five, so showing it as `0` would be a lie.
    expect(screen.getByRole('checkbox', { name: 'Dessert, 1 recipe' })).toBeEnabled()
  })

  it('ORs two values within one facet', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 4 recipes' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Dessert, 1 recipe' }))

    expect(cardTitles()).toEqual([
      'Brownies', 'Katsu Curry', 'Roast Chicken', 'Salmon Traybake', 'Shrimp Tacos',
    ])
  })

  it('ANDs values across two facets', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 4 recipes' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 2 recipes' }))

    expect(cardTitles()).toEqual(['Salmon Traybake', 'Shrimp Tacos'])
  })

  it('restores the whole grid when a filter is unticked', async () => {
    renderLibrary()

    const seafood = screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' })
    await userEvent.click(seafood)
    expect(cardTitles()).toHaveLength(3)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))
    expect(cardTitles()).toHaveLength(6)
  })

  it('clears everything at once', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 4 recipes' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 2 recipes' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(cardTitles()).toHaveLength(6)
  })

  it('lets an active filter be removed from the chip beside the results', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))
    const chips = screen.getByRole('list', { name: 'Active filters' })
    await userEvent.click(within(chips).getByRole('button', { name: /seafood/i }))

    expect(cardTitles()).toHaveLength(6)
  })

  it('updates the numbers in place without ever reordering the rows', async () => {
    renderLibrary()

    const names = () =>
      within(screen.getByRole('group', { name: 'Ingredient' }))
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent ?? '')

    expect(names()).toEqual(['Seafood3, 3 recipes', 'Chicken2, 2 recipes'])

    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 4 recipes' }))

    // Both are 2 now, and a live count-descending sort would hand the tie
    // to the alphabetical tiebreak and put Chicken first — moving a row the
    // reader was not touching. The order is frozen against the unfiltered
    // counts, so only the numbers change.
    expect(names()).toEqual(['Seafood2, 2 recipes', 'Chicken2, 2 recipes'])
  })

  it('disables a value that leads nowhere instead of hiding it', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))

    // No dessert has seafood in it. The row stays exactly where it was —
    // moving it would pull the next row out from under the cursor.
    const dessert = screen.getByRole('checkbox', { name: 'Dessert, 0 recipes' })
    expect(dessert).toBeInTheDocument()
    expect(dessert).toBeDisabled()
  })

  it('renders no heading for a facet nothing in the library carries', () => {
    renderLibrary()

    expect(screen.getByText('Course')).toBeInTheDocument()
    expect(screen.queryByText('Cuisine')).not.toBeInTheDocument()
    expect(screen.queryByText('Rating')).not.toBeInTheDocument()
    expect(screen.queryByText('Time')).not.toBeInTheDocument()
  })

  it('folds a long facet behind a control rather than growing forever', async () => {
    const cuisines = [
      'american', 'italian', 'mexican', 'chinese', 'japanese',
      'korean', 'thai', 'indian', 'french', 'greek',
    ]
    renderLibrary(cuisines.map((cuisine) => entry({ tags: [`cuisine:${cuisine}`] })))

    expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(10)
  })
})

describe('keyboard and screen-reader access', () => {
  it('announces each value with its own count', () => {
    renderLibrary()

    // The count is part of the accessible name, not a number floating
    // beside it — "eleven seafood mains" has to be audible, not just
    // visible.
    expect(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Dessert, 1 recipe' })).toBeInTheDocument()
  })

  it('groups values under their facet, and toggles with the space bar', async () => {
    renderLibrary()

    const course = screen.getByRole('group', { name: 'Course' })
    const main = within(course).getByRole('checkbox', { name: 'Main, 4 recipes' })

    main.focus()
    await userEvent.keyboard(' ')

    expect(main).toBeChecked()
    expect(cardTitles()).toHaveLength(4)
  })
})

describe('the rail on a phone', () => {
  it('is reachable at a narrow viewport, and filters from there', async () => {
    useNarrowViewport(true)
    renderLibrary()

    // Closed to begin with: a sheet that covers the grid on arrival is
    // worse than no sheet.
    expect(screen.queryByRole('checkbox', { name: 'Seafood, 3 recipes' })).not.toBeInTheDocument()

    const open = screen.getByRole('button', { name: 'Filters' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(open)

    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))

    expect(cardTitles()).toEqual(['Ceviche', 'Salmon Traybake', 'Shrimp Tacos'])
  })

  it('closes on the button that names the result, and keeps the filter', async () => {
    useNarrowViewport(true)
    renderLibrary()

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 recipes' }))

    expect(screen.queryByRole('checkbox', { name: /seafood/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument()
    expect(cardTitles()).toHaveLength(3)
  })

  it('closes on Escape', async () => {
    useNarrowViewport(true)
    renderLibrary()

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('checkbox', { name: /seafood/i })).not.toBeInTheDocument()
  })

  it('is always open, with no button to open it, on a wide viewport', () => {
    useNarrowViewport(false)
    renderLibrary()

    expect(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^filters/i })).not.toBeInTheDocument()
  })
})
