import { describe, it, expect, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe } from '@/lib/db/queries/recipes'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

const extracted: ExtractedRecipe = {
  title: 'Slow-Roast Gochujang Chicken',
  description: 'A melt-in-your-mouth roast.',
  author: 'Molly Baz',
  publisher: 'Bon Appétit',
  claimedTimeMinutes: 180,
  servings: 4,
  yieldText: '4 servings',
  ingredients: [
    { position: 0, section: null, rawText: '1 Tbsp. gochujang', quantity: 1, unit: 'tablespoon', item: 'gochujang', note: null },
    { position: 1, section: null, rawText: '4 chicken thighs', quantity: 4, unit: null, item: 'chicken thighs', note: null },
  ],
  steps: [{ position: 0, section: null, text: 'Roast low and slow.' }],
  tags: [{ facet: 'course', value: 'main' }, { facet: 'ingredient', value: 'chicken' }],
  heroImageUrl: 'https://example.com/hero.jpg',
  narrativeHtml: '<p>This is not the crisp-skinned roast chicken you know.</p>',
  extractionMethod: 'jsonld',
}

describe('upsertRecipe', () => {
  it('writes the recipe and all its children', async () => {
    const id = await upsertRecipe(db, {
      extracted, sourceUrl: 'https://bonappetit.com/recipe/gochujang',
      sourceDomain: 'bonappetit.com', enrichmentApplied: true,
    })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.title).toBe('Slow-Roast Gochujang Chicken')
    expect(row.slug).toContain('slow-roast-gochujang-chicken')
    expect(row.claimedTimeMinutes).toBe(180)
    expect(row.enrichmentApplied).toBe(true)

    expect(await db.select().from(ingredients).where(eq(ingredients.recipeId, id))).toHaveLength(2)
    expect(await db.select().from(steps).where(eq(steps.recipeId, id))).toHaveLength(1)
    expect(await db.select().from(recipeTags).where(eq(recipeTags.recipeId, id))).toHaveLength(2)
  })

  it('stores fractional quantities without truncating them', async () => {
    const fractional: ExtractedRecipe = {
      ...extracted,
      ingredients: [{
        position: 0, section: null, rawText: '1 ½ cups all-purpose flour, sifted',
        quantity: 1.5, unit: 'cup', item: 'all-purpose flour', note: 'sifted',
      }],
    }
    const id = await upsertRecipe(db, {
      extracted: fractional, sourceUrl: 'https://x.com/frac', sourceDomain: 'x.com',
    })
    const [row] = await db.select().from(ingredients).where(eq(ingredients.recipeId, id))
    expect(row.quantity).toBe(1.5)
  })

  it('preserves ingredient rawText verbatim', async () => {
    const id = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/a', sourceDomain: 'x.com' })
    const rows = await db.select().from(ingredients).where(eq(ingredients.recipeId, id))
    expect(rows.map((r) => r.rawText).sort()).toEqual(['1 Tbsp. gochujang', '4 chicken thighs'])
  })

  it('indexes the recipe for full-text search', async () => {
    const id = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/b', sourceDomain: 'x.com' })
    const hits = await db.all<{ recipe_id: string }>(
      sql`SELECT recipe_id FROM recipes_fts WHERE recipes_fts MATCH 'gochujang'`,
    )
    expect(hits.map((h) => h.recipe_id)).toEqual([id])
  })

  it('replaces children on re-import rather than duplicating them', async () => {
    const url = 'https://x.com/c'
    const first = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const revised: ExtractedRecipe = {
      ...extracted,
      title: 'Slow-Roast Gochujang Chicken (updated)',
      ingredients: [{ position: 0, section: null, rawText: '2 Tbsp. gochujang', quantity: 2, unit: 'tablespoon', item: 'gochujang', note: null }],
    }
    const second = await upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' })

    expect(second).toBe(first)
    expect(await db.select().from(recipes)).toHaveLength(1)
    const rows = await db.select().from(ingredients).where(eq(ingredients.recipeId, first))
    expect(rows).toHaveLength(1)
    expect(rows[0].rawText).toBe('2 Tbsp. gochujang')
  })

  it('does not leave a stale FTS row after a re-import', async () => {
    const url = 'https://x.com/fts'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    // The title has to change too. `extracted.title` is "Slow-Roast Gochujang
    // Chicken", and the title is indexed — so leaving it in place would keep
    // 'gochujang' matching for an entirely legitimate reason, and the only
    // implementation that could pass would be one that never indexed titles.
    const revised: ExtractedRecipe = {
      ...extracted,
      title: 'Slow-Roast Harissa Chicken',
      ingredients: [{ position: 0, section: null, rawText: '1 Tbsp. harissa', quantity: 1, unit: 'tablespoon', item: 'harissa', note: null }],
    }
    await upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' })

    const gone = await db.all(sql`SELECT recipe_id FROM recipes_fts WHERE recipes_fts MATCH 'gochujang'`)
    const found = await db.all<{ recipe_id: string }>(sql`SELECT recipe_id FROM recipes_fts WHERE recipes_fts MATCH 'harissa'`)
    expect(gone).toHaveLength(0)
    expect(found.map((f) => f.recipe_id)).toEqual([id])
  })

  it('keeps user-owned fields across a re-import', async () => {
    const url = 'https://x.com/d'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })
    await db.update(recipes)
      .set({ rating: 5, status: 'made_it', notes: 'Needed more flour.', actualTimeMinutes: 70 })
      .where(eq(recipes.id, id))

    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.rating).toBe(5)
    expect(row.status).toBe('made_it')
    expect(row.notes).toBe('Needed more flour.')
    expect(row.actualTimeMinutes).toBe(70)
  })

  it('does not leave a partial recipe behind when a child insert fails', async () => {
    const broken: ExtractedRecipe = {
      ...extracted,
      ingredients: [
        { position: 0, section: null, rawText: 'a', quantity: null, unit: null, item: null, note: null },
        { position: 0, section: null, rawText: 'b', quantity: null, unit: null, item: null, note: null },
      ],
    }
    await expect(
      upsertRecipe(db, { extracted: broken, sourceUrl: 'https://x.com/e', sourceDomain: 'x.com' }),
    ).rejects.toThrow()
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('generates distinct slugs for two recipes with the same title', async () => {
    const a = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/f', sourceDomain: 'x.com' })
    const b = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/g', sourceDomain: 'x.com' })
    const rows = await db.select().from(recipes)
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2)
    expect(a).not.toBe(b)
  })

  it('accepts a recipe with no source url', async () => {
    const id = await upsertRecipe(db, { extracted, sourceUrl: null, sourceDomain: null })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.sourceUrl).toBeNull()
  })

  it('accepts a historical creation date for migrated recipes', async () => {
    const createdAt = new Date('2019-11-09T15:04:05.000Z')
    const id = await upsertRecipe(db, {
      extracted, sourceUrl: 'https://x.com/old', sourceDomain: 'x.com', createdAt,
    })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.createdAt.toISOString()).toBe(createdAt.toISOString())
  })

  it('does not move createdAt on a later re-import', async () => {
    const createdAt = new Date('2019-11-09T15:04:05.000Z')
    const url = 'https://x.com/old2'
    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com', createdAt })
    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const [row] = await db.select().from(recipes).where(eq(recipes.sourceUrl, url))
    expect(row.createdAt.toISOString()).toBe(createdAt.toISOString())
  })

  it('still defaults createdAt to now when none is supplied', async () => {
    const before = Date.now()
    const id = await upsertRecipe(db, {
      extracted, sourceUrl: 'https://x.com/new', sourceDomain: 'x.com',
    })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })
})
