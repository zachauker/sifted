import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ExtractedRecipe } from '@/lib/extract/types'

/**
 * Real database, real `searchRecipes`, only `auth` mocked.
 *
 * `searchRecipes` (`src/lib/db/queries/recipes.ts`) is the one place that
 * sanitizes a search query before it reaches FTS5's `MATCH`. The plan for
 * this task is explicit that the route must not build a second query path,
 * and the only test that actually proves that is one that exercises the
 * real function through the real route — a test that mocks `searchRecipes`
 * would happily keep passing even if a future refactor moved the
 * sanitization into (or around) the route and broke it. So nothing here is
 * mocked except the session check, and the malformed-query case below is
 * this file's real job.
 */
const mocks = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))

// One real database for the whole file, built inside the factory because
// the route module captures `db` at import time — before any hook runs.
vi.mock('@/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db')
  return { db: await createTestDb() }
})

const { db } = await import('@/lib/db')
const { GET } = await import('@/app/api/search/route')
const { upsertRecipe } = await import('@/lib/db/queries/recipes')
const { buildLibraryIndex } = await import('@/lib/db/queries/library')
const { searchEntries } = await import('@/lib/library/search')

function recipe(over: Partial<ExtractedRecipe>): ExtractedRecipe {
  return {
    title: 'Untitled',
    description: null,
    author: null,
    publisher: null,
    claimedTimeMinutes: null,
    servings: null,
    yieldText: null,
    ingredients: [],
    steps: [],
    tags: [],
    heroImageUrl: null,
    narrativeHtml: null,
    extractionMethod: 'jsonld',
    ...over,
  }
}

function ing(position: number, rawText: string) {
  return { position, section: null, rawText, quantity: null, unit: null, item: null, note: null }
}

function step(position: number, text: string) {
  return { position, section: null, text }
}

function makeRequest(q?: string) {
  const url = new URL('https://app.example.com/api/search')
  if (q !== undefined) url.searchParams.set('q', q)
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
})

describe('GET /api/search', () => {
  it('returns 401 when the caller is anonymous', async () => {
    mocks.auth.mockResolvedValue(null)

    const res = await GET(makeRequest('chicken'))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('finds a recipe by a term that appears only in a step', async () => {
    const potatoes = await upsertRecipe(db, {
      extracted: recipe({
        title: 'Crispy Potatoes',
        ingredients: [ing(0, '1 kg Yukon Gold potatoes')],
        steps: [step(0, 'Parboil the potatoes, then deglaze the pan with vinegar.')],
      }),
      sourceUrl: 'https://example.com/potatoes',
      sourceDomain: 'example.com',
    })

    const res = await GET(makeRequest('deglaze'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ids: [potatoes] })
  })

  it('returns an empty ids array, not a 500, for a malformed query', async () => {
    for (const q of ['(', 'AND', '"', 'NEAR(']) {
      const res = await GET(makeRequest(q))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ids: [] })
    }
  })

  it('returns an empty ids array for a missing query param', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ids: [] })
  })

  /**
   * The self-review probe from the task: index a recipe whose title carries
   * a diacritic, search "saute" through both tiers, and confirm they agree.
   * Tier 1 (`searchEntries`) folds accents client-side; tier 2 goes through
   * FTS5's `unicode61` tokenizer, which folds them server-side. If these
   * ever disagreed, the app would feel broken depending on which control
   * the reader happened to use.
   */
  it('agrees with the local tier on accent folding', async () => {
    const sauteed = await upsertRecipe(db, {
      extracted: recipe({
        title: 'Sautéed Shrimp',
        ingredients: [ing(0, '1 lb shrimp')],
        steps: [step(0, 'Sauté until pink.')],
      }),
      sourceUrl: 'https://example.com/sauteed-shrimp',
      sourceDomain: 'example.com',
    })

    const entries = await buildLibraryIndex(db)
    const local = searchEntries(entries, 'saute').map((e) => e.id)

    const res = await GET(makeRequest('saute'))
    const { ids: server } = (await res.json()) as { ids: string[] }

    // Both tiers' actual answers belong in the report, not just pass/fail.
    console.log(`two-tier accent agreement for "saute": local=${JSON.stringify(local)} server=${JSON.stringify(server)} target=${sauteed}`)

    expect(local).toContain(sauteed)
    expect(server).toContain(sauteed)
  })
})
