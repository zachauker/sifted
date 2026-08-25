import { describe, it, expect } from 'vitest'
import { normalizeTag, isValidTag, COURSE_VALUES } from './index'

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

  it('exposes the course vocabulary', () => {
    expect(COURSE_VALUES).toContain('dessert')
  })
})
