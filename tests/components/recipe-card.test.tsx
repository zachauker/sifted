// @vitest-environment jsdom
//
// jsdom, opted into per file the way `tests/components/library-grid.test.tsx`
// does — see the note in `vitest.config.mts` for why there is no second
// Vitest project.
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { RecipeCard } from '@/components/library/recipe-card'

afterEach(cleanup)

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
 * Reproduced at runtime before this fix: a stored rating of `-1` made
 * `GET /` return HTTP 500, because `recipe-card.tsx` called
 * `'★'.repeat(entry.rating)` directly, and `String.prototype.repeat` throws
 * `RangeError` on a negative count. A rating this far outside 0–5 can only
 * come from a row the write-side clamp in `applyNotionMetadata` never
 * touched — a pre-existing row, or one edited directly in the database — so
 * the card has to survive it independent of anything upstream.
 */
describe('RecipeCard: rating', () => {
  it('does not throw on a negative rating, and clamps it to 0 (no stars)', () => {
    expect(() => render(<RecipeCard entry={entry({ rating: -1 })} />)).not.toThrow()
    expect(screen.getByText('0 stars')).toBeInTheDocument()
  })

  it('rounds a fractional rating so the star glyphs match the screen-reader text', () => {
    render(<RecipeCard entry={entry({ rating: 4.5 })} />)
    expect(screen.getByText('5 stars')).toBeInTheDocument()
    expect(screen.getByText('★★★★★')).toBeInTheDocument()
  })

  it('clamps a rating above 5 down to 5 stars', () => {
    render(<RecipeCard entry={entry({ rating: 7 })} />)
    expect(screen.getByText('5 stars')).toBeInTheDocument()
    expect(screen.getByText('★★★★★')).toBeInTheDocument()
  })

  it('renders a normal 1-5 rating unchanged', () => {
    render(<RecipeCard entry={entry({ rating: 3 })} />)
    expect(screen.getByText('3 stars')).toBeInTheDocument()
    expect(screen.getByText('★★★')).toBeInTheDocument()
  })

  it('uses the singular for exactly 1 star', () => {
    render(<RecipeCard entry={entry({ rating: 1 })} />)
    expect(screen.getByText('1 star')).toBeInTheDocument()
  })

  it('renders no rating markup at all when the rating is null', () => {
    render(<RecipeCard entry={entry({ rating: null, publisher: 'Example Kitchen' })} />)
    expect(screen.queryByText(/stars?$/)).not.toBeInTheDocument()
  })
})
