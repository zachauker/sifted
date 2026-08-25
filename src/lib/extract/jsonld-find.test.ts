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

  it('matches a fully-qualified https://schema.org/Recipe @type', () => {
    const node = findRecipeNode(page('{"@type":"https://schema.org/Recipe","name":"Qualified Https"}'))
    expect(node?.name).toBe('Qualified Https')
  })

  it('matches a fully-qualified http://schema.org/Recipe @type', () => {
    const node = findRecipeNode(page('{"@type":"http://schema.org/Recipe","name":"Qualified Http"}'))
    expect(node?.name).toBe('Qualified Http')
  })

  it('still rejects lowercase @type values after normalization', () => {
    expect(findRecipeNode(page('{"@type":"recipe","name":"lowercase"}'))).toBeNull()
  })

  it('finds a Recipe nested under mainEntity', () => {
    const node = findRecipeNode(
      page('{"@type":"WebPage","mainEntity":{"@type":"Recipe","name":"MainEntity Recipe"}}'),
    )
    expect(node?.name).toBe('MainEntity Recipe')
  })

  it('finds a Recipe nested under mainEntityOfPage', () => {
    const node = findRecipeNode(
      page('{"@type":"WebPage","mainEntityOfPage":{"@type":"Recipe","name":"MainEntityOfPage Recipe"}}'),
    )
    expect(node?.name).toBe('MainEntityOfPage Recipe')
  })

  it('does NOT descend into unrelated properties such as about', () => {
    const node = findRecipeNode(
      page('{"@type":"WebPage","about":{"@type":"Recipe","name":"Should Not Be Found"}}'),
    )
    expect(node).toBeNull()
  })

  it('finds a Recipe wrapped in an HTML comment guard', () => {
    const html = `<html><head><script type="application/ld+json"><!--{"@type":"Recipe","name":"Commented"}--></script></head><body></body></html>`
    expect(findRecipeNode(html)?.name).toBe('Commented')
  })

  it('finds a Recipe wrapped in a CDATA guard', () => {
    const html = `<html><head><script type="application/ld+json">//<![CDATA[\n{"@type":"Recipe","name":"CDATA Wrapped"}\n//]]></script></head><body></body></html>`
    expect(findRecipeNode(html)?.name).toBe('CDATA Wrapped')
  })

  it('still returns null for genuinely malformed JSON without throwing, wrapper or not', () => {
    const html = `<html><head><script type="application/ld+json"><!--{ not json }--></script></head><body></body></html>`
    expect(() => findRecipeNode(html)).not.toThrow()
    expect(findRecipeNode(html)).toBeNull()
  })
})
