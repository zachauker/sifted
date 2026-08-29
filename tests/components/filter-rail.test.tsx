// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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

/**
 * The visible results-summary sentence — scoped to its own element rather
 * than found by `getByText`, because the same sentence also lands (after a
 * debounce) in a second, screen-reader-only `role="status"` element right
 * beside it.
 */
function resultsSummary(): string {
  return screen.getByTestId('results-summary').textContent ?? ''
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

// jsdom (unlike every real browser this app runs in) implements no
// `matchMedia` at all — `window.matchMedia` is `undefined` here unless a
// test stubs it. `useNarrowViewport` now guesses narrow for the one render
// before an effect can ask, which is the fix for the lockout in Defect 1,
// but it means "no stub" no longer means "wide" the way it used to.
// Every test in this file except the ones under "the rail on a phone"
// below is written against a desktop layout, so a wide `matchMedia` is
// stubbed by default here — standing in for the real `matchMedia` a
// browser always provides — and overridden explicitly where a test wants
// a phone.
beforeEach(() => {
  useNarrowViewport(false)
})

describe('filtering from the rail', () => {
  it('narrows the grid when a value is clicked', async () => {
    renderLibrary()
    expect(cardTitles()).toHaveLength(6)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))

    expect(cardTitles()).toEqual(['Ceviche', 'Salmon Traybake', 'Shrimp Tacos'])
    expect(resultsSummary()).toBe('Showing 3 of 6 recipes')
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
    // Not the real `disabled` attribute — that would also pull the row
    // out of the tab order, so a keyboard or screen-reader user would
    // never learn "Dessert" exists at all. `aria-disabled` marks it inert
    // without hiding it from anyone.
    expect(dessert).toHaveAttribute('aria-disabled', 'true')
    expect(dessert).toBeEnabled()
  })

  it('leaves a value that leads nowhere reachable by keyboard, and ticking it a no-op', async () => {
    renderLibrary()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 3 recipes' }))
    const dessert = screen.getByRole('checkbox', { name: 'Dessert, 0 recipes' })

    // Still tabbable — the entire point of `aria-disabled` over `disabled`
    // — and clicking it changes nothing, because it would lead to an
    // empty grid.
    dessert.focus()
    expect(dessert).toHaveFocus()

    await userEvent.click(dessert)

    expect(dessert).not.toBeChecked()
    expect(cardTitles()).toEqual(['Ceviche', 'Salmon Traybake', 'Shrimp Tacos'])
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
    // The count moved out of the visible label and into a badge beside it, so
    // the accessible name now spells out what the number counts rather than
    // parenthesising it. Same guarantee as before: closing the sheet does not
    // lose the fact that one filter is on.
    expect(screen.getByRole('button', { name: 'Filters, 1 selected' })).toBeInTheDocument()
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

/**
 * Defect 4: the sheet opened, scrolled, and closed three ways already, but
 * carried none of the semantics or focus management that make it an
 * actual dialog rather than a `<div>` that happens to look like one — no
 * `role="dialog"`/`aria-modal`, no focus move on open, no focus return on
 * close, no trap (Tab walked into the 156 cards behind the scrim), and no
 * body scroll lock (iOS scroll-chained past the sheet's end).
 */
describe('the sheet as a dialog', () => {
  it('is not a dialog at all on a wide viewport, where it is a persistent sidebar', () => {
    useNarrowViewport(false)
    renderLibrary()

    // A screen reader must not be told the rest of the page is unavailable
    // when the rail is simply always on screen beside it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('becomes a labelled, modal dialog only once open on a narrow viewport', async () => {
    useNarrowViewport(true)
    renderLibrary()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))

    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('moves focus into the sheet the moment it opens', async () => {
    useNarrowViewport(true)
    renderLibrary()

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))

    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Filters' }))
  })

  it('returns focus to the button that opened it when closed on Escape', async () => {
    useNarrowViewport(true)
    renderLibrary()

    const open = screen.getByRole('button', { name: 'Filters' })
    await userEvent.click(open)
    await userEvent.keyboard('{Escape}')

    // Left alone, Escape drops focus to <body> — indistinguishable, to
    // anyone not looking at the screen, from focus going nowhere at all.
    expect(document.activeElement).toBe(open)
  })

  it('returns focus to the button that opened it when closed on the scrim', async () => {
    useNarrowViewport(true)
    renderLibrary()

    const open = screen.getByRole('button', { name: 'Filters' })
    await userEvent.click(open)
    // The scrim carries no accessible role (`aria-hidden`), so it's found
    // by the one thing distinguishing it from every other fixed-position
    // layer: no other element in the sheet is a plain, unlabelled sibling
    // of the dialog sitting behind it. Reached instead through the DOM
    // directly, the same way a real pointer tap would land on it.
    const scrim = document.querySelector('[aria-hidden="true"].fixed.inset-0')
    expect(scrim).not.toBeNull()
    await userEvent.click(scrim as Element)

    expect(document.activeElement).toBe(open)
  })

  it('returns focus to the button that opened it when closed on "Show N recipes"', async () => {
    useNarrowViewport(true)
    renderLibrary()

    const open = screen.getByRole('button', { name: 'Filters' })
    await userEvent.click(open)
    await userEvent.click(screen.getByRole('button', { name: 'Show 6 recipes' }))

    expect(document.activeElement).toBe(open)
  })

  it('traps Tab inside the sheet rather than letting it reach the 156 cards behind the scrim', async () => {
    useNarrowViewport(true)
    renderLibrary()

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    const dialog = screen.getByRole('dialog', { name: 'Filters' })

    // More tab stops than the sheet has controls, forward and back: every
    // one of them has to land back inside the dialog, never on the sort
    // select or a card link sitting behind the scrim.
    for (let i = 0; i < 12; i++) {
      await userEvent.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    for (let i = 0; i < 12; i++) {
      await userEvent.tab({ shift: true })
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('takes the rest of the page out of the tab order and the accessibility tree while the sheet is open', async () => {
    useNarrowViewport(true)
    renderLibrary()

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))

    expect(screen.getByTestId('library-toolbar')).toHaveAttribute('inert', '')
    expect(screen.getByTestId('library-grid-region')).toHaveAttribute('inert', '')

    await userEvent.click(screen.getByRole('button', { name: /show \d+ recipe/i }))

    expect(screen.getByTestId('library-toolbar')).not.toHaveAttribute('inert')
    expect(screen.getByTestId('library-grid-region')).not.toHaveAttribute('inert')
  })

  it('locks the body scroll while open, and releases it on close', async () => {
    useNarrowViewport(true)
    renderLibrary()

    expect(document.body.style.overflow).not.toBe('hidden')

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(document.body.style.overflow).toBe('hidden')

    await userEvent.keyboard('{Escape}')
    expect(document.body.style.overflow).not.toBe('hidden')
  })
})
