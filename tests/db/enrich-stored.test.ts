import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { enrichStoredRecipe, upsertRecipe } from '@/lib/db/queries/recipes'
import { recipes, ingredients, recipeTags, steps } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

/**
 * A recipe as it lands when it was recovered from a Notion page body and the
 * model call was never made: real content, no tags, no parsed quantities.
 */
const unenriched: ExtractedRecipe = {
  title: 'Ham Pot Pie',
  description: null,
  author: null,
  publisher: null,
  claimedTimeMinutes: null,
  servings: null,
  yieldText: null,
  ingredients: [
    { position: 0, section: null, rawText: '2 cups diced ham', quantity: null, unit: null, item: null, note: null },
    { position: 1, section: null, rawText: 'salt to taste', quantity: null, unit: null, item: null, note: null },
  ],
  steps: [{ position: 0, section: null, text: 'Simmer until thick.' }],
  tags: [],
  heroImageUrl: null,
  narrativeHtml: '<p>Grandma made this.</p>',
  extractionMethod: 'notion',
}

async function store() {
  return upsertRecipe(db, {
    extracted: unenriched,
    sourceUrl: 'https://example.com/ham-pot-pie',
    sourceDomain: 'example.com',
    enrichmentApplied: false,
  })
}

const enrichment = {
  tags: [
    { facet: 'course', value: 'main' },
    { facet: 'ingredient', value: 'pork' },
  ] as const,
  ingredients: [
    { position: 0, quantity: 2, unit: 'cup', item: 'ham', note: 'diced' },
    { position: 1, quantity: null, unit: null, item: 'salt', note: 'to taste' },
  ],
}

describe('enrichStoredRecipe', () => {
  it('fills in tags and parsed quantities without a page', async () => {
    const id = await store()
    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })

    const tags = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, id))
    expect(tags.map((t) => `${t.facet}:${t.value}`).sort()).toEqual(['course:main', 'ingredient:pork'])

    const lines = await db.select().from(ingredients).where(eq(ingredients.recipeId, id)).orderBy(ingredients.position)
    expect(lines[0].quantity).toBe(2)
    expect(lines[0].unit).toBe('cup')
    expect(lines[1].quantity).toBeNull()
    expect(lines[1].item).toBe('salt')
  })

  it('never rewrites rawText, so a bad parse cannot lose the source line', async () => {
    const id = await store()
    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })

    const lines = await db.select().from(ingredients).where(eq(ingredients.recipeId, id)).orderBy(ingredients.position)
    expect(lines.map((l) => l.rawText)).toEqual(['2 cups diced ham', 'salt to taste'])
  })

  it('leaves steps and narrative alone', async () => {
    const id = await store()
    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })

    const rows = await db.select().from(steps).where(eq(steps.recipeId, id))
    expect(rows.map((s) => s.text)).toEqual(['Simmer until thick.'])
    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.narrativeHtml).toContain('Grandma made this.')
  })

  it('keeps Notion and user tags, which extraction can never reproduce', async () => {
    const id = await store()
    await db.insert(recipeTags).values([
      { recipeId: id, facet: 'tag', value: 'family-recipe', source: 'notion' },
      { recipeId: id, facet: 'method', value: 'oven', source: 'user' },
    ])

    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })

    const kept = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, id))
    expect(kept.map((t) => `${t.source}:${t.facet}:${t.value}`).sort()).toEqual([
      'extracted:course:main',
      'extracted:ingredient:pork',
      'notion:tag:family-recipe',
      'user:method:oven',
    ])
  })

  it('marks the recipe enriched so it drops out of the unenriched list', async () => {
    const id = await store()
    const [before] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(before.enrichmentApplied).toBe(false)

    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })

    const [after] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(after.enrichmentApplied).toBe(true)
  })

  it('is safe to run twice', async () => {
    const id = await store()
    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })
    await enrichStoredRecipe(db, id, { ...enrichment, tags: [...enrichment.tags] })

    const tags = await db.select().from(recipeTags)
      .where(and(eq(recipeTags.recipeId, id), eq(recipeTags.source, 'extracted')))
    expect(tags).toHaveLength(2)
  })
})
