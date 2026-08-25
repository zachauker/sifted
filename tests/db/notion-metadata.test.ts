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

  it('stamps the tags it writes as notion-owned', async () => {
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'cuisine', value: 'italian' }],
    })
    const rows = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId))
    expect(rows.find((t) => t.value === 'italian')?.source).toBe('notion')
  })

  // Extraction and Notion agreeing on `course:bread` is not a conflict about
  // the tag — both want it present — it is a question of who owns it, and the
  // unique constraint means only one row can answer. Ownership escalates to
  // Notion: the tag is one the user curated by hand, and leaving it stamped
  // `extracted` would put it back in the path of the very re-import this whole
  // change exists to survive. Escalation only ever moves up the ladder
  // (extracted -> notion -> user); nothing here can demote a `user` tag.
  it('takes ownership of a tag extraction already produced rather than leaving it extracted', async () => {
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'course', value: 'bread' }],
    })

    const rows = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId))
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('notion')

    // And the point of all that: the repair procedure no longer eats it.
    await upsertRecipe(db, {
      extracted: { ...extracted, tags: [] },
      sourceUrl: 'https://example.com/flatbread', sourceDomain: 'example.com',
    })
    expect(await tagsOf()).toEqual(['course:bread'])
  })

  it('never demotes a user-owned tag it happens to duplicate', async () => {
    await db.insert(recipeTags)
      .values({ recipeId, facet: 'tag', value: 'weeknight', source: 'user' })
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'tag', value: 'weeknight' }],
    })
    const rows = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId))
    expect(rows.find((t) => t.value === 'weeknight')?.source).toBe('user')
  })

  /* ---------------------------------------------------------------------- */
  /* Null means "Notion had nothing here", not "clear what you have"          */
  /* ---------------------------------------------------------------------- */

  // Two Notion rows whose links canonicalize to the same URL land on the same
  // recipe. The second row carries no rating, and a plain `.set()` let it
  // erase the rating the first row supplied — one of the three fields that
  // only ever existed in Notion and cannot be recovered from anywhere else.
  it('does not clear an existing rating when the incoming rating is null', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 5, status: 'made_it', tags: [] })
    await applyNotionMetadata(db, recipeId, { rating: null, status: null, tags: [] })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(5)
    expect(row.status).toBe('made_it')
  })

  it('does not clear an existing status when only the status is null', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 5, status: 'made_it', tags: [] })
    await applyNotionMetadata(db, recipeId, { rating: 3, status: null, tags: [] })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(3)
    expect(row.status).toBe('made_it')
  })

  it('still sets a rating and status on a recipe that has none', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 4, status: 'want_to_make', tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(4)
    expect(row.status).toBe('want_to_make')
  })

  it('still overwrites an existing rating and status with real incoming values', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 2, status: 'want_to_make', tags: [] })
    await applyNotionMetadata(db, recipeId, { rating: 5, status: 'made_it', tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(5)
    expect(row.status).toBe('made_it')
  })

  it('does not disturb the recipe a re-import would preserve', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 3, status: 'made_it', tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.title).toBe('Homemade Flatbread')
    expect(row.notes).toBeNull()
  })
})
