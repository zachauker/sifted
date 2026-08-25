import { describe, it, expect } from 'vitest'
import { normalizeTag, isValidTag, normalizeTags } from './index'

describe('normalizeTag', () => {
  it('maps a course name to the course facet', () => {
    expect(normalizeTag('Main Course')).toEqual({ facet: 'course', value: 'main' })
  })

  it('is case- and separator-insensitive', () => {
    expect(normalizeTag('main-course')).toEqual({ facet: 'course', value: 'main' })
    expect(normalizeTag('  MAIN COURSE ')).toEqual({ facet: 'course', value: 'main' })
  })

  it('maps ingredients to the ingredient facet', () => {
    expect(normalizeTag('Seafood')).toEqual({ facet: 'ingredient', value: 'seafood' })
    expect(normalizeTag('Poultry')).toEqual({ facet: 'ingredient', value: 'chicken' })
  })

  it('maps cooking methods to the method facet', () => {
    expect(normalizeTag('Grill')).toEqual({ facet: 'method', value: 'grill' })
  })

  it('maps cuisines to the cuisine facet', () => {
    expect(normalizeTag('Mediterranean')).toEqual({ facet: 'cuisine', value: 'mediterranean' })
  })

  it('corrects the legacy Sandwhich typo', () => {
    expect(normalizeTag('Sandwhich')).toEqual({ facet: 'tag', value: 'sandwich' })
  })

  it('drops non-food tags from the legacy Notion vocabulary', () => {
    expect(normalizeTag('Docker')).toBeNull()
    expect(normalizeTag('MF DOOM')).toBeNull()
    expect(normalizeTag('ADHD')).toBeNull()
  })

  it('drops Dinner, which carries no information', () => {
    expect(normalizeTag('Dinner')).toBeNull()
  })

  it('returns null for anything unrecognized', () => {
    expect(normalizeTag('asdfqwer')).toBeNull()
  })
})

describe('isValidTag', () => {
  it('accepts a legal facet/value pair', () => {
    expect(isValidTag({ facet: 'course', value: 'main' })).toBe(true)
  })

  it('rejects a value that is not in the vocabulary', () => {
    expect(isValidTag({ facet: 'course', value: 'brunch' })).toBe(false)
  })

  it('accepts any value on the open tag facet', () => {
    expect(isValidTag({ facet: 'tag', value: 'thanksgiving' })).toBe(true)
  })
})

describe('normalizeTags', () => {
  it('dedupes by facet:value', () => {
    expect(normalizeTags(['Main Course', 'main dish', 'ENTREE'])).toEqual([
      { facet: 'course', value: 'main' },
    ])
  })

  it('filters out dropped tags', () => {
    expect(normalizeTags(['Dinner', 'Docker', 'Chicken'])).toEqual([
      { facet: 'ingredient', value: 'chicken' },
    ])
  })

  it('filters out unrecognized tags', () => {
    expect(normalizeTags(['asdfqwer', 'Chicken'])).toEqual([
      { facet: 'ingredient', value: 'chicken' },
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(normalizeTags([])).toEqual([])
  })

  it('returns an empty array for undefined input', () => {
    expect(normalizeTags(undefined)).toEqual([])
  })
})

describe('correctness fixes', () => {
  it('does not resolve Object.prototype members through the alias table', () => {
    expect(normalizeTag('constructor')).toBeNull()
  })

  it('returns null instead of throwing for non-string input', () => {
    expect(normalizeTag(5 as never)).toBeNull()
  })

  it('returns false instead of throwing for a prototype-named facet', () => {
    expect(isValidTag({ facet: 'toString' as never, value: 'main' })).toBe(false)
  })

  it('freezes the tag objects it hands out, so callers cannot mutate shared aliases', () => {
    expect(Object.isFrozen(normalizeTag('Poultry'))).toBe(true)
  })

  it('files Baking under the oven method, not dessert', () => {
    expect(normalizeTag('Baking')).toEqual({ facet: 'method', value: 'oven' })
  })

  it('maps Grains to its own ingredient value, not rice', () => {
    expect(normalizeTag('Grains')).toEqual({ facet: 'ingredient', value: 'grain' })
  })

  it('strips a trailing "Recipes" suffix', () => {
    expect(normalizeTag('Chicken Recipes')).toEqual({ facet: 'ingredient', value: 'chicken' })
  })

  it('prefers an exact alias over suffix-stripping', () => {
    expect(normalizeTag('Dinner Recipes')).toEqual({ facet: 'course', value: 'main' })
  })

  it('resolves the singular "Dinner Recipe" the same as the plural', () => {
    expect(normalizeTag('Dinner Recipe')).toEqual({ facet: 'course', value: 'main' })
  })

  it('resolves an "&" joiner', () => {
    expect(normalizeTag('Soups & Stews')).toEqual({ facet: 'tag', value: 'soup' })
  })

  it('resolves the singular "Soup & Stew" compound, not just the plural', () => {
    expect(normalizeTag('Soup & Stew')).toEqual({ facet: 'tag', value: 'soup' })
  })
})
