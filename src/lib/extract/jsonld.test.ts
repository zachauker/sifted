import { describe, it, expect } from 'vitest'
import { fromJsonLd } from './jsonld'
import type { JsonLdNode } from './jsonld-find'

const base: JsonLdNode = {
  '@type': 'Recipe',
  name: 'Homemade Flatbread with Yogurt',
  description: 'Soft, fluffy, tangy flatbread.',
  author: { '@type': 'Person', name: 'Katerina' },
  publisher: { '@type': 'Organization', name: 'Easy Weeknight Recipes' },
  totalTime: 'PT35M',
  recipeYield: '10 flatbreads',
  recipeCategory: 'Bread',
  recipeCuisine: ['Macedonian', 'Mediterranean'],
  keywords: 'flatbread recipe, stovetop',
  image: 'https://example.com/flatbread.jpg',
  recipeIngredient: ['1¼ cups lukewarm water', '¾ cups plain yogurt'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Whisk water, yeast, and sugar.' },
    { '@type': 'HowToStep', text: 'Knead for 4 minutes.' },
  ],
}

describe('fromJsonLd', () => {
  it('maps the core fields', () => {
    const r = fromJsonLd(base)
    expect(r.title).toBe('Homemade Flatbread with Yogurt')
    expect(r.description).toBe('Soft, fluffy, tangy flatbread.')
    expect(r.author).toBe('Katerina')
    expect(r.publisher).toBe('Easy Weeknight Recipes')
    expect(r.claimedTimeMinutes).toBe(35)
    expect(r.extractionMethod).toBe('jsonld')
  })

  it('extracts servings from a yield string and keeps the original text', () => {
    const r = fromJsonLd(base)
    expect(r.servings).toBe(10)
    expect(r.yieldText).toBe('10 flatbreads')
  })

  it('preserves ingredient lines verbatim and numbers them', () => {
    const r = fromJsonLd(base)
    expect(r.ingredients).toHaveLength(2)
    expect(r.ingredients[0]).toEqual({
      position: 0, section: null, rawText: '1¼ cups lukewarm water',
      quantity: null, unit: null, item: null, note: null,
    })
  })

  it('parses dozen-based yields as 12x, keeping bare-digit and range parsing intact', () => {
    expect(fromJsonLd({ ...base, recipeYield: '1 dozen' }).servings).toBe(12)
    expect(fromJsonLd({ ...base, recipeYield: '2 dozen cookies' }).servings).toBe(24)
    expect(fromJsonLd({ ...base, recipeYield: 'a dozen rolls' }).servings).toBe(12)
    expect(fromJsonLd({ ...base, recipeYield: '24 cookies' }).servings).toBe(24)
    expect(fromJsonLd({ ...base, recipeYield: 'Serves 4 to 6' }).servings).toBe(4)
  })

  it('maps HowToStep instructions to steps', () => {
    const r = fromJsonLd(base)
    expect(r.steps.map((s) => s.text)).toEqual([
      'Whisk water, yeast, and sugar.',
      'Knead for 4 minutes.',
    ])
  })

  it('flattens HowToSection instructions and records the section name', () => {
    const r = fromJsonLd({
      ...base,
      recipeInstructions: [
        {
          '@type': 'HowToSection',
          name: 'For the dough',
          itemListElement: [{ '@type': 'HowToStep', text: 'Mix the flour.' }],
        },
        {
          '@type': 'HowToSection',
          name: 'To cook',
          itemListElement: [{ '@type': 'HowToStep', text: 'Fry each round.' }],
        },
      ],
    })
    expect(r.steps).toEqual([
      { position: 0, section: 'For the dough', text: 'Mix the flour.' },
      { position: 1, section: 'To cook', text: 'Fry each round.' },
    ])
  })

  it('splits a plain-string instruction blob into steps', () => {
    const r = fromJsonLd({ ...base, recipeInstructions: 'Mix it all.\nCook it well.' })
    expect(r.steps.map((s) => s.text)).toEqual(['Mix it all.', 'Cook it well.'])
  })

  it('normalizes category, cuisine, and keywords into facet tags', () => {
    const r = fromJsonLd(base)
    expect(r.tags).toContainEqual({ facet: 'course', value: 'bread' })
    expect(r.tags).toContainEqual({ facet: 'cuisine', value: 'mediterranean' })
    expect(r.tags).toContainEqual({ facet: 'method', value: 'stovetop' })
  })

  it('takes the first image from an array and unwraps ImageObject', () => {
    expect(fromJsonLd({ ...base, image: ['https://a.jpg', 'https://b.jpg'] }).heroImageUrl)
      .toBe('https://a.jpg')
    expect(fromJsonLd({ ...base, image: { '@type': 'ImageObject', url: 'https://c.jpg' } }).heroImageUrl)
      .toBe('https://c.jpg')
  })

  it('decodes HTML entities and strips tags from step text', () => {
    const r = fromJsonLd({
      ...base,
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Add <b>flour</b> &amp; salt.' }],
    })
    expect(r.steps[0].text).toBe('Add flour & salt.')
  })

  it('tolerates a node missing everything except a name', () => {
    const r = fromJsonLd({ '@type': 'Recipe', name: 'Bare' })
    expect(r.title).toBe('Bare')
    expect(r.ingredients).toEqual([])
    expect(r.steps).toEqual([])
    expect(r.claimedTimeMinutes).toBeNull()
  })
})
