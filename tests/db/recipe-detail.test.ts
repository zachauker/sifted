import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { recipes, ingredients, steps, recipeTags, images } from '@/lib/db/schema'
import { getRecipeBySlug } from '@/lib/db/queries/recipe-detail'

let db: TestDb
beforeEach(async () => {
  db = await createTestDb()
})

let counter = 0
async function insertRecipe(overrides: Record<string, unknown> = {}) {
  counter += 1
  const [row] = await db
    .insert(recipes)
    .values({
      title: 'Egg Korma',
      slug: `egg-korma-${counter}`,
      sourceUrl: `https://example.com/recipe-${counter}`,
      sourceDomain: 'example.com',
      extractionMethod: 'jsonld',
      ...overrides,
    })
    .returning()
  return row
}

describe('getRecipeBySlug', () => {
  it('returns null for a slug that is not in the library', async () => {
    await insertRecipe({ slug: 'egg-korma' })
    expect(await getRecipeBySlug(db, 'no-such-recipe')).toBeNull()
  })

  it('returns the recipe and every field the page renders', async () => {
    const recipe = await insertRecipe({
      slug: 'gochujang-chicken',
      title: 'Slow-Roast Gochujang Chicken',
      sourceUrl: 'https://www.bonappetit.com/recipe/gochujang-chicken',
      sourceDomain: 'bonappetit.com',
      publisher: 'Bon Appétit',
      author: 'Molly Baz',
      description: 'A whole chicken, slow-roasted over potatoes.',
      claimedTimeMinutes: 180,
      actualTimeMinutes: 210,
      servings: 4,
      yieldText: '4 servings',
      rating: 5,
      status: 'made_it',
      notes: 'Halve the gochujang next time.',
      narrativeHtml: '<p>It started with a chicken.</p>',
    })

    const detail = await getRecipeBySlug(db, 'gochujang-chicken')

    expect(detail).not.toBeNull()
    expect(detail).toMatchObject({
      id: recipe.id,
      slug: 'gochujang-chicken',
      title: 'Slow-Roast Gochujang Chicken',
      sourceUrl: 'https://www.bonappetit.com/recipe/gochujang-chicken',
      publisher: 'Bon Appétit',
      author: 'Molly Baz',
      description: 'A whole chicken, slow-roasted over potatoes.',
      claimedTimeMinutes: 180,
      actualTimeMinutes: 210,
      servings: 4,
      yieldText: '4 servings',
      rating: 5,
      status: 'made_it',
      notes: 'Halve the gochujang next time.',
      narrativeHtml: '<p>It started with a chicken.</p>',
      ingredients: [],
      steps: [],
      tags: [],
      images: [],
    })
  })

  // The whole point of the page. Rows are inserted in scrambled order so a
  // missing ORDER BY comes back scrambled rather than accidentally sorted:
  // SQLite returns rows in rowid (insertion) order when nothing asks
  // otherwise, so an unordered query would return exactly the insert order
  // asserted against below.
  it('orders ingredients by position, whatever order they were stored in', async () => {
    const recipe = await insertRecipe({ slug: 'ordering' })
    await db.insert(ingredients).values([
      { recipeId: recipe.id, position: 3, rawText: 'fourth' },
      { recipeId: recipe.id, position: 1, rawText: 'second' },
      { recipeId: recipe.id, position: 0, rawText: 'first' },
      { recipeId: recipe.id, position: 2, rawText: 'third' },
    ])

    const detail = await getRecipeBySlug(db, 'ordering')

    expect(detail?.ingredients.map((i) => i.rawText)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ])
  })

  // Steps in the wrong order look completely fine and ruin the dish: sear
  // after simmering, salt after resting. This is the most dangerous silent
  // bug this page can have, so it gets its own test rather than sharing one
  // with ingredients.
  it('orders steps by position, whatever order they were stored in', async () => {
    const recipe = await insertRecipe({ slug: 'step-ordering' })
    await db.insert(steps).values([
      { recipeId: recipe.id, position: 2, text: 'Simmer for an hour.' },
      { recipeId: recipe.id, position: 0, text: 'Season the beef.' },
      { recipeId: recipe.id, position: 3, text: 'Rest, then slice.' },
      { recipeId: recipe.id, position: 1, text: 'Sear on all sides.' },
    ])

    const detail = await getRecipeBySlug(db, 'step-ordering')

    expect(detail?.steps.map((s) => s.text)).toEqual([
      'Season the beef.',
      'Sear on all sides.',
      'Simmer for an hour.',
      'Rest, then slice.',
    ])
  })

  /**
   * The two tests above are necessary but, measured, not sufficient — and the
   * gap is worth writing down rather than discovering later.
   *
   * Deleting `.orderBy(ingredients.position)` makes the ingredient test fail,
   * as intended. Deleting `.orderBy(steps.position)` does **not** make the
   * step test fail: `EXPLAIN QUERY PLAN` shows SQLite serving that query from
   * `steps_recipe_id_position_unique`, an index on `(recipe_id, position)`,
   * so the rows arrive in position order by accident of the query plan. (The
   * ingredient query, selecting more columns, gets planned onto
   * `ingredients_recipe_idx` instead, which is why it does fail.) A plan is
   * not a guarantee: it can flip on an `ANALYZE`, a schema change, a
   * different SQLite build, or a future Turso server.
   *
   * So the ordering of the one list where a silent mistake ruins the dish is
   * pinned structurally as well. This asserts on source text, which is a blunt
   * instrument — but the alternative is a behavioural test that currently
   * cannot fail, which is worse than a blunt one that can.
   */
  it('asks SQL for the order rather than trusting the query planner', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/lib/db/queries/recipe-detail.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain('.orderBy(steps.position)')
    expect(source).toContain('.orderBy(ingredients.position)')
  })

  it('carries the parsed ingredient fields alongside the raw line', async () => {
    const recipe = await insertRecipe({ slug: 'parsed' })
    await db.insert(ingredients).values({
      recipeId: recipe.id,
      position: 0,
      section: 'For the filling',
      rawText: '1 ½ cups all-purpose flour, sifted',
      quantity: 1.5,
      unit: 'cup',
      item: 'all-purpose flour',
      note: 'sifted',
    })

    const detail = await getRecipeBySlug(db, 'parsed')

    expect(detail?.ingredients[0]).toMatchObject({
      position: 0,
      section: 'For the filling',
      rawText: '1 ½ cups all-purpose flour, sifted',
      quantity: 1.5,
      unit: 'cup',
      item: 'all-purpose flour',
      note: 'sifted',
    })
  })

  it('returns tags with their facet, and images with their stored URLs', async () => {
    const recipe = await insertRecipe({ slug: 'tagged' })
    await db.insert(recipeTags).values([
      { recipeId: recipe.id, facet: 'course', value: 'main' },
      { recipeId: recipe.id, facet: 'cuisine', value: 'korean' },
    ])
    await db.insert(images).values({
      recipeId: recipe.id,
      role: 'source_hero',
      blobKey: 'recipes/full.webp',
      thumbKey: 'recipes/thumb.webp',
      blobUrl: 'https://blob.example.com/full.webp',
      thumbUrl: 'https://blob.example.com/thumb.webp',
      width: 1600,
      height: 1067,
    })

    const detail = await getRecipeBySlug(db, 'tagged')

    expect(detail?.tags).toEqual(
      expect.arrayContaining([
        { facet: 'course', value: 'main' },
        { facet: 'cuisine', value: 'korean' },
      ]),
    )
    expect(detail?.tags).toHaveLength(2)
    expect(detail?.images).toEqual([
      {
        role: 'source_hero',
        blobUrl: 'https://blob.example.com/full.webp',
        thumbUrl: 'https://blob.example.com/thumb.webp',
        width: 1600,
        height: 1067,
      },
    ])
  })

  // A recipe rescued from a Notion body has no narrative, no image, no tags
  // and no source. It must come back as a recipe, not as a null.
  it('returns a sparse Notion-bodied recipe rather than nothing', async () => {
    await insertRecipe({
      slug: 'grandmas-rolls',
      title: "Grandma's Rolls",
      sourceUrl: null,
      sourceDomain: null,
      publisher: null,
      author: null,
      narrativeHtml: null,
      extractionMethod: 'notion',
    })

    const detail = await getRecipeBySlug(db, 'grandmas-rolls')

    expect(detail).toMatchObject({
      title: "Grandma's Rolls",
      sourceUrl: null,
      narrativeHtml: null,
      images: [],
      tags: [],
    })
  })

  // Two recipes with children in the database at once: the child queries must
  // be scoped to the one being asked for, which a bad `inArray`/missing WHERE
  // would get wrong in the most embarrassing possible way.
  it('never mixes another recipe’s ingredients or steps in', async () => {
    const mine = await insertRecipe({ slug: 'mine' })
    const other = await insertRecipe({ slug: 'other' })
    await db.insert(ingredients).values([
      { recipeId: mine.id, position: 0, rawText: 'mine only' },
      { recipeId: other.id, position: 0, rawText: 'not mine' },
    ])
    await db.insert(steps).values([
      { recipeId: mine.id, position: 0, text: 'mine only' },
      { recipeId: other.id, position: 0, text: 'not mine' },
    ])
    await db.insert(recipeTags).values([
      { recipeId: mine.id, facet: 'course', value: 'main' },
      { recipeId: other.id, facet: 'course', value: 'dessert' },
    ])

    const detail = await getRecipeBySlug(db, 'mine')

    expect(detail?.ingredients.map((i) => i.rawText)).toEqual(['mine only'])
    expect(detail?.steps.map((s) => s.text)).toEqual(['mine only'])
    expect(detail?.tags).toEqual([{ facet: 'course', value: 'main' }])
  })
})
