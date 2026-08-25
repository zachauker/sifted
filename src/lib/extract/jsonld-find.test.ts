import { describe, it, expect } from 'vitest'
import { findRecipeNode } from './jsonld-find'

function page(json: string): string {
  return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`
}

describe('findRecipeNode', () => {
  it('finds a bare Recipe object', () => {
    const node = findRecipeNode(page('{"@type":"Recipe","name":"Flatbread"}'))
    expect(node?.name).toBe('Flatbread')
  })

  it('finds a Recipe inside a top-level array', () => {
    const node = findRecipeNode(page('[{"@type":"WebSite"},{"@type":"Recipe","name":"Korma"}]'))
    expect(node?.name).toBe('Korma')
  })

  it('finds a Recipe inside @graph, where WP Recipe Maker puts it', () => {
    const node = findRecipeNode(
      page('{"@context":"https://schema.org","@graph":[{"@type":"Article"},{"@type":"Recipe","name":"Focaccia"}]}'),
    )
    expect(node?.name).toBe('Focaccia')
  })

  it('matches when @type is an array', () => {
    const node = findRecipeNode(page('{"@type":["Recipe","NewsArticle"],"name":"Katsu"}'))
    expect(node?.name).toBe('Katsu')
  })

  it('skips scripts containing invalid JSON and keeps looking', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ not json }</script>
      <script type="application/ld+json">{"@type":"Recipe","name":"Mahi Mahi"}</script>
    </head><body></body></html>`
    expect(findRecipeNode(html)?.name).toBe('Mahi Mahi')
  })

  it('returns null when there is no Recipe node', () => {
    expect(findRecipeNode(page('{"@type":"BlogPosting","name":"Story"}'))).toBeNull()
  })

  it('returns null when there is no JSON-LD at all', () => {
    expect(findRecipeNode('<html><body><h1>Hi</h1></body></html>')).toBeNull()
  })
})
