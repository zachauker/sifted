import { describe, it, expect } from 'vitest'
import { unwrapLink, mapNotionRow } from '@/lib/notion/map'
import type { NotionRecipeRow } from '@/lib/notion/types'
import fixtures from './fixtures/rows.json'

const base: NotionRecipeRow = {
  pageId: 'page-1',
  title: 'HOMEMADE WHITE BREAD',
  link: 'https://butterwithasideofbread.com/homemade-bread/',
  publisher: 'Butter with a Side of Bread',
  author: null,
  rating: 5,
  cookingStatus: 'Made It',
  tags: ['Bread', 'Appetizer', 'Side Dish'],
  createdTime: '2020-12-20 00:59:34Z',
}

describe('unwrapLink', () => {
  it('unwraps a markdown link, which 38% of the library uses', () => {
    expect(unwrapLink('[https://food.com/r/1](https://food.com/r/1)')).toBe('https://food.com/r/1')
  })

  it('prefers the target when the label differs', () => {
    expect(unwrapLink('[Oatmeal Cookies](https://food.com/r/1)')).toBe('https://food.com/r/1')
  })

  it('leaves a bare url alone', () => {
    expect(unwrapLink('https://food.com/r/1')).toBe('https://food.com/r/1')
  })

  it('trims surrounding whitespace', () => {
    expect(unwrapLink('  https://food.com/r/1  ')).toBe('https://food.com/r/1')
  })

  it('returns null for null, empty, or whitespace', () => {
    expect(unwrapLink(null)).toBeNull()
    expect(unwrapLink('')).toBeNull()
    expect(unwrapLink('   ')).toBeNull()
  })

  it('returns null for a markdown link with an empty target', () => {
    expect(unwrapLink('[label]()')).toBeNull()
  })
})

describe('mapNotionRow', () => {
  it('carries the rating, status, and original creation date', () => {
    const m = mapNotionRow(base)
    expect(m.rating).toBe(5)
    expect(m.status).toBe('made_it')
    expect(m.createdAt.toISOString()).toBe('2020-12-20T00:59:34.000Z')
  })

  it('maps Want to Make and a blank status', () => {
    expect(mapNotionRow({ ...base, cookingStatus: 'Want to Make' }).status).toBe('want_to_make')
    expect(mapNotionRow({ ...base, cookingStatus: null }).status).toBeNull()
  })

  it('normalizes tags through the taxonomy and drops the rest', () => {
    const m = mapNotionRow({ ...base, tags: ['Bread', 'Dinner', 'Docker', 'Seafood'] })
    expect(m.tags).toContainEqual({ facet: 'course', value: 'bread' })
    expect(m.tags).toContainEqual({ facet: 'ingredient', value: 'seafood' })
    expect(m.tags.map((t) => t.value)).not.toContain('dinner')
    expect(m.tags.map((t) => t.value)).not.toContain('docker')
  })

  it('yields no tags for an untagged row rather than throwing', () => {
    expect(mapNotionRow({ ...base, tags: [] }).tags).toEqual([])
  })

  it('canonicalizes a markdown-wrapped url and extracts the domain', () => {
    const m = mapNotionRow({ ...base, link: '[https://www.food.com/r/1?utm_source=x](https://www.food.com/r/1?utm_source=x)' })
    expect(m.sourceUrl).toBe('https://food.com/r/1')
    expect(m.sourceDomain).toBe('food.com')
  })

  it('yields a null source url for a row with no link, without throwing', () => {
    const m = mapNotionRow({ ...base, link: null })
    expect(m.sourceUrl).toBeNull()
    expect(m.sourceDomain).toBeNull()
  })

  it('yields a null source url for a link that is not a url', () => {
    expect(mapNotionRow({ ...base, link: 'see the cookbook' }).sourceUrl).toBeNull()
  })

  it('keeps the Notion title and publisher for use when extraction fails', () => {
    const m = mapNotionRow(base)
    expect(m.notionTitle).toBe('HOMEMADE WHITE BREAD')
    expect(m.publisher).toBe('Butter with a Side of Bread')
  })

  it('handles the one titleless row in the library without throwing', () => {
    const m = mapNotionRow({ ...base, title: null, link: null, tags: [] })
    expect(m.notionTitle).toBeNull()
    expect(m.sourceUrl).toBeNull()
  })

  it('maps every committed real fixture row without throwing', () => {
    const rows = fixtures as NotionRecipeRow[]
    expect(rows.length).toBe(4)
    for (const row of rows) expect(() => mapNotionRow(row)).not.toThrow()
  })

  it('resolves the real markdown-wrapped fixture link', () => {
    const rows = fixtures as NotionRecipeRow[]
    const withMarkdown = rows.find((r) => r.link?.startsWith('['))!
    expect(mapNotionRow(withMarkdown).sourceUrl).toBe('https://food.com/recipe/oatmeal-raisin-cookies-35813')
  })
})
