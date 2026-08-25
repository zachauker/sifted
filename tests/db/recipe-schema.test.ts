import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { recipes, ingredients, steps, recipeTags, importJobs } from '@/lib/db/schema'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

async function insertRecipe(overrides: Record<string, unknown> = {}) {
  const [row] = await db.insert(recipes).values({
    title: 'Egg Korma', slug: 'egg-korma',
    sourceUrl: 'https://example.com/korma', sourceDomain: 'example.com',
    extractionMethod: 'jsonld', ...overrides,
  }).returning()
  return row
}

describe('recipes', () => {
  it('enforces one row per canonical source url', async () => {
    await insertRecipe()
    await expect(insertRecipe({ slug: 'egg-korma-2' })).rejects.toThrow()
  })

  it('allows many recipes with no source url', async () => {
    await insertRecipe({ sourceUrl: null })
    await insertRecipe({ sourceUrl: null, slug: 'other' })
    expect(await db.select().from(recipes)).toHaveLength(2)
  })

  it('defaults enrichmentApplied to false', async () => {
    expect((await insertRecipe()).enrichmentApplied).toBe(false)
  })

  it('stores a fractional ingredient quantity without truncating', async () => {
    const recipe = await insertRecipe()
    await db.insert(ingredients).values({
      recipeId: recipe.id, position: 0, rawText: '1 1/2 cups flour', quantity: 1.5,
    })
    const [row] = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipe.id))
    expect(row.quantity).toBe(1.5)
  })
})

describe('child rows', () => {
  it('cascades deletes to ingredients, steps, and tags', async () => {
    const recipe = await insertRecipe()
    await db.insert(ingredients).values({ recipeId: recipe.id, position: 0, rawText: '2 eggs' })
    await db.insert(steps).values({ recipeId: recipe.id, position: 0, text: 'Boil.' })
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' })

    await db.delete(recipes).where(eq(recipes.id, recipe.id))

    expect(await db.select().from(ingredients)).toHaveLength(0)
    expect(await db.select().from(steps)).toHaveLength(0)
    expect(await db.select().from(recipeTags)).toHaveLength(0)
  })

  it('rejects two ingredients at the same position', async () => {
    const recipe = await insertRecipe()
    await db.insert(ingredients).values({ recipeId: recipe.id, position: 0, rawText: 'a' })
    await expect(
      db.insert(ingredients).values({ recipeId: recipe.id, position: 0, rawText: 'b' }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate facet/value on one recipe', async () => {
    const recipe = await insertRecipe()
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' })
    await expect(
      db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' }),
    ).rejects.toThrow()
  })

  it('allows two courses on one recipe', async () => {
    const recipe = await insertRecipe()
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' })
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'side' })
    expect(await db.select().from(recipeTags)).toHaveLength(2)
  })
})

describe('import_jobs', () => {
  it('starts queued with no failure kind', async () => {
    const [job] = await db.insert(importJobs)
      .values({ url: 'https://example.com/x' }).returning()
    expect(job.status).toBe('queued')
    expect(job.failureKind).toBeNull()
    expect(job.finishedAt).toBeNull()
  })
})
