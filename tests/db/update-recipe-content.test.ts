import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import {
  upsertRecipe,
  updateUserFields,
  updateRecipeContent,
  searchRecipes,
  enrichStoredRecipe,
  type RecipeContentInput,
} from '@/lib/db/queries/recipes'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
let recipeId: string

function extracted(over: Partial<ExtractedRecipe> = {}): ExtractedRecipe {
  return {
    title: 'Slow-Roast Gochujang Chicken',
    description: 'A whole chicken, slow-roasted.',
    author: 'Molly Baz',
    publisher: 'Bon Appétit',
    claimedTimeMinutes: 180,
    servings: 4,
    yieldText: '4 servings',
    ingredients: [
      { position: 0, section: null, rawText: '2 Tbsp. gochujang', quantity: null, unit: null, item: null, note: null },
      { position: 1, section: null, rawText: '1 whole chicken', quantity: null, unit: null, item: null, note: null },
    ],
    steps: [{ position: 0, section: null, text: 'Roast low for three hours.' }],
    tags: [],
    heroImageUrl: null,
    narrativeHtml: '<p>It started with a chicken.</p>',
    extractionMethod: 'jsonld',
    ...over,
  }
}

/** A complete, valid edit; override just the part under test. */
function input(over: Partial<RecipeContentInput> = {}): RecipeContentInput {
  return {
    title: 'Slow-Roast Gochujang Chicken',
    description: 'A whole chicken, slow-roasted.',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    sourceUrl: 'https://example.com/gochujang',
    sourceDomain: 'example.com',
    claimedTimeMinutes: 180,
    servings: 4,
    yieldText: '4 servings',
    ingredients: [
      { section: null, text: '2 Tbsp. gochujang' },
      { section: null, text: '1 whole chicken' },
    ],
    steps: [{ section: null, text: 'Roast low for three hours.' }],
    tags: [],
    ...over,
  }
}

async function row(id: string) {
  return db.select().from(recipes).where(eq(recipes.id, id)).get()
}

async function ingredientRows(id: string) {
  return db.select().from(ingredients).where(eq(ingredients.recipeId, id)).all()
}

beforeEach(async () => {
  db = await createTestDb()
  recipeId = await upsertRecipe(db, {
    extracted: extracted(),
    sourceUrl: 'https://example.com/gochujang',
    sourceDomain: 'example.com',
  })
})

describe('updateRecipeContent', () => {
  it('reports a missing recipe rather than throwing', async () => {
    expect(await updateRecipeContent(db, 'no-such-id', input())).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('writes the recipe-level fields', async () => {
    const result = await updateRecipeContent(db, recipeId, input({
      title: 'Slow-Roast Gochujang Chicken, Corrected',
      description: 'Corrected.',
      publisher: 'Bon Appétit Magazine',
      author: 'M. Baz',
      claimedTimeMinutes: 200,
      servings: 6,
      yieldText: '6 servings',
    }))

    expect(result).toEqual({ ok: true })
    expect(await row(recipeId)).toMatchObject({
      title: 'Slow-Roast Gochujang Chicken, Corrected',
      description: 'Corrected.',
      publisher: 'Bon Appétit Magazine',
      author: 'M. Baz',
      claimedTimeMinutes: 200,
      servings: 6,
      yieldText: '6 servings',
    })
  })

  it('marks the recipe hand-edited', async () => {
    await updateRecipeContent(db, recipeId, input())
    expect((await row(recipeId))?.handEdited).toBe(true)
  })

  it('never touches the four fields nothing else can write', async () => {
    await updateUserFields(db, recipeId, {
      rating: 5,
      status: 'made_it',
      notes: 'Halve the gochujang.',
      actualTimeMinutes: 210,
    })

    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))

    expect(await row(recipeId)).toMatchObject({
      rating: 5,
      status: 'made_it',
      notes: 'Halve the gochujang.',
      actualTimeMinutes: 210,
    })
  })

  it('never moves the slug, however the title changes', async () => {
    const before = (await row(recipeId))?.slug
    await updateRecipeContent(db, recipeId, input({ title: 'A Completely Different Name' }))
    expect((await row(recipeId))?.slug).toBe(before)
  })

  it('never moves createdAt or the re-extraction plumbing', async () => {
    const before = await row(recipeId)
    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))
    const after = await row(recipeId)

    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.extractionMethod).toBe(before?.extractionMethod)
    expect(after?.enrichmentApplied).toBe(before?.enrichmentApplied)
    expect(after?.narrativeHtml).toBe(before?.narrativeHtml)
  })

  it('replaces the ingredient and step lists in order', async () => {
    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: null, text: '3 Tbsp. gochujang' },
        { section: null, text: '1 whole chicken' },
        { section: null, text: 'flaky salt' },
      ],
      steps: [
        { section: null, text: 'Salt the bird a day ahead.' },
        { section: null, text: 'Roast low for three hours.' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored.map((i) => [i.position, i.rawText])).toEqual([
      [0, '3 Tbsp. gochujang'],
      [1, '1 whole chicken'],
      [2, 'flaky salt'],
    ])

    const storedSteps = await db.select().from(steps).where(eq(steps.recipeId, recipeId)).all()
    expect(storedSteps.map((s) => [s.position, s.text])).toEqual([
      [0, 'Salt the bird a day ahead.'],
      [1, 'Roast low for three hours.'],
    ])
  })

  it('stores the section each line belongs to', async () => {
    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: 'For the sauce', text: '2 Tbsp. gochujang' },
        { section: 'For the chicken', text: '1 whole chicken' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored.map((i) => i.section)).toEqual(['For the sauce', 'For the chicken'])
  })

  it('carries parsed columns forward for lines whose text is unchanged', async () => {
    await enrichStoredRecipe(db, recipeId, {
      tags: [],
      ingredients: [
        { position: 0, quantity: 2, unit: 'Tbsp.', item: 'gochujang', note: null },
        { position: 1, quantity: 1, unit: null, item: 'chicken', note: 'whole' },
      ],
    })

    await updateRecipeContent(db, recipeId, input())

    const stored = await ingredientRows(recipeId)
    expect(stored[0]).toMatchObject({ rawText: '2 Tbsp. gochujang', quantity: 2, unit: 'Tbsp.', item: 'gochujang' })
    expect(stored[1]).toMatchObject({ rawText: '1 whole chicken', quantity: 1, item: 'chicken', note: 'whole' })
  })

  it('nulls the parsed columns on a line whose text was edited', async () => {
    await enrichStoredRecipe(db, recipeId, {
      tags: [],
      ingredients: [{ position: 0, quantity: 2, unit: 'Tbsp.', item: 'gochujang', note: null }],
    })

    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: null, text: '3 Tbsp. gochujang' },
        { section: null, text: '1 whole chicken' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored[0]).toMatchObject({
      rawText: '3 Tbsp. gochujang',
      quantity: null,
      unit: null,
      item: null,
      note: null,
    })
  })

  it('does not shift parsed quantities onto the wrong line when one is inserted at the top', async () => {
    // The trap: `enrichStoredRecipe` keys parsed columns on (recipe_id,
    // position). Without carry-forward by text, inserting a line above would
    // silently reattach "2 Tbsp." to the chicken.
    await enrichStoredRecipe(db, recipeId, {
      tags: [],
      ingredients: [
        { position: 0, quantity: 2, unit: 'Tbsp.', item: 'gochujang', note: null },
        { position: 1, quantity: 1, unit: null, item: 'chicken', note: null },
      ],
    })

    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: null, text: 'flaky salt' },
        { section: null, text: '2 Tbsp. gochujang' },
        { section: null, text: '1 whole chicken' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored.map((i) => [i.rawText, i.quantity, i.item])).toEqual([
      ['flaky salt', null, null],
      ['2 Tbsp. gochujang', 2, 'gochujang'],
      ['1 whole chicken', 1, 'chicken'],
    ])
  })

  it('accepts a recipe with no ingredients and no steps', async () => {
    const result = await updateRecipeContent(db, recipeId, input({ ingredients: [], steps: [] }))

    expect(result).toEqual({ ok: true })
    expect(await ingredientRows(recipeId)).toEqual([])
  })

  it('replaces the whole tag set and stores it as the user’s', async () => {
    await db.insert(recipeTags).values([
      { recipeId, facet: 'course', value: 'main', source: 'extracted' },
      { recipeId, facet: 'cuisine', value: 'italian', source: 'notion' },
    ])

    await updateRecipeContent(db, recipeId, input({
      tags: [
        { facet: 'course', value: 'main' },
        { facet: 'cuisine', value: 'korean' },
      ],
    }))

    const stored = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)).all()
    expect(stored.map((t) => `${t.facet}:${t.value}`).sort()).toEqual(['course:main', 'cuisine:korean'])
    expect(stored.every((t) => t.source === 'user')).toBe(true)
  })

  it('removes every tag when none are submitted', async () => {
    await db.insert(recipeTags).values([{ recipeId, facet: 'course', value: 'main', source: 'extracted' }])

    await updateRecipeContent(db, recipeId, input({ tags: [] }))

    expect(await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)).all()).toEqual([])
  })

  it('re-indexes for search: old terms stop matching, new ones start', async () => {
    expect(await searchRecipes(db, 'gochujang')).toContain(recipeId)

    await updateRecipeContent(db, recipeId, input({
      title: 'Slow-Roast Harissa Chicken',
      ingredients: [{ section: null, text: '2 Tbsp. harissa' }],
      steps: [{ section: null, text: 'Roast low for three hours.' }],
    }))

    expect(await searchRecipes(db, 'harissa')).toContain(recipeId)
    expect(await searchRecipes(db, 'gochujang')).not.toContain(recipeId)
  })

  it('keeps the household note searchable across a content edit', async () => {
    await updateUserFields(db, recipeId, { notes: 'Halve the gochujang.' })

    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))

    expect(await searchRecipes(db, 'halve')).toContain(recipeId)
  })

  it('keeps the narrative searchable across a content edit', async () => {
    expect(await searchRecipes(db, 'started')).toContain(recipeId)
    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))
    expect(await searchRecipes(db, 'started')).toContain(recipeId)
  })

  it('refuses a source URL another recipe already owns, and changes nothing', async () => {
    await upsertRecipe(db, {
      extracted: extracted({ title: 'Cabbage Gratin' }),
      sourceUrl: 'https://example.com/gratin',
      sourceDomain: 'example.com',
    })

    const result = await updateRecipeContent(db, recipeId, input({
      title: 'Should Not Be Written',
      sourceUrl: 'https://example.com/gratin',
      sourceDomain: 'example.com',
    }))

    expect(result).toEqual({ ok: false, reason: 'source_url_taken' })
    expect((await row(recipeId))?.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('allows a recipe to keep the source URL it already has', async () => {
    const result = await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))
    expect(result).toEqual({ ok: true })
  })

  it('allows clearing the source URL', async () => {
    await updateRecipeContent(db, recipeId, input({ sourceUrl: null, sourceDomain: null }))
    expect(await row(recipeId)).toMatchObject({ sourceUrl: null, sourceDomain: null })
  })
})
