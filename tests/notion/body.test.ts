import { describe, it, expect, vi } from 'vitest'
import { findSourceUrlInBody, fromNotionBody } from '@/lib/notion/body'
import type { NotionRecipeRow, NotionRecipeBody } from '@/lib/notion/types'
import type { LlmClient } from '@/lib/extract/llm-types'
import structured from './fixtures/body-structured.json'
import unstructured from './fixtures/body-unstructured.json'

const row = (over: Partial<NotionRecipeRow> = {}): NotionRecipeRow => ({
  pageId: 'p1', title: 'Ham Pot Pie', link: null, publisher: 'Homemade',
  author: null, rating: 5, cookingStatus: 'Made It', tags: ['Dinner'],
  createdTime: '2022-01-30 00:02:00Z', ...over,
})

const noLlm = (): LlmClient => ({
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
})

describe('findSourceUrlInBody', () => {
  it('finds a source url that the Link property was missing', () => {
    expect(findSourceUrlInBody(structured as NotionRecipeBody))
      .toBe('https://www.finecooking.com/recipe/cast-iron-green-chile-tamale-pie')
  })

  it('returns null when the body has no link', () => {
    expect(findSourceUrlInBody(unstructured as NotionRecipeBody)).toBeNull()
  })

  it('ignores links that appear inside an ingredient line', () => {
    const body = { pageId: 'p', markdown: '## Ingredients\n- 1 cup [salsa](https://x.com/salsa)\n' }
    expect(findSourceUrlInBody(body)).toBeNull()
  })
})

describe('fromNotionBody — structured body', () => {
  it('parses headings without needing the model', async () => {
    const llm = noLlm()
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, llm))!
    expect(r.extractionMethod).toBe('notion')
    expect(llm.extractRecipe).not.toHaveBeenCalled()
    expect(r.ingredients).toHaveLength(21)
    expect(r.ingredients[0].rawText).toBe('1 lb. 85% lean ground beef')
    // The plan says 5; the committed fixture has four paragraphs under
    // `## Preparation` (one under "Make the filling", three under "Make the
    // cornbread topping"). Four is what the real data holds.
    expect(r.steps).toHaveLength(4)
  })

  it('carries sub-headings through as ingredient and step sections', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm()))!
    expect(r.ingredients[0].section).toBe('For the filling')
    expect(r.ingredients.at(-1)!.section).toBe('For the cornbread topping')
    expect(r.steps[0].section).toBe('Make the filling')
  })

  it('keeps the ingredient line with a nested link verbatim', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm()))!
    expect(r.ingredients[4].rawText).toBe(
      '1 cup mild or spicy salsa verde ([homemade](https://www.finecooking.com/recipe/cooked-tomatillo-salsa) or storebought); more for serving',
    )
  })

  it('returns ingredients and steps in document order', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm()))!
    expect(r.ingredients.map((i) => i.position)).toEqual([...r.ingredients.keys()])
    expect(r.ingredients.at(-1)!.rawText).toBe('Sour cream and avocado slices, for serving')
    expect(r.steps[0].text).toContain('Preheat the oven to 400°F')
    expect(r.steps.at(-1)!.text).toContain('Scatter half of the cheese')
  })

  it('keeps the prose above the recipe as the narrative', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm()))!
    expect(r.narrativeHtml).toContain('Tamale pie owes its name')
    expect(r.narrativeHtml).not.toContain('lean ground beef')
  })

  it('takes the hero image from the body', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm()))!
    expect(r.heroImageUrl).toContain('tamale-beef-pie')
  })
})

describe('fromNotionBody — unstructured body', () => {
  it('falls back to the model when there are no headings', async () => {
    const llm: LlmClient = {
      enrich: vi.fn(),
      extractRecipe: vi.fn().mockResolvedValue({
        title: 'Ham Pot Pie', description: null, author: null,
        claimedTimeMinutes: null, servings: null, yieldText: null,
        ingredients: ['Ham', '1 lb potatoes', '4 cups flour'],
        steps: [],
      }),
    }
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, llm))!

    expect(llm.extractRecipe).toHaveBeenCalledOnce()
    expect(r.ingredients.map((i) => i.rawText)).toEqual(['Ham', '1 lb potatoes', '4 cups flour'])
    expect(r.extractionMethod).toBe('notion')
  })

  it('salvages the lines as ingredients when the model is unavailable', async () => {
    // A five-star family recipe that exists nowhere else must not be lost
    // because the model was down. Bare lines become verbatim ingredients.
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm()))!
    expect(r.ingredients.map((i) => i.rawText)).toContain('1 lb potatoes')
    expect(r.ingredients.map((i) => i.rawText)).toContain('4 cups flour')
    expect(r.steps).toEqual([])
  })

  it('salvages every line of the body, in order, losing nothing', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm()))!
    expect(r.ingredients.map((i) => [i.rawText, i.section])).toEqual([
      ['Ham', null],
      ['Ham base', null],
      ['1 lb potatoes', null],
      ['2 carrots', null],
      ['1 onion', null],
      ['3 celery stalks', null],
      ['Garlic', null],
      ['8 cups water', null],
      ['4 cups flour', 'Dough'],
      ['4 TBS crisco', 'Dough'],
      ['1 1/3 cup water', 'Dough'],
    ])
  })

  it('keeps the markdown image out of the salvaged ingredients', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm()))!
    expect(r.ingredients.some((i) => i.rawText.includes('!['))).toBe(false)
    expect(r.ingredients.some((i) => i.rawText.includes('Untitled.png'))).toBe(false)
    expect(r.heroImageUrl).toContain('Untitled.png')
  })

  it('treats a bolded line as a section break', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm()))!
    const flour = r.ingredients.find((i) => i.rawText === '4 cups flour')!
    expect(flour.section).toBe('Dough')
  })
})

describe('fromNotionBody — shared behavior', () => {
  it('never parses quantities; that is enrichment\'s job', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm()))!
    for (const i of r.ingredients) {
      expect(i.quantity).toBeNull()
      expect(i.unit).toBeNull()
      expect(i.item).toBeNull()
    }
  })

  it('takes the title and publisher from the row, not from the body', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm()))!
    expect(r.title).toBe('Ham Pot Pie')
    expect(r.publisher).toBe('Homemade')
  })

  it('falls through to the model when a heading has nothing under it', async () => {
    const llm: LlmClient = {
      enrich: vi.fn(),
      extractRecipe: vi.fn().mockResolvedValue({
        title: 'Soup', description: null, author: null,
        claimedTimeMinutes: null, servings: null, yieldText: null,
        ingredients: ['1 onion'], steps: [],
      }),
    }
    const body = { pageId: 'p', markdown: '## Ingredients\n\n## Notes\nMom has the onion soup one.\n' }
    const r = (await fromNotionBody(row(), body, llm))!
    expect(llm.extractRecipe).toHaveBeenCalledOnce()
    expect(r.ingredients.map((i) => i.rawText)).toEqual(['1 onion'])
  })

  it('never returns an empty-but-non-null recipe', async () => {
    const body = { pageId: 'p', markdown: '## Ingredients\n' }
    expect(await fromNotionBody(row(), body, noLlm())).toBeNull()
  })

  it('returns null for an empty body', async () => {
    expect(await fromNotionBody(row(), { pageId: 'p', markdown: '' }, noLlm())).toBeNull()
  })

  it('returns null for a body with only prose and no recipe', async () => {
    const body = { pageId: 'p', markdown: 'We should try making this sometime.\n' }
    expect(await fromNotionBody(row(), body, noLlm())).toBeNull()
  })

  it('returns null for a titleless row with an empty body', async () => {
    // The library contains exactly one of these — a blank page created by
    // accident. It must be reported as unrecoverable, not crash the migration.
    const r = await fromNotionBody(row({ title: null as never }), { pageId: 'p', markdown: '' }, noLlm())
    expect(r).toBeNull()
  })
})
