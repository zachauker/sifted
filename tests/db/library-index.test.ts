import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { recipes, images, recipeTags } from '@/lib/db/schema'
import { buildLibraryIndex } from '@/lib/db/queries/library'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

let counter = 0
async function insertRecipe(overrides: Record<string, unknown> = {}) {
  counter += 1
  const [row] = await db.insert(recipes).values({
    title: 'Egg Korma',
    slug: `egg-korma-${counter}`,
    sourceUrl: `https://example.com/recipe-${counter}`,
    sourceDomain: 'example.com',
    extractionMethod: 'jsonld',
    ...overrides,
  }).returning()
  return row
}

describe('buildLibraryIndex', () => {
  it('returns an empty array for an empty library', async () => {
    expect(await buildLibraryIndex(db)).toEqual([])
  })

  it('maps every field of a fully populated recipe', async () => {
    const recipe = await insertRecipe({
      title: 'Slow-Roast Gochujang Chicken',
      publisher: 'Bon Appétit',
      rating: 5,
      status: 'made_it',
      claimedTimeMinutes: 180,
      actualTimeMinutes: 210,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    })
    await db.insert(images).values({
      recipeId: recipe.id,
      role: 'source_hero',
      blobKey: 'recipes/full.jpg',
      thumbKey: 'recipes/thumb.jpg',
      blobUrl: 'https://blob.example.com/full.jpg',
      thumbUrl: 'https://blob.example.com/thumb.jpg',
      width: 1600,
      height: 1067,
    })
    await db.insert(recipeTags).values([
      { recipeId: recipe.id, facet: 'course', value: 'main' },
      { recipeId: recipe.id, facet: 'method', value: 'oven' },
    ])

    const entries = await buildLibraryIndex(db)

    expect(entries).toEqual([{
      id: recipe.id,
      slug: recipe.slug,
      title: 'Slow-Roast Gochujang Chicken',
      thumbUrl: 'https://blob.example.com/thumb.jpg',
      publisher: 'Bon Appétit',
      rating: 5,
      status: 'made_it',
      claimedTimeMinutes: 180,
      actualTimeMinutes: 210,
      createdAt: new Date('2024-01-01T00:00:00Z').getTime(),
      tags: ['course:main', 'method:oven'],
    }])
  })

  // The thumbnail is 480px and the display image is 1600px. Reading blobUrl
  // here by mistake would put a full-size image on every card in a
  // 156-recipe grid.
  it("reads thumbUrl from the source_hero image's thumbUrl, not blobUrl", async () => {
    const recipe = await insertRecipe()
    await db.insert(images).values({
      recipeId: recipe.id,
      role: 'source_hero',
      blobKey: 'k1',
      thumbKey: 'k2',
      blobUrl: 'https://blob.example.com/full-1600.jpg',
      thumbUrl: 'https://blob.example.com/thumb-480.jpg',
      width: 1600,
      height: 1067,
    })

    const [entry] = await buildLibraryIndex(db)

    expect(entry.thumbUrl).toBe('https://blob.example.com/thumb-480.jpg')
    expect(entry.thumbUrl).not.toBe('https://blob.example.com/full-1600.jpg')
  })

  it('returns thumbUrl: null for a recipe with no image', async () => {
    await insertRecipe()

    const [entry] = await buildLibraryIndex(db)

    expect(entry.thumbUrl).toBeNull()
  })

  it('returns null, not undefined or a broken string, when the image row has a null thumbUrl', async () => {
    const recipe = await insertRecipe()
    await db.insert(images).values({
      recipeId: recipe.id,
      role: 'source_hero',
      blobKey: 'k1',
      thumbKey: 'k2',
      blobUrl: 'https://blob.example.com/full.jpg',
      thumbUrl: null,
      width: 1600,
      height: 1067,
    })

    const [entry] = await buildLibraryIndex(db)

    expect(entry.thumbUrl).toBeNull()
    expect(entry.thumbUrl).not.toBeUndefined()
  })

  it('returns tags as flat facet:value strings', async () => {
    const recipe = await insertRecipe()
    await db.insert(recipeTags).values([
      { recipeId: recipe.id, facet: 'course', value: 'main' },
      { recipeId: recipe.id, facet: 'cuisine', value: 'mexican' },
    ])

    const [entry] = await buildLibraryIndex(db)

    expect(entry.tags).toEqual(['course:main', 'cuisine:mexican'])
  })

  it('returns an empty tags array for a recipe with no tags', async () => {
    await insertRecipe()

    const [entry] = await buildLibraryIndex(db)

    expect(entry.tags).toEqual([])
  })

  it('orders entries newest-first by createdAt', async () => {
    const oldest = await insertRecipe({ title: 'Oldest', createdAt: new Date('2020-01-01T00:00:00Z') })
    const newest = await insertRecipe({ title: 'Newest', createdAt: new Date('2024-01-01T00:00:00Z') })
    const middle = await insertRecipe({ title: 'Middle', createdAt: new Date('2022-01-01T00:00:00Z') })

    const entries = await buildLibraryIndex(db)

    expect(entries.map((e) => e.id)).toEqual([newest.id, middle.id, oldest.id])
  })

  // Being able to see a broken recipe (nothing but a title) is how it gets
  // fixed. buildLibraryIndex never touches ingredients or steps, so a recipe
  // with neither must still appear.
  it('includes a recipe with no ingredients or steps', async () => {
    const recipe = await insertRecipe({ title: 'Broken Recipe' })

    const entries = await buildLibraryIndex(db)

    expect(entries.map((e) => e.id)).toContain(recipe.id)
  })

  const REALISTIC_TITLES = [
    'Slow-Roast Gochujang Chicken', 'Best Bolognese', 'Egg Korma',
    'Chocolate Chip Cookies', 'Classic Beef Stew', 'Thai Green Curry',
    'Lemon Garlic Roast Chicken', 'Spicy Miso Ramen', 'Classic Margherita Pizza',
    'Braised Short Ribs', 'Butternut Squash Soup', 'Grilled Salmon with Dill',
    'Vegetarian Chili', 'Homemade Pad Thai', 'Crispy Fish Tacos',
    'Mushroom Risotto', 'BBQ Pulled Pork', 'Roasted Brussels Sprouts',
    'Banana Bread', 'Chicken Tikka Masala', 'Beef and Broccoli Stir-Fry',
    'Baked Ziti', 'Shrimp Scampi', 'Korean Beef Bowls', 'French Onion Soup',
    'Buttermilk Fried Chicken', 'Kung Pao Chicken', 'Sheet-Pan Fajitas',
    'Creamy Tuscan Chicken', 'Weeknight Gochujang Noodles',
  ]

  const REALISTIC_PUBLISHERS = [
    'Bon Appétit', 'Serious Eats', 'NYT Cooking', 'Food52', 'Epicurious',
    'Smitten Kitchen', 'Half Baked Harvest', 'The Kitchn',
    "America's Test Kitchen", "Cook's Illustrated", 'Simply Recipes',
    'Budget Bytes', 'Once Upon a Chef', 'Love and Lemons',
  ]

  const TAG_POOL: Array<{ facet: 'course' | 'ingredient' | 'method' | 'cuisine' | 'tag'; value: string }> = [
    { facet: 'course', value: 'main' }, { facet: 'course', value: 'side' },
    { facet: 'course', value: 'dessert' }, { facet: 'course', value: 'breakfast' },
    { facet: 'method', value: 'oven' }, { facet: 'method', value: 'grill' },
    { facet: 'method', value: 'stovetop' }, { facet: 'method', value: 'slow-cooker' },
    { facet: 'cuisine', value: 'mexican' }, { facet: 'cuisine', value: 'italian' },
    { facet: 'cuisine', value: 'thai' }, { facet: 'cuisine', value: 'indian' },
    { facet: 'ingredient', value: 'chicken' }, { facet: 'ingredient', value: 'beef' },
    { facet: 'ingredient', value: 'seafood' }, { facet: 'ingredient', value: 'vegetarian' },
    { facet: 'tag', value: 'weeknight' }, { facet: 'tag', value: 'make-ahead' },
    { facet: 'tag', value: 'thanksgiving' }, { facet: 'tag', value: 'comfort-food' },
  ]

  /**
   * The whole client-side-filtering design rests on the payload being small
   * enough to hand to the browser once and filter in memory — no network
   * round trip per click. 156 entries with realistic field lengths (real
   * titles, real publisher names, 4-6 tags each, a plausible blob URL) is
   * the shape of the real library.
   *
   * If this test ever fails, the client-side-filtering design needs
   * revisiting, and this is where that should be discovered — not a slow
   * grid in production three years from now.
   */
  it('keeps a realistic 156-recipe payload well under 100kb serialized', async () => {
    for (let i = 0; i < 156; i++) {
      const recipe = await insertRecipe({
        title: REALISTIC_TITLES[i % REALISTIC_TITLES.length],
        publisher: REALISTIC_PUBLISHERS[i % REALISTIC_PUBLISHERS.length],
        rating: (i % 5) + 1,
        status: i % 2 === 0 ? 'made_it' : 'want_to_make',
        claimedTimeMinutes: 30 + (i % 6) * 15,
        actualTimeMinutes: 35 + (i % 6) * 15,
        createdAt: new Date(2020, 0, 1 + i),
      })

      await db.insert(images).values({
        recipeId: recipe.id,
        role: 'source_hero',
        blobKey: `recipes/${recipe.id}/full.jpg`,
        thumbKey: `recipes/${recipe.id}/thumb.jpg`,
        blobUrl: `https://a1b2c3d4e5f6g7h8i9j0k1.public.blob.vercel-storage.com/recipes/${recipe.id}/full-k9x2m1.jpg`,
        thumbUrl: `https://a1b2c3d4e5f6g7h8i9j0k1.public.blob.vercel-storage.com/recipes/${recipe.id}/thumb-k9x2m1.jpg`,
        width: 1600,
        height: 1067,
      })

      const tagCount = 4 + (i % 3) // 4-6 tags
      const seen = new Set<string>()
      const tagValues = []
      for (let j = 0; j < tagCount; j++) {
        const tag = TAG_POOL[(i + j) % TAG_POOL.length]
        const key = `${tag.facet}:${tag.value}`
        if (seen.has(key)) continue
        seen.add(key)
        tagValues.push({ recipeId: recipe.id, facet: tag.facet, value: tag.value })
      }
      await db.insert(recipeTags).values(tagValues)
    }

    const start = performance.now()
    const entries = await buildLibraryIndex(db)
    const elapsedMs = performance.now() - start

    expect(entries).toHaveLength(156)

    const size = JSON.stringify(entries).length
    // Measured numbers belong in the report, not just pass/fail.
    console.log(`library index: ${size} bytes serialized, ${elapsedMs.toFixed(1)}ms for 156 recipes`)

    expect(size).toBeLessThan(100_000)
  }, 30_000)
})
