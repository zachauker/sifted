import { describe, it, expect, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe, updateUserFields, searchRecipes } from '@/lib/db/queries/recipes'
import { recipes } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
let recipeId: string

function extracted(over: Partial<ExtractedRecipe> = {}): ExtractedRecipe {
  return {
    title: 'Slow-Roast Gochujang Chicken',
    description: null,
    author: null,
    publisher: null,
    claimedTimeMinutes: 35,
    servings: null,
    yieldText: null,
    ingredients: [
      { position: 0, section: null, rawText: '1 Tbsp. gochujang', quantity: null, unit: null, item: null, note: null },
    ],
    steps: [{ position: 0, section: null, text: 'Roast low for three hours.' }],
    tags: [],
    heroImageUrl: null,
    narrativeHtml: null,
    extractionMethod: 'jsonld',
    ...over,
  }
}

async function row(id: string) {
  return db.select().from(recipes).where(eq(recipes.id, id)).get()
}

beforeEach(async () => {
  db = await createTestDb()
  recipeId = await upsertRecipe(db, {
    extracted: extracted(),
    sourceUrl: 'https://example.com/gochujang',
    sourceDomain: 'example.com',
  })
})

describe('updateUserFields', () => {
  it('updates the rating on its own', async () => {
    const after = await updateUserFields(db, recipeId, { rating: 5 })
    expect(after).toMatchObject({ rating: 5 })
    expect((await row(recipeId))?.rating).toBe(5)
  })

  it('updates the status on its own', async () => {
    await updateUserFields(db, recipeId, { status: 'made_it' })
    expect((await row(recipeId))?.status).toBe('made_it')
  })

  it('updates the notes on their own', async () => {
    await updateUserFields(db, recipeId, { notes: 'Halve the gochujang.' })
    expect((await row(recipeId))?.notes).toBe('Halve the gochujang.')
  })

  it('updates the measured time on its own', async () => {
    await updateUserFields(db, recipeId, { actualTimeMinutes: 70 })
    expect((await row(recipeId))?.actualTimeMinutes).toBe(70)
    // The publisher's claim is a different fact and must survive a
    // measurement being recorded beside it — the whole point of two columns.
    expect((await row(recipeId))?.claimedTimeMinutes).toBe(35)
  })

  it('leaves the other three alone on a partial update', async () => {
    await updateUserFields(db, recipeId, {
      rating: 4,
      status: 'made_it',
      notes: 'Needs more salt.',
      actualTimeMinutes: 70,
    })

    // The failure this guards against: a caller sending one key and the
    // query writing `null` into the three it never mentioned.
    await updateUserFields(db, recipeId, { rating: 5 })

    expect(await row(recipeId)).toMatchObject({
      rating: 5,
      status: 'made_it',
      notes: 'Needs more salt.',
      actualTimeMinutes: 70,
    })
  })

  it('distinguishes an explicit null from an absent key', async () => {
    await updateUserFields(db, recipeId, { rating: 5, status: 'made_it' })
    await updateUserFields(db, recipeId, { rating: null })

    expect(await row(recipeId)).toMatchObject({ rating: null, status: 'made_it' })
  })

  it('bumps updatedAt', async () => {
    const before = (await row(recipeId))!.updatedAt
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await updateUserFields(db, recipeId, { rating: 3 })
    expect((await row(recipeId))!.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('is a no-op, not a throw, for a recipe id that does not exist', async () => {
    await expect(updateUserFields(db, 'no-such-recipe', { rating: 5 })).resolves.toBeNull()
  })

  it('is a no-op for an empty patch', async () => {
    await updateUserFields(db, recipeId, { rating: 2 })
    const after = await updateUserFields(db, recipeId, {})
    expect(after).toMatchObject({ rating: 2 })
  })
})

/**
 * `upsertRecipe` writes an empty string into the FTS row's notes column,
 * because notes are user-owned and never arrive from extraction. This is the
 * only path that fills it, so the re-index has to happen here or a saved note
 * is unfindable forever.
 */
describe('updateUserFields and the search index', () => {
  it('makes a saved note findable through searchRecipes', async () => {
    expect(await searchRecipes(db, 'buttermilk')).toEqual([])

    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })

    expect(await searchRecipes(db, 'buttermilk')).toEqual([recipeId])
  })

  it('removes the old text from the index when the note is edited again', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })
    await updateUserFields(db, recipeId, { notes: 'Brine it in yoghurt overnight.' })

    // A stale FTS row is a silent wrong answer: a search hit that opens a
    // recipe which does not contain the term.
    expect(await searchRecipes(db, 'buttermilk')).toEqual([])
    expect(await searchRecipes(db, 'yoghurt')).toEqual([recipeId])
  })

  it('removes the note from the index when it is cleared to empty', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })
    await updateUserFields(db, recipeId, { notes: '' })

    expect(await searchRecipes(db, 'buttermilk')).toEqual([])
    expect((await row(recipeId))?.notes).toBeNull()
  })

  it('removes the note from the index when it is cleared to null', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })
    await updateUserFields(db, recipeId, { notes: null })

    expect(await searchRecipes(db, 'buttermilk')).toEqual([])
  })

  it('leaves the rest of the indexed text intact', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })

    expect(await searchRecipes(db, 'gochujang')).toEqual([recipeId])
    expect(await searchRecipes(db, 'roast')).toEqual([recipeId])
  })

  it('does not touch the index when notes are not part of the patch', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })
    await updateUserFields(db, recipeId, { rating: 5 })

    expect(await searchRecipes(db, 'buttermilk')).toEqual([recipeId])
  })

  it('survives a re-import: the note stays findable afterwards', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })
    expect(await searchRecipes(db, 'buttermilk')).toEqual([recipeId])

    // The documented repair for an unenriched recipe is a re-import, so this
    // is the path most likely to run over a recipe someone has annotated. The
    // note is user-authored and cannot be regenerated from the page, so
    // upsertRecipe carries it into the rewritten FTS row rather than blanking
    // it and leaving a note that is stored, displayed, and unfindable.
    await upsertRecipe(db, {
      extracted: extracted(),
      sourceUrl: 'https://example.com/gochujang',
      sourceDomain: 'example.com',
    })

    expect((await row(recipeId))?.notes).toBe('Brine it in buttermilk overnight.')
    expect(await searchRecipes(db, 'buttermilk')).toEqual([recipeId])
  })

  it('re-import leaves an un-annotated recipe with an empty FTS note', async () => {
    await upsertRecipe(db, {
      extracted: extracted(),
      sourceUrl: 'https://example.com/gochujang',
      sourceDomain: 'example.com',
    })
    expect((await row(recipeId))?.notes).toBeNull()
    expect(await searchRecipes(db, 'buttermilk')).toEqual([])
  })

  it('recovers when the recipe has no FTS row at all', async () => {
    // Every production path writes recipes through `upsertRecipe`, which always
    // inserts one. A row that got in some other way (a hand-run backfill, a
    // fixture) would otherwise make this function a silent no-op: `UPDATE …
    // WHERE recipe_id = ?` matching nothing succeeds, and the note is saved,
    // shown on the page, and unfindable forever.
    const [orphan] = await db
      .insert(recipes)
      .values({ title: 'Hand-Seeded Soup', slug: 'hand-seeded-soup', extractionMethod: 'manual' })
      .returning({ id: recipes.id })

    await updateUserFields(db, orphan.id, { notes: 'Brine it in buttermilk overnight.' })

    expect(await searchRecipes(db, 'buttermilk')).toEqual([orphan.id])
    expect(await searchRecipes(db, 'seeded')).toEqual([orphan.id])
  })

  it('does not leave a second FTS row behind', async () => {
    await updateUserFields(db, recipeId, { notes: 'Brine it in buttermilk overnight.' })
    await updateUserFields(db, recipeId, { notes: 'Brine it in yoghurt overnight.' })

    // A re-index implemented as a bare INSERT would double the row and make
    // every search return the recipe twice.
    const rows = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM recipes_fts WHERE recipe_id = ${recipeId}`,
    )
    expect(rows[0].n).toBe(1)
  })
})
