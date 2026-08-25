import { describe, it, expect, vi } from 'vitest'
import { applyEnrichment } from './enrich'
import type { LlmClient } from './llm-types'
import type { PartialRecipe } from './types'

const recipe: PartialRecipe = {
  title: 'Flatbread',
  description: null,
  author: null,
  publisher: null,
  claimedTimeMinutes: 35,
  servings: 10,
  yieldText: '10 flatbreads',
  ingredients: [
    { position: 0, section: null, rawText: '1 1/2 cups all-purpose flour, sifted', quantity: null, unit: null, item: null, note: null },
  ],
  steps: [{ position: 0, section: null, text: 'Mix.' }],
  tags: [],
  heroImageUrl: null,
  extractionMethod: 'jsonld',
}

function client(response: unknown): LlmClient {
  return {
    enrich: vi.fn().mockResolvedValue(response),
    extractRecipe: vi.fn(),
  }
}

describe('applyEnrichment', () => {
  it('fills in structured ingredient fields while preserving rawText', async () => {
    const result = await applyEnrichment(recipe, client({
      description: 'Soft stovetop flatbread.',
      tags: [{ facet: 'course', value: 'bread' }],
      ingredients: [{ position: 0, quantity: 1.5, unit: 'cup', item: 'all-purpose flour', note: 'sifted' }],
    }))

    expect(result.ingredients[0].rawText).toBe('1 1/2 cups all-purpose flour, sifted')
    expect(result.ingredients[0].quantity).toBe(1.5)
    expect(result.ingredients[0].unit).toBe('cup')
    expect(result.ingredients[0].item).toBe('all-purpose flour')
    expect(result.ingredients[0].note).toBe('sifted')
  })

  it('adds a description only when one is missing', async () => {
    const withDescription = { ...recipe, description: 'Original.' }
    const result = await applyEnrichment(withDescription, client({
      description: 'Replacement.', tags: [], ingredients: [],
    }))
    expect(result.description).toBe('Original.')
  })

  it('drops tags that are not in the vocabulary', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null,
      tags: [
        { facet: 'course', value: 'bread' },
        { facet: 'course', value: 'brunch-thing' },
        { facet: 'nonsense', value: 'x' },
      ],
      ingredients: [],
    }))
    expect(result.tags).toEqual([{ facet: 'course', value: 'bread' }])
  })

  it('does not duplicate tags already present', async () => {
    const tagged = { ...recipe, tags: [{ facet: 'course' as const, value: 'bread' }] }
    const result = await applyEnrichment(tagged, client({
      description: null, tags: [{ facet: 'course', value: 'bread' }], ingredients: [],
    }))
    expect(result.tags).toHaveLength(1)
  })

  it('returns the recipe unchanged when the response fails validation', async () => {
    const result = await applyEnrichment(recipe, client({ garbage: true }))
    expect(result).toEqual(recipe)
  })

  it('returns the recipe unchanged when the call throws', async () => {
    const failing: LlmClient = {
      enrich: vi.fn().mockRejectedValue(new Error('rate limited')),
      extractRecipe: vi.fn(),
    }
    const result = await applyEnrichment(recipe, failing)
    expect(result).toEqual(recipe)
  })

  it('ignores ingredient entries pointing at positions that do not exist', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null, tags: [],
      ingredients: [{ position: 99, quantity: 2, unit: 'cup', item: 'flour', note: null }],
    }))
    expect(result.ingredients[0].quantity).toBeNull()
  })
})

describe('applyEnrichment tag canonicalization', () => {
  it('slugs open-vocabulary tag values so variants collapse to one', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null,
      tags: [
        { facet: 'tag', value: 'Meal Prep' },
        { facet: 'tag', value: 'meal-prep' },
        { facet: 'tag', value: 'Weeknight Dinner (Easy!)' },
      ],
      ingredients: [],
    }))

    expect(result.tags).toEqual([
      { facet: 'tag', value: 'meal-prep' },
      { facet: 'tag', value: 'weeknight-dinner-easy' },
    ])
  })

  it('drops a tag value that is blank or slugs to nothing', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null,
      tags: [{ facet: 'tag', value: '   ' }, { facet: 'tag', value: '!!!' }],
      ingredients: [],
    }))
    expect(result.tags).toEqual([])
  })

  it('does not slug values on the closed facets', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null,
      tags: [{ facet: 'method', value: 'slow-cooker' }, { facet: 'course', value: 'Main' }],
      ingredients: [],
    }))
    expect(result.tags).toEqual([{ facet: 'method', value: 'slow-cooker' }])
  })
})
