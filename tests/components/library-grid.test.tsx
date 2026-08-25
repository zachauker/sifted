// @vitest-environment jsdom
//
// The only tests in this repo that need a DOM. Everything else runs in the
// node environment configured in `vitest.config.mts`; this docblock opts
// just this file into jsdom.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { EMPTY_FILTER_STATE, parseFilterState } from '@/lib/library/filter'
import { LibraryView } from '@/components/library/library-view'

// jsdom implements no `matchMedia` at all, unlike every real browser this
// app runs in — `window.matchMedia` is `undefined` here unless stubbed.
// `useNarrowViewport` (see `src/components/library/use-narrow-viewport.ts`)
// guesses narrow for the single render before an effect can measure the
// real viewport, which is deliberate: it is the fix for a lockout where a
// wrong "wide" guess left the filter toggle unreachable. But every test in
// this file is written against the desktop layout, so a wide `matchMedia`
// is stubbed here to stand in for the real one a browser always provides.
beforeEach(() => {
  window.innerWidth = 1440
  window.innerHeight = 900
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
})

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
    thumbUrl: `https://blob.example.com/thumb-${counter}.jpg`,
    publisher: 'Example Kitchen',
    rating: null,
    status: null,
    claimedTimeMinutes: null,
    actualTimeMinutes: null,
    createdAt: counter,
    tags: [],
    ...overrides,
  }
}

function renderLibrary(entries: LibraryEntry[]) {
  return render(<LibraryView entries={entries} initialState={{ ...EMPTY_FILTER_STATE }} />)
}

/**
 * The visible results-summary sentence — scoped to its own element rather
 * than found by `getByText`, because the same sentence also lands (after a
 * debounce) in a second, screen-reader-only `role="status"` element right
 * beside it. Querying by text alone would find both once they agree, which
 * they eventually always do.
 */
function resultsSummary(): string {
  return screen.getByTestId('results-summary').textContent ?? ''
}

/** The recipe cards, in the order they appear on screen. */
function cardTitles(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href')?.startsWith('/recipes/'))
    .map((link) => within(link).getByRole('heading').textContent ?? '')
}

describe('the page structure', () => {
  it('has exactly one <h1>, like every other route', () => {
    renderLibrary([entry()])
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})

describe('the recipe grid', () => {
  it('renders every recipe as a card showing its title', () => {
    renderLibrary([
      entry({ title: 'Miso Butter Salmon' }),
      entry({ title: 'Sunday Ragù' }),
      entry({ title: 'Chana Masala' }),
    ])

    // Newest first, which is `buildLibraryIndex`'s order and the default
    // sort — the helper gives each successive entry a later `createdAt`.
    expect(cardTitles()).toEqual(['Chana Masala', 'Sunday Ragù', 'Miso Butter Salmon'])
  })

  it('links each card to its recipe page', () => {
    renderLibrary([entry({ title: 'Miso Butter Salmon', slug: 'miso-butter-salmon' })])

    expect(screen.getByRole('link', { name: /miso butter salmon/i })).toHaveAttribute(
      'href',
      '/recipes/miso-butter-salmon',
    )
  })

  it('says how many recipes are showing', () => {
    renderLibrary([entry(), entry()])
    expect(resultsSummary()).toBe('Showing 2 recipes')
  })

  it('shows a rating and a time on the card when they are known', () => {
    renderLibrary([entry({ title: 'Katsu', rating: 4, claimedTimeMinutes: 95 })])

    const card = screen.getByRole('link', { name: /katsu/i })
    expect(within(card).getByText('4 stars')).toBeInTheDocument()
    expect(within(card).getByText('1h 35m')).toBeInTheDocument()
  })
})

describe('a recipe with no photo', () => {
  const noPhoto = () => entry({ title: 'Grandma’s Potato Rolls', slug: 'potato-rolls', thumbUrl: null })

  it('still renders a card that is still clickable', async () => {
    renderLibrary([noPhoto()])

    const card = screen.getByRole('link', { name: /potato rolls/i })
    expect(card).toHaveAttribute('href', '/recipes/potato-rolls')
    // No <img> at all, rather than an <img> pointing at nothing.
    expect(within(card).queryByRole('img')).not.toBeInTheDocument()
  })

  it('is not a blank hole: the tile carries the recipe’s own title', () => {
    renderLibrary([noPhoto()])

    // Queried by test id because the tile deliberately has no role and is
    // `aria-hidden` — everything in it repeats the card's title text, which
    // is already announced once. It is there for the eye, not the ear.
    const tile = within(screen.getByRole('link', { name: /potato rolls/i })).getByTestId(
      'photo-fallback',
    )
    expect(tile).toHaveTextContent('Grandma’s Potato Rolls')
    expect(tile).toHaveAttribute('aria-hidden', 'true')
  })

  it('gives the same recipe the same colour every time, so it stays recognisable', () => {
    const { unmount } = renderLibrary([noPhoto()])
    const first = screen.getByTestId('photo-fallback').getAttribute('style')
    unmount()

    renderLibrary([noPhoto()])
    expect(screen.getByTestId('photo-fallback')).toHaveAttribute('style', first)
  })

  it('gives two different recipes different colours', () => {
    renderLibrary([
      entry({ title: 'Grandma’s Potato Rolls', thumbUrl: null }),
      entry({ title: 'Chana Masala', thumbUrl: null }),
    ])

    const [a, b] = screen.getAllByTestId('photo-fallback')
    expect(a.getAttribute('style')).not.toBe(b.getAttribute('style'))
  })
})

describe('sorting', () => {
  const library = [
    entry({ title: 'Old Favourite', createdAt: 1_000, rating: 5, claimedTimeMinutes: 240 }),
    entry({ title: 'Unrated Newcomer', createdAt: 9_000, rating: null, claimedTimeMinutes: 20 }),
    entry({ title: 'Middling', createdAt: 5_000, rating: 3, claimedTimeMinutes: 45 }),
  ]

  async function sortBy(label: string) {
    await userEvent.selectOptions(screen.getByLabelText('Sort'), label)
  }

  it('defaults to newest first', () => {
    renderLibrary(library)
    expect(cardTitles()).toEqual(['Unrated Newcomer', 'Middling', 'Old Favourite'])
  })

  it('reorders by date, rating and time', async () => {
    renderLibrary(library)

    await sortBy('Oldest first')
    expect(cardTitles()).toEqual(['Old Favourite', 'Middling', 'Unrated Newcomer'])

    await sortBy('Quickest first')
    expect(cardTitles()).toEqual(['Unrated Newcomer', 'Middling', 'Old Favourite'])
  })

  it('sorts an unrated recipe last under "highest rated", not first', async () => {
    renderLibrary(library)

    await sortBy('Highest rated')
    expect(cardTitles()).toEqual(['Old Favourite', 'Middling', 'Unrated Newcomer'])
  })
})

describe('the empty states', () => {
  it('says something useful and offers a way back when nothing matches', async () => {
    // Reached by opening a stale shared link, not by clicking: the rail
    // disables every value that would empty the grid, so a combination like
    // this one is only arrivable through the URL. That makes the way back
    // out of it the only thing standing between the reader and a dead end.
    render(
      <LibraryView
        entries={[
          entry({ title: 'Chana Masala', tags: ['course:main'], status: 'want_to_make' }),
          entry({ title: 'Brownies', tags: ['course:dessert'], status: 'made_it' }),
        ]}
        initialState={{ selected: ['course:dessert', 'status:want_to_make'], sort: 'newest' }}
      />,
    )

    expect(screen.getByText('No recipes match these filters.')).toBeInTheDocument()
    expect(resultsSummary()).toBe('Showing 0 of 2 recipes')

    await userEvent.click(screen.getByRole('button', { name: 'Clear all filters' }))
    expect(cardTitles()).toEqual(['Brownies', 'Chana Masala'])
  })

  it('says the library is empty rather than rendering nothing at all', () => {
    renderLibrary([])
    expect(screen.getByText(/nothing in the library yet/i)).toBeInTheDocument()
  })
})

describe('the URL', () => {
  it('carries the filters, so a narrowed view can be reloaded or shared', async () => {
    renderLibrary([
      entry({ title: 'Salmon Traybake', tags: ['course:main', 'ingredient:seafood'] }),
      entry({ title: 'Brownies', tags: ['course:dessert'] }),
    ])

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seafood, 1 recipe' }))
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'Highest rated')

    expect(window.location.search).toBe('?f=ingredient%3Aseafood&sort=rating')
  })

  it('reads that URL back into the same view', () => {
    render(
      <LibraryView
        entries={[
          entry({ title: 'Salmon Traybake', tags: ['course:main', 'ingredient:seafood'] }),
          entry({ title: 'Brownies', tags: ['course:dessert'] }),
        ]}
        initialState={parseFilterState({ f: 'ingredient:seafood', sort: 'rating' })}
      />,
    )

    expect(cardTitles()).toEqual(['Salmon Traybake'])
    expect(screen.getByRole('checkbox', { name: 'Seafood, 1 recipe' })).toBeChecked()
  })

  it('leaves a clean URL behind when the filters are cleared', async () => {
    renderLibrary([entry({ title: 'Brownies', tags: ['course:dessert'] })])

    await userEvent.click(screen.getByRole('checkbox', { name: 'Dessert, 1 recipe' }))
    expect(window.location.search).not.toBe('')

    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(window.location.search).toBe('')
  })
})

describe('search', () => {
  /**
   * Built fresh per test (rather than a module-level constant) so each
   * test can read back the real `id` the shared `entry()` counter assigned
   * — needed to build a realistic `/api/search` mock response.
   */
  function library() {
    const salmon = entry({
      title: 'Miso Butter Salmon',
      slug: 'miso-butter-salmon',
      tags: ['course:main', 'ingredient:seafood'],
    })
    const chana = entry({ title: 'Chana Masala', slug: 'chana-masala', tags: ['course:main'] })
    const ragu = entry({
      title: 'Sunday Ragù',
      slug: 'sunday-ragu',
      publisher: 'Bon Appétit',
      tags: ['course:main'],
    })
    return { salmon, chana, ragu, all: [salmon, chana, ragu] }
  }

  function searchBox() {
    return screen.getByRole('searchbox', { name: /search recipes/i })
  }

  it('filters locally and instantly while typing, and names the tier that produced the results', async () => {
    renderLibrary(library().all)

    await userEvent.type(searchBox(), 'salmon')

    expect(cardTitles()).toEqual(['Miso Butter Salmon'])
    expect(resultsSummary()).toMatch(/matched titles, publishers, and tags/i)
  })

  it('composes with the filter rail: narrows the already-filtered set rather than replacing it', async () => {
    renderLibrary(library().all)

    // All three recipes are `course:main`, so selecting it should not
    // change what's on screen yet.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 3 recipes' }))
    expect(cardTitles()).toHaveLength(3)

    // Salmon is also a main, but the query only matches Chana Masala's
    // title — proving search AND filter rather than search OR filter.
    await userEvent.type(searchBox(), 'chana')

    expect(cardTitles()).toEqual(['Chana Masala'])
    // The rail selection itself is untouched by typing into search.
    expect(screen.getByRole('checkbox', { name: 'Main, 3 recipes' })).toBeChecked()
  })

  it('tells a title-only miss that searching inside recipes is one click away, rather than looking like an empty library', async () => {
    renderLibrary(library().all)

    await userEvent.type(searchBox(), 'gochujang')

    expect(screen.getByText(/no titles, publishers, or tags match/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search inside recipes' })).toBeInTheDocument()
  })

  it('runs the server tier on demand, labels the results by tier, and leaves the filter rail and the search box alone', async () => {
    const { all, chana } = library()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ids: [chana.id] }) })
    vi.stubGlobal('fetch', fetchMock)

    renderLibrary(all)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Main, 3 recipes' }))

    const box = searchBox()
    // Submitted with Enter, not a click on a separate button, because the
    // thing under test is whether the search box itself survives the round
    // trip — typing, hitting enter, and watching the results land without
    // losing your place or your cursor.
    await userEvent.type(box, 'gochujang{enter}')

    await waitFor(() => expect(resultsSummary()).toMatch(/matched inside recipes/i))

    expect(fetchMock).toHaveBeenCalledWith('/api/search?q=gochujang')
    expect(cardTitles()).toEqual(['Chana Masala'])
    // A search box that clears itself or loses focus mid-typing (or the
    // instant results land) is the specific failure this test exists to
    // catch.
    expect(box).toHaveValue('gochujang')
    expect(document.activeElement).toBe(box)
    expect(screen.getByRole('checkbox', { name: 'Main, 3 recipes' })).toBeChecked()
  })

  it('distinguishes "nothing matched inside recipes" from "haven\'t searched yet"', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ids: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    renderLibrary(library().all)
    expect(screen.queryByText(/no matches inside recipes/i)).not.toBeInTheDocument()

    // A query that hasn't been sent to the server yet must not be
    // mistaken for a completed, empty server search.
    await userEvent.type(searchBox(), 'gochujang')
    expect(screen.queryByText(/no matches inside recipes/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Search inside recipes' }))
    await waitFor(() => expect(screen.getByText(/no matches inside recipes/i)).toBeInTheDocument())
  })

  it('reverts to the local tier when the query changes after a server search, rather than showing a stale server answer', async () => {
    const { all, chana, salmon } = library()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ids: [chana.id] }) })
    vi.stubGlobal('fetch', fetchMock)

    renderLibrary(all)
    const box = searchBox()
    await userEvent.type(box, 'gochujang')
    await userEvent.click(screen.getByRole('button', { name: 'Search inside recipes' }))
    await waitFor(() => expect(cardTitles()).toEqual(['Chana Masala']))

    await userEvent.clear(box)
    await userEvent.type(box, 'salmon')

    expect(resultsSummary()).toMatch(/matched titles, publishers, and tags/i)
    expect(cardTitles()).toEqual([salmon.title])
  })

  /**
   * `aria-live="polite"` wrapped the visible summary directly and fired
   * on every keystroke: typing "chicken" queued seven full sentences for
   * a screen reader, one per character. The fix keeps the visible text
   * instant (covered by the tests above) but only announces the settled
   * value, half a second after typing stops — see `useDebouncedValue` in
   * `library-view.tsx`.
   */
  describe('the results summary announced to screen readers', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** The screen-reader-only `role="status"` twin of the visible summary. */
    function announcedSummary(): string {
      return screen.getByRole('status').textContent ?? ''
    }

    it('does not update the announcement on every keystroke, only once typing pauses', () => {
      vi.useFakeTimers()
      renderLibrary(library().all)

      const beforeTyping = announcedSummary()

      // `fireEvent`, not `userEvent`, and a single change rather than a
      // key at a time: what's under test is the debounce timer, and
      // `userEvent.type` drives its own real-time-based key-by-key
      // simulation that fake timers fight rather than cooperate with.
      // One change event is exactly what the search box's own `onChange`
      // sees for any single keystroke.
      act(() => {
        fireEvent.change(searchBox(), { target: { value: 'salmon' } })
      })

      // The visible summary is already correct — it is never debounced —
      // but the announcement has not caught up, because typing has not
      // paused for long enough yet.
      expect(resultsSummary()).toMatch(/matched titles, publishers, and tags/i)
      expect(announcedSummary()).toBe(beforeTyping)

      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(announcedSummary()).toMatch(/matched titles, publishers, and tags/i)
    })

    it('is a role="status" region, carrying its own implicit polite announcement', () => {
      renderLibrary(library().all)
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
  })
})
