import { describe, it, expect } from 'vitest'
import { fromMicrodata } from './microdata'

const page = `<html><body>
  <div itemscope itemtype="http://schema.org/Recipe">
    <h1 itemprop="name">Kansas City Barbecue Sauce</h1>
    <span itemprop="author">Elise Bauer</span>
    <meta itemprop="totalTime" content="PT40M">
    <span itemprop="recipeYield">2 cups</span>
    <span itemprop="recipeCategory">Sauce</span>
    <img itemprop="image" src="https://example.com/sauce.jpg">
    <li itemprop="recipeIngredient">2 cups ketchup</li>
    <li itemprop="recipeIngredient">1/4 cup brown sugar</li>
    <li itemprop="recipeInstructions">Simmer everything for 30 minutes.</li>
  </div>
</body></html>`

describe('fromMicrodata', () => {
  it('maps the core fields', () => {
    const r = fromMicrodata(page)
    expect(r?.title).toBe('Kansas City Barbecue Sauce')
    expect(r?.author).toBe('Elise Bauer')
    expect(r?.claimedTimeMinutes).toBe(40)
    expect(r?.yieldText).toBe('2 cups')
    expect(r?.extractionMethod).toBe('microdata')
  })

  it('reads meta content attributes rather than their empty text', () => {
    expect(fromMicrodata(page)?.claimedTimeMinutes).toBe(40)
  })

  it('reads the src attribute for images', () => {
    expect(fromMicrodata(page)?.heroImageUrl).toBe('https://example.com/sauce.jpg')
  })

  it('collects ingredients and steps in document order', () => {
    const r = fromMicrodata(page)
    expect(r?.ingredients.map((i) => i.rawText)).toEqual(['2 cups ketchup', '1/4 cup brown sugar'])
    expect(r?.steps.map((s) => s.text)).toEqual(['Simmer everything for 30 minutes.'])
  })

  it('normalizes the category into a facet tag', () => {
    expect(fromMicrodata(page)?.tags).toContainEqual({ facet: 'course', value: 'sauce' })
  })

  it('returns null when there is no Recipe itemscope', () => {
    expect(fromMicrodata('<html><body><p>nothing</p></body></html>')).toBeNull()
  })

  it('returns null when the itemscope has no name', () => {
    const nameless = '<div itemscope itemtype="http://schema.org/Recipe"><p>x</p></div>'
    expect(fromMicrodata(nameless)).toBeNull()
  })

  it('prefers the visible text of a linked byline over its href', () => {
    const linkedAuthor = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Linked Author Test</span>
      <a itemprop="author" href="/author/elise">Elise Bauer</a>
    </div>`
    expect(fromMicrodata(linkedAuthor)?.author).toBe('Elise Bauer')
  })

  it('still reads a meta content attribute for a text-valued property', () => {
    const metaAuthor = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Meta Author Test</span>
      <meta itemprop="author" content="Elise Bauer">
    </div>`
    expect(fromMicrodata(metaAuthor)?.author).toBe('Elise Bauer')
  })

  it('still reads the src attribute for image, a reference property', () => {
    const img = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Image Reference Test</span>
      <img itemprop="image" src="https://example.com/sauce.jpg">
    </div>`
    expect(fromMicrodata(img)?.heroImageUrl).toBe('https://example.com/sauce.jpg')
  })

  it('splits a recipeInstructions wrapper containing multiple paragraphs into one step each', () => {
    const paragraphs = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Paragraph Steps Test</span>
      <div itemprop="recipeInstructions">
        <p>Step one.</p>
        <p>Step two.</p>
        <p>Step three.</p>
      </div>
    </div>`
    expect(fromMicrodata(paragraphs)?.steps.map((s) => s.text)).toEqual([
      'Step one.',
      'Step two.',
      'Step three.',
    ])
  })

  it('splits a recipeInstructions wrapper containing an ordered list into one step per item', () => {
    const list = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">List Steps Test</span>
      <div itemprop="recipeInstructions">
        <ol>
          <li>Step one.</li>
          <li>Step two.</li>
        </ol>
      </div>
    </div>`
    expect(fromMicrodata(list)?.steps.map((s) => s.text)).toEqual(['Step one.', 'Step two.'])
  })

  it('keeps a single step when recipeInstructions has no block-level children', () => {
    const plain = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Plain Text Step Test</span>
      <span itemprop="recipeInstructions">Simmer everything for 30 minutes.</span>
    </div>`
    expect(fromMicrodata(plain)?.steps.map((s) => s.text)).toEqual([
      'Simmer everything for 30 minutes.',
    ])
  })

  it('splits a single comma-separated keywords meta value into individual tags', () => {
    const html = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Comma Keywords Test</span>
      <meta itemprop="keywords" content="italian, pasta, one pot">
    </div>`
    const r = fromMicrodata(html)
    expect(r?.tags).toEqual(
      expect.arrayContaining([
        { facet: 'cuisine', value: 'italian' },
        { facet: 'ingredient', value: 'pasta' },
        { facet: 'tag', value: 'one-pot' },
      ])
    )
    expect(r?.tags).toHaveLength(3)
  })

  it('splits a single comma-separated recipeCategory meta value into individual tags', () => {
    const html = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Comma Category Test</span>
      <meta itemprop="recipeCategory" content="Main Course, Dinner">
    </div>`
    expect(fromMicrodata(html)?.tags).toContainEqual({ facet: 'course', value: 'main' })
  })

  it('resolves servings from dozen- and zero-based yields consistently', () => {
    const yieldPage = (yieldText: string) => `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Yield Test</span>
      <span itemprop="recipeYield">${yieldText}</span>
    </div>`
    expect(fromMicrodata(yieldPage('1 dozen'))?.servings).toBe(12)
    expect(fromMicrodata(yieldPage('2 dozen cookies'))?.servings).toBe(24)
    expect(fromMicrodata(yieldPage('0 servings'))?.servings).toBeNull()
  })

  it('falls back to prepTime + cookTime when totalTime is absent', () => {
    const html = `<div itemscope itemtype="http://schema.org/Recipe">
      <span itemprop="name">Time Fallback Test</span>
      <meta itemprop="prepTime" content="PT10M">
      <meta itemprop="cookTime" content="PT25M">
    </div>`
    expect(fromMicrodata(html)?.claimedTimeMinutes).toBe(35)
  })
})
