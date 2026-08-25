import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

async function index(recipeId: string, title: string, ingredientsText: string, stepsText: string) {
  await db.run(sql`
    INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
    VALUES (${recipeId}, ${title}, ${ingredientsText}, ${stepsText}, '', '')
  `)
}

async function search(query: string): Promise<string[]> {
  const rows = await db.all<{ recipe_id: string }>(sql`
    SELECT recipe_id FROM recipes_fts WHERE recipes_fts MATCH ${query} ORDER BY rank
  `)
  return rows.map((r) => r.recipe_id)
}

describe('recipes_fts', () => {
  beforeEach(async () => {
    await index('r1', 'Slow-Roast Gochujang Chicken', '1 tbsp gochujang\n4 chicken thighs', 'Roast low.')
    await index('r2', 'Best Bolognese', '1 lb ground beef\npancetta', 'Simmer for three hours.')
  })

  it('finds a recipe by an ingredient buried in the list', async () => {
    expect(await search('gochujang')).toEqual(['r1'])
  })

  it('finds a recipe by step text', async () => {
    expect(await search('simmer')).toEqual(['r2'])
  })

  it('stems, so a search for a related form still matches', async () => {
    expect(await search('roasted')).toContain('r1')
  })

  it('returns nothing for a term in no recipe', async () => {
    expect(await search('saffron')).toEqual([])
  })
})
