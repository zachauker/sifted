import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe, applyNotionMetadata } from '@/lib/db/queries/recipes'
import { recipes, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
let recipeId: string

const extracted: ExtractedRecipe = {
  title: 'Homemade Flatbread', description: null, author: null, publisher: null,
  claimedTimeMinutes: null, servings: null, yieldText: null,
  ingredients: [{ position: 0, section: null, rawText: '3 cups flour', quantity: null, unit: null, item: null, note: null }],
  steps: [{ position: 0, section: null, text: 'Knead.' }],
  tags: [{ facet: 'course', value: 'bread' }],
  heroImageUrl: null, narrativeHtml: null, extractionMethod: 'jsonld',
}

beforeEach(async () => {
  db = await createTestDb()
  recipeId = await upsertRecipe(db, {
    extracted, sourceUrl: 'https://example.com/flatbread', sourceDomain: 'example.com',
  })
})

const tagsOf = async () =>
  (await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)))
    .map((t) => `${t.facet}:${t.value}`).sort()

describe('applyNotionMetadata', () => {
  it('sets the rating and status', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 5, status: 'made_it', tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(5)
    expect(row.status).toBe('made_it')
  })

  it('adds Notion tags to what extraction already found rather than replacing them', async () => {
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'ingredient', value: 'chicken' }],
    })
    expect(await tagsOf()).toEqual(['course:bread', 'ingredient:chicken'])
  })

  it('does not duplicate a tag extraction already produced', async () => {
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'course', value: 'bread' }],
    })
    expect(await tagsOf()).toEqual(['course:bread'])
  })

  it('leaves a null rating and status as null rather than writing zeros', async () => {
    await applyNotionMetadata(db, recipeId, { rating: null, status: null, tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBeNull()
    expect(row.status).toBeNull()
  })

  it('is idempotent, because a resumed migration will run it twice', async () => {
    const input = { rating: 4, status: 'want_to_make' as const, tags: [{ facet: 'method' as const, value: 'oven' }] }
    await applyNotionMetadata(db, recipeId, input)
    await expect(applyNotionMetadata(db, recipeId, input)).resolves.not.toThrow()

    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(4)
    expect(await tagsOf()).toEqual(['course:bread', 'method:oven'])
  })

  it('does not disturb the recipe a re-import would preserve', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 3, status: 'made_it', tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.title).toBe('Homemade Flatbread')
    expect(row.notes).toBeNull()
  })
})
