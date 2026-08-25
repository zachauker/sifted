import { describe, it, expect } from 'vitest'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { searchEntries } from '@/lib/library/search'

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

describe('searchEntries', () => {
  it('matches an exact title', () => {
    const salmon = entry({ title: 'Miso Butter Salmon' })
    const result = searchEntries([salmon, entry({ title: 'Chana Masala' })], 'Miso Butter Salmon')
    expect(result).toEqual([salmon])
  })

  it('matches a partial word in the title', () => {
    const salmon = entry({ title: 'Miso Butter Salmon' })
    const result = searchEntries([salmon, entry({ title: 'Chana Masala' })], 'salmon')
    expect(result).toEqual([salmon])
  })

  it('matches a publisher', () => {
    const bonAppetit = entry({ title: 'Sunday Ragù', publisher: 'Bon Appétit' })
    const result = searchEntries(
      [bonAppetit, entry({ title: 'Chana Masala', publisher: 'Serious Eats' })],
      'bon appetit',
    )
    expect(result).toEqual([bonAppetit])
  })

  it('matches a tag', () => {
    const seafood = entry({ title: 'Miso Butter Salmon', tags: ['ingredient:seafood', 'course:main'] })
    const result = searchEntries(
      [seafood, entry({ title: 'Chana Masala', tags: ['course:main'] })],
      'seafood',
    )
    expect(result).toEqual([seafood])
  })

  it('is case-insensitive', () => {
    const salmon = entry({ title: 'Miso Butter Salmon' })
    expect(searchEntries([salmon], 'MISO butter SALMON')).toEqual([salmon])
  })

  /**
   * FTS5's `unicode61` tokenizer already folds diacritics on the server
   * side (see `tests/db/search.test.ts`'s "folds diacritics" case), so the
   * client has to fold the same way or the two tiers disagree about what
   * "saute" finds. Tested in both directions: an unaccented query against
   * an accented title, and an accented query against an unaccented title.
   */
  it('folds accents in both directions', () => {
    const sauteed = entry({ title: 'Sautéed Shrimp' })
    expect(searchEntries([sauteed], 'saute')).toEqual([sauteed])

    const sauteedNoAccent = entry({ title: 'Sauteed Shrimp' })
    expect(searchEntries([sauteedNoAccent], 'sauté')).toEqual([sauteedNoAccent])
  })

  it('returns everything for an empty query', () => {
    const entries = [entry(), entry(), entry()]
    expect(searchEntries(entries, '')).toEqual(entries)
  })

  it('returns everything for a whitespace-only query', () => {
    const entries = [entry(), entry(), entry()]
    expect(searchEntries(entries, '   ')).toEqual(entries)
  })

  it('returns an empty array when nothing matches', () => {
    const entries = [entry({ title: 'Miso Butter Salmon' }), entry({ title: 'Chana Masala' })]
    expect(searchEntries(entries, 'gochujang')).toEqual([])
  })

  it('treats a leading/trailing space or doubled internal spaces the same as a clean query', () => {
    const rice = entry({ title: 'Chicken with Rice' })
    expect(searchEntries([rice], '  chicken rice  ')).toEqual([rice])
    expect(searchEntries([rice], 'chicken   rice')).toEqual([rice])
  })

  it('ANDs multiple terms, same as the server tier', () => {
    const rice = entry({ title: 'Chicken with Rice' })
    const soup = entry({ title: 'Chicken Noodle Soup' })
    expect(searchEntries([rice, soup], 'chicken rice')).toEqual([rice])
  })

  /**
   * A rough measure of tier 1's per-keystroke cost at the library's real
   * size. The whole design rests on this staying effectively free — see
   * `tests/db/library-index.test.ts` for the payload-size half of the same
   * argument.
   */
  it('stays fast over a realistic 156-entry library', () => {
    const entries: LibraryEntry[] = []
    for (let i = 0; i < 156; i++) {
      entries.push(
        entry({
          title: `Recipe Title Number ${i} With Some Real Words In It`,
          publisher: 'Bon Appétit',
          tags: ['course:main', 'ingredient:seafood', 'method:oven', 'cuisine:italian'],
        }),
      )
    }

    const start = performance.now()
    for (let i = 0; i < 20; i++) searchEntries(entries, 'seafood oven')
    const elapsedMs = (performance.now() - start) / 20

    // Measured numbers belong in the report, not just pass/fail.
    console.log(`local search: ${elapsedMs.toFixed(3)}ms per call over 156 entries`)
    expect(elapsedMs).toBeLessThan(5)
  })
})
