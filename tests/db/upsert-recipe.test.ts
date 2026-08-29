import { describe, it, expect, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe, applyNotionMetadata } from '@/lib/db/queries/recipes'
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

const tagsOf = async (recipeId: string) =>
  (await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)))
    .map((t) => `${t.facet}:${t.value}`).sort()

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

  /* ---------------------------------------------------------------------- */
  /* Tag ownership                                                            */
  /* ---------------------------------------------------------------------- */

  it('replaces its own extracted tags, including dropping one the new extraction no longer produces', async () => {
    const url = 'https://x.com/tags-extracted'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const revised: ExtractedRecipe = {
      ...extracted,
      tags: [{ facet: 'course', value: 'main' }, { facet: 'method', value: 'oven' }],
    }
    await upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' })

    expect(await tagsOf(id)).toEqual(['course:main', 'method:oven'])
  })

  it('leaves Notion-owned tags untouched when a re-import replaces the extracted ones', async () => {
    const url = 'https://x.com/tags-notion'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })
    await applyNotionMetadata(db, id, {
      rating: null, status: null,
      tags: [{ facet: 'cuisine', value: 'korean' }, { facet: 'tag', value: 'weeknight' }],
    })

    const revised: ExtractedRecipe = { ...extracted, tags: [{ facet: 'method', value: 'oven' }] }
    await upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' })

    // The extracted pair is gone and replaced; the two tags that came out of
    // seven years of Notion curation are still here. They cannot be
    // regenerated from the page, so a re-extraction has no business deleting
    // them.
    expect(await tagsOf(id)).toEqual(['cuisine:korean', 'method:oven', 'tag:weeknight'])
  })

  it('leaves user-owned tags untouched when a re-import replaces the extracted ones', async () => {
    const url = 'https://x.com/tags-user'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })
    // Nothing writes `source: 'user'` yet — the tag editor lands in a later
    // plan. The guard is written now because the bug it prevents is the same
    // one that ate the Notion tags, and it is cheaper to hold the line than to
    // re-lose the data.
    await db.insert(recipeTags).values({ recipeId: id, facet: 'tag', value: 'kid-approved', source: 'user' })

    const revised: ExtractedRecipe = { ...extracted, tags: [{ facet: 'method', value: 'oven' }] }
    await upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' })

    expect(await tagsOf(id)).toEqual(['method:oven', 'tag:kid-approved'])
  })

  it('stamps the tags it writes as extracted', async () => {
    const id = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/tags-src', sourceDomain: 'x.com' })
    const rows = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, id))
    expect(rows.map((r) => r.source)).toEqual(['extracted', 'extracted'])
  })

  it('does not fail when the new extraction produces a tag a human already owns', async () => {
    const url = 'https://x.com/tags-collide'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })
    await db.insert(recipeTags).values({ recipeId: id, facet: 'method', value: 'oven', source: 'user' })

    // `(recipe_id, facet, value)` is unique across sources, so re-inserting an
    // extracted `method:oven` on top of the user's must not raise — and must
    // not demote the user's row to `extracted`, which would put it right back
    // in the path of the next re-import.
    const revised: ExtractedRecipe = { ...extracted, tags: [{ facet: 'method', value: 'oven' }] }
    await expect(
      upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' }),
    ).resolves.toBe(id)

    const rows = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, id))
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('user')
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

  it('does not clear handEdited on a re-import', async () => {
    // The whole "mark, then warn" design rests on this flag surviving a
    // re-import: `updateRecipeContent` sets `handEdited`, and a later warning
    // reads it before a re-import replaces a hand-edited recipe's content.
    // `sourceFields` sits directly above `hand_edited` in the schema and its
    // comment reads "everything here is by definition a better read of the
    // same source" — a contributor adding `handEdited: false` to it would be
    // reasoning plausibly, and would silently disarm the warning for every
    // recipe in the library.
    const url = 'https://x.com/hand-edited'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })
    await db.update(recipes).set({ handEdited: true }).where(eq(recipes.id, id))

    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.handEdited).toBe(true)
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

/**
 * Notion's `Rating` is a free number property, so nothing upstream of
 * `applyNotionMetadata` stops a negative, fractional, or out-of-range value
 * from arriving here. Reproduced at runtime: a stored rating of `-1` made
 * `'★'.repeat(entry.rating)` throw `RangeError: Invalid count value: -1` on
 * the home page. `applyNotionMetadata` is the write path these never went
 * through validation on (`PATCH /api/recipes/[id]` already clamps with
 * `z.number().int().min(0).max(5)`), so it is fixed here, coercing rather
 * than rejecting — see the comment on `coerceRating` in
 * `src/lib/db/queries/recipes.ts` for why losing a genuine rating is worse
 * than clamping one.
 */
describe('applyNotionMetadata: rating coercion', () => {
  const insertBare = async () =>
    upsertRecipe(db, { extracted, sourceUrl: `https://x.com/rating-${createId()}`, sourceDomain: 'x.com' })

  it('clamps a negative rating to 0 rather than storing it raw', async () => {
    const id = await insertBare()
    await applyNotionMetadata(db, id, { rating: -1, status: null, tags: [] })
    const [row] = await db.select({ rating: recipes.rating }).from(recipes).where(eq(recipes.id, id))
    expect(row.rating).toBe(0)
  })

  it('rounds a fractional rating to the nearest whole star', async () => {
    const id = await insertBare()
    await applyNotionMetadata(db, id, { rating: 4.5, status: null, tags: [] })
    const [row] = await db.select({ rating: recipes.rating }).from(recipes).where(eq(recipes.id, id))
    expect(row.rating).toBe(5)
  })

  it('clamps a rating above 5 to 5 rather than storing it raw', async () => {
    const id = await insertBare()
    await applyNotionMetadata(db, id, { rating: 7, status: null, tags: [] })
    const [row] = await db.select({ rating: recipes.rating }).from(recipes).where(eq(recipes.id, id))
    expect(row.rating).toBe(5)
  })

  it('leaves a normal 1-5 rating unchanged', async () => {
    const id = await insertBare()
    await applyNotionMetadata(db, id, { rating: 3, status: null, tags: [] })
    const [row] = await db.select({ rating: recipes.rating }).from(recipes).where(eq(recipes.id, id))
    expect(row.rating).toBe(3)
  })
})
