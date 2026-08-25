import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { listUnenrichedRecipes, upsertRecipe } from '@/lib/db/queries/recipes'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

/**
 * An extraction with the model's contribution: parsed quantities, units, items
 * and tags.
 */
const enriched: ExtractedRecipe = {
  title: 'Slow-Roast Gochujang Chicken',
  description: 'A melt-in-your-mouth roast.',
  author: 'Molly Baz',
  publisher: 'Bon Appétit',
  claimedTimeMinutes: 180,
  servings: 4,
  yieldText: '4 servings',
  ingredients: [
    {
      position: 0, section: null, rawText: '1 Tbsp. gochujang',
      quantity: 1, unit: 'tablespoon', item: 'gochujang', note: null,
    },
  ],
  steps: [{ position: 0, section: null, text: 'Roast low and slow.' }],
  tags: [{ facet: 'course', value: 'main' }],
  heroImageUrl: null,
  narrativeHtml: null,
  extractionMethod: 'jsonld',
}

/**
 * What the pipeline stores when `llm.enrich` rejected: the raw lines survive
 * intact, every parsed column is null, and there are no tags at all. This
 * recipe reads fine on its own page and is invisible to every facet in the
 * filter rail — which is the failure the flag exists to make findable.
 */
const unenriched: ExtractedRecipe = {
  ...enriched,
  title: 'Weeknight Gochujang Noodles',
  ingredients: [
    {
      position: 0, section: null, rawText: '2 Tbsp. gochujang',
      quantity: null, unit: null, item: null, note: null,
    },
  ],
  tags: [],
}

function store(extracted: ExtractedRecipe, sourceUrl: string | null, applied: boolean) {
  return upsertRecipe(db, {
    extracted,
    sourceUrl,
    sourceDomain: sourceUrl ? new URL(sourceUrl).hostname : null,
    enrichmentApplied: applied,
  })
}

describe('listUnenrichedRecipes', () => {
  it('returns an empty array for an empty library', async () => {
    expect(await listUnenrichedRecipes(db)).toEqual([])
  })

  it('returns an empty array when every recipe is enriched', async () => {
    await store(enriched, 'https://bonappetit.com/a', true)
    await store(enriched, 'https://bonappetit.com/b', true)

    expect(await listUnenrichedRecipes(db)).toEqual([])
  })

  it('returns only the unenriched recipes, with what a repair needs', async () => {
    await store(enriched, 'https://bonappetit.com/roast', true)
    const stranded = await store(unenriched, 'https://example.com/noodles', false)
    await store(enriched, 'https://bonappetit.com/other', true)

    const rows = await listUnenrichedRecipes(db)
    expect(rows).toEqual([
      {
        id: stranded,
        title: 'Weeknight Gochujang Noodles',
        // The repair is "retry this import", so the source URL is the whole
        // point of the query returning anything beyond an id.
        sourceUrl: 'https://example.com/noodles',
      },
    ])
  })

  it('includes a recipe with no source URL, so the unrepairable ones are visible too', async () => {
    // The handful imported from Notion have no source at all. They can never be
    // repaired by re-importing, and answering "why is this one still on the
    // list" is worth more than hiding it.
    const id = await store({ ...unenriched, title: 'Mum’s Chilli' }, null, false)

    const rows = await listUnenrichedRecipes(db)
    expect(rows).toEqual([{ id, title: 'Mum’s Chilli', sourceUrl: null }])
  })

  it('defaults to unenriched when the caller says nothing, matching the column default', async () => {
    // `enrichmentApplied` is optional on `UpsertInput` and defaults to false.
    // A caller that forgets it must show up here rather than silently pass as
    // enriched — false is the safe direction for a flag whose whole job is to
    // surface missing data.
    const id = await upsertRecipe(db, {
      extracted: unenriched,
      sourceUrl: 'https://example.com/forgot',
      sourceDomain: 'example.com',
    })

    expect((await listUnenrichedRecipes(db)).map((r) => r.id)).toEqual([id])
  })
})
