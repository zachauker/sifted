// @vitest-environment jsdom
//
// The only tests in this repo that need a DOM. Everything else runs in the
// node environment configured in `vitest.config.mts`; this docblock opts
// just this file into jsdom.
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { EMPTY_FILTER_STATE, parseFilterState } from '@/lib/library/filter'
import { LibraryView } from '@/components/library/library-view'

afterEach(cleanup)

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

/** The recipe cards, in the order they appear on screen. */
function cardTitles(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href')?.startsWith('/recipes/'))
    .map((link) => within(link).getByRole('heading').textContent ?? '')
}

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
    expect(screen.getByText('Showing 2 recipes')).toBeInTheDocument()
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
    expect(screen.getByText('Showing 0 of 2 recipes')).toBeInTheDocument()

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
