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
})
