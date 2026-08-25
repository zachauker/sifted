import { describe, it, expect, vi } from 'vitest'
import { extract } from './index'
import type { LlmClient } from './llm-types'

const noopLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

const jsonLdPage = `<html><head><script type="application/ld+json">
  {"@type":"Recipe","name":"Egg Korma","recipeIngredient":["2 eggs"],
   "recipeInstructions":[{"@type":"HowToStep","text":"Boil the eggs."}],
   "totalTime":"PT50M","recipeCategory":"Main Course"}
</script></head><body>
  <article><p>${'A long story about eggs that goes on for a while. '.repeat(12)}</p></article>
</body></html>`

describe('extract', () => {
  it('uses JSON-LD when present', async () => {
    const result = await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm: noopLlm })
    expect(result.title).toBe('Egg Korma')
    expect(result.extractionMethod).toBe('jsonld')
    expect(result.claimedTimeMinutes).toBe(50)
  })

  it('attaches the narrative separately from the recipe', async () => {
    const result = await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm: noopLlm })
    expect(result.narrativeHtml).toContain('A long story about eggs')
    expect(result.steps[0].text).toBe('Boil the eggs.')
  })

  it('falls back to the LLM when there is no structured data', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue(null),
      extractRecipe: vi.fn().mockResolvedValue({
        title: 'Grandma Peanut Dip',
        description: null,
        author: null,
        claimedTimeMinutes: 10,
        servings: 4,
        yieldText: '4 servings',
        ingredients: ['1 cup peanuts'],
        steps: ['Blend everything.'],
      }),
    }

    const result = await extract({
      url: 'https://example.com/dip',
      html: '<html><body><article><p>No structured data here at all.</p></article></body></html>',
      llm,
    })

    expect(result.title).toBe('Grandma Peanut Dip')
    expect(result.extractionMethod).toBe('llm')
    expect(result.ingredients[0].rawText).toBe('1 cup peanuts')
    expect(llm.extractRecipe).toHaveBeenCalledOnce()
  })

  it('throws a NoRecipeFoundError when neither path finds a recipe', async () => {
    await expect(
      extract({ url: 'https://example.com/x', html: '<html><body>nothing</body></html>', llm: noopLlm }),
    ).rejects.toThrow(/no recipe found/i)
  })

  it('never calls the LLM extractor when JSON-LD succeeds', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue(null),
      extractRecipe: vi.fn(),
    }
    await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm })
    expect(llm.extractRecipe).not.toHaveBeenCalled()
  })

  it('runs enrichment on the JSON-LD path', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue({
        description: 'A rich egg curry.',
        tags: [{ facet: 'cuisine', value: 'indian' }],
        ingredients: [{ position: 0, quantity: 2, unit: null, item: 'eggs', note: null }],
      }),
      extractRecipe: vi.fn(),
    }

    const result = await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm })
    expect(result.description).toBe('A rich egg curry.')
    expect(result.tags).toContainEqual({ facet: 'cuisine', value: 'indian' })
    expect(result.ingredients[0].quantity).toBe(2)
  })

  it('uses microdata when JSON-LD is absent, without calling the LLM', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue(null),
      extractRecipe: vi.fn(),
    }
    const html = `<html><body>
      <div itemscope itemtype="http://schema.org/Recipe">
        <h1 itemprop="name">KC Barbecue Sauce</h1>
        <li itemprop="recipeIngredient">2 cups ketchup</li>
      </div></body></html>`

    const result = await extract({ url: 'https://example.com/sauce', html, llm })
    expect(result.extractionMethod).toBe('microdata')
    expect(llm.extractRecipe).not.toHaveBeenCalled()
  })
})

/**
 * The parsers only ever see `html`, so a page that writes its hero image as a
 * relative path yields a bare path that no downstream image-downloader can use.
 * The orchestrator knows the page URL, so it is the one place that can resolve
 * every extraction path at once.
 */
describe('extract: hero image URL resolution', () => {
  function jsonLdPageWithImage(image: unknown): string {
    return `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'Recipe',
      name: 'Egg Korma',
      image,
      recipeIngredient: ['2 eggs'],
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Boil the eggs.' }],
    })}</script></head><body><p>hi</p></body></html>`
  }

  async function heroFor(image: unknown, url = 'https://example.com/recipes/korma'): Promise<string | null> {
    const result = await extract({ url, html: jsonLdPageWithImage(image), llm: noopLlm })
    return result.heroImageUrl
  }

  it('passes an absolute URL through unchanged', async () => {
    expect(await heroFor('https://cdn.example.org/img/korma.jpg')).toBe(
      'https://cdn.example.org/img/korma.jpg',
    )
  })

  it('resolves a root-relative path against the page URL', async () => {
    expect(await heroFor('/img/korma.jpg')).toBe('https://example.com/img/korma.jpg')
  })

  it('resolves a document-relative path against the page URL', async () => {
    expect(await heroFor('img/korma.jpg')).toBe('https://example.com/recipes/img/korma.jpg')
  })

  it('resolves a parent-relative path against the page URL', async () => {
    expect(await heroFor('../img/korma.jpg', 'https://example.com/recipes/indian/korma')).toBe(
      'https://example.com/recipes/img/korma.jpg',
    )
  })

  it('resolves a protocol-relative URL to the page scheme', async () => {
    expect(await heroFor('//cdn.example.com/korma.jpg', 'http://example.com/recipes/korma')).toBe(
      'http://cdn.example.com/korma.jpg',
    )
    expect(await heroFor('//cdn.example.com/korma.jpg', 'https://example.com/recipes/korma')).toBe(
      'https://cdn.example.com/korma.jpg',
    )
  })

  it('passes a data: URI through unchanged', async () => {
    const dataUri = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    expect(await heroFor(dataUri)).toBe(dataUri)
  })

  it('yields null for a value that cannot be resolved', async () => {
    expect(await heroFor('http://')).toBeNull()
  })

  it('leaves a missing image as null', async () => {
    expect(await heroFor(undefined)).toBeNull()
  })

  it('resolves a relative microdata image too', async () => {
    const html = `<html><body>
      <div itemscope itemtype="http://schema.org/Recipe">
        <h1 itemprop="name">KC Barbecue Sauce</h1>
        <img itemprop="image" src="/img/sauce.jpg">
        <li itemprop="recipeIngredient">2 cups ketchup</li>
      </div></body></html>`

    const result = await extract({ url: 'https://example.com/bbq/sauce', html, llm: noopLlm })
    expect(result.heroImageUrl).toBe('https://example.com/img/sauce.jpg')
  })
})
