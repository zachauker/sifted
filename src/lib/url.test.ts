import { describe, it, expect } from 'vitest'
import { normalizeSourceUrl } from './url'

describe('normalizeSourceUrl', () => {
  it('strips utm parameters', () => {
    const r = normalizeSourceUrl('https://www.bonappetit.com/recipe/egg-korma?utm_source=pocket&utm_medium=email')
    expect(r.url).toBe('https://bonappetit.com/recipe/egg-korma')
  })

  it('strips fragments and click ids', () => {
    const r = normalizeSourceUrl('https://example.com/r/x?fbclid=abc&gclid=def#jump-to-recipe')
    expect(r.url).toBe('https://example.com/r/x')
  })

  it('keeps meaningful query parameters', () => {
    const r = normalizeSourceUrl('https://example.com/r?id=42&utm_source=x')
    expect(r.url).toBe('https://example.com/r?id=42')
  })

  it('removes a trailing slash but preserves path case', () => {
    const r = normalizeSourceUrl('https://Example.com/Recipes/Flat-Bread/')
    expect(r.url).toBe('https://example.com/Recipes/Flat-Bread')
  })

  it('returns the bare domain without www', () => {
    const r = normalizeSourceUrl('https://www.easyweeknightrecipes.com/homemade-flatbread-recipe/')
    expect(r.domain).toBe('easyweeknightrecipes.com')
  })

  it('upgrades a bare host to https', () => {
    const r = normalizeSourceUrl('example.com/x')
    expect(r.url).toBe('https://example.com/x')
  })

  it('throws on input that is not a URL', () => {
    expect(() => normalizeSourceUrl('not a url at all')).toThrow(/invalid url/i)
  })
})
