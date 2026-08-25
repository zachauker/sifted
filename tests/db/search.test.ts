import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe, searchRecipes } from '@/lib/db/queries/recipes'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb

function recipe(over: Partial<ExtractedRecipe>): ExtractedRecipe {
  return {
    title: 'Untitled',
    description: null,
    author: null,
    publisher: null,
    claimedTimeMinutes: null,
    servings: null,
    yieldText: null,
    ingredients: [],
    steps: [],
    tags: [],
    heroImageUrl: null,
    narrativeHtml: null,
    extractionMethod: 'jsonld',
    ...over,
  }
}

function ing(position: number, rawText: string) {
  return { position, section: null, rawText, quantity: null, unit: null, item: null, note: null }
}

function step(position: number, text: string) {
  return { position, section: null, text }
}

let gochujang: string
let potatoes: string
let soup: string

beforeEach(async () => {
  db = await createTestDb()

  gochujang = await upsertRecipe(db, {
    extracted: recipe({
      title: 'Slow-Roast Gochujang Chicken',
      ingredients: [ing(0, '1 Tbsp. gochujang'), ing(1, '4 chicken thighs')],
      steps: [step(0, 'Roast low for three hours.')],
    }),
    sourceUrl: 'https://example.com/gochujang',
    sourceDomain: 'example.com',
  })

  potatoes = await upsertRecipe(db, {
    extracted: recipe({
      title: 'Crispy Sauté Potatoes',
      ingredients: [ing(0, '1 kg Yukon Gold potatoes')],
      steps: [step(0, 'Parboil the potatoes, then deglaze the pan with vinegar.')],
    }),
    sourceUrl: 'https://example.com/potatoes',
    sourceDomain: 'example.com',
  })

  soup = await upsertRecipe(db, {
    extracted: recipe({
      title: 'Chicken Noodle Soup',
      ingredients: [ing(0, '1 whole chicken'), ing(1, 'egg noodles')],
      steps: [step(0, 'Simmer gently.')],
    }),
    sourceUrl: 'https://example.com/soup',
    sourceDomain: 'example.com',
  })
})

describe('searchRecipes', () => {
  it('finds a recipe by a single term', async () => {
    expect(await searchRecipes(db, 'gochujang')).toEqual([gochujang])
  })

  it('ANDs the words of a multi-word query', async () => {
    expect(await searchRecipes(db, 'chicken').then((r) => r.sort()))
      .toEqual([gochujang, soup].sort())
    expect(await searchRecipes(db, 'gochujang chicken')).toEqual([gochujang])
  })

  it('finds a term that appears only in the steps', async () => {
    expect(await searchRecipes(db, 'deglaze')).toEqual([potatoes])
  })

  it('folds diacritics, so "saute" finds a recipe titled "Sauté"', async () => {
    expect(await searchRecipes(db, 'saute')).toEqual([potatoes])
  })

  it('returns nothing for a term in no recipe', async () => {
    expect(await searchRecipes(db, 'saffron')).toEqual([])
  })

  const malformed: Array<[string, string]> = [
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a stray open paren', '('],
    ['a bare AND operator', 'AND'],
    ['an unmatched double quote', '"'],
    ['a bare wildcard', '*'],
    ['a NEAR operator with no arguments', 'NEAR('],
    ['a column filter', 'title:'],
    ['a mix of operators and punctuation', 'AND OR NOT ^ - : "'],
    ['only emoji', '🍗🔥'],
    ['a 10,000-character run of one letter', 'a'.repeat(10_000)],
    ['10,000 characters of repeated words', 'chicken '.repeat(1250)],
  ]

  for (const [label, input] of malformed) {
    it(`does not throw on ${label}`, async () => {
      await expect(searchRecipes(db, input)).resolves.toBeInstanceOf(Array)
    })
  }

  it('returns an empty array, not every recipe, when there is nothing to search for', async () => {
    for (const input of ['', '   ', '(', 'AND', '"', '*', 'NEAR(', 'AND OR NOT ^ - : "', '🍗🔥']) {
      expect(await searchRecipes(db, input)).toEqual([])
    }
  })

  it('treats an injected operator as a literal term rather than syntax', async () => {
    // Would be a syntax error, or would match everything, if passed through raw.
    expect(await searchRecipes(db, 'gochujang OR chicken')).toEqual([gochujang])
    expect(await searchRecipes(db, 'gochujang" OR "a')).toEqual([])
  })

  it('honours the limit', async () => {
    expect(await searchRecipes(db, 'chicken', 1)).toHaveLength(1)
  })
})
