import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { extract } from './index'
import type { LlmClient } from './llm-types'

/**
 * Regression tests against real, frozen pages captured by
 * `npm run extract -- <url> <path> --no-llm` (see scripts/extract-url.ts).
 *
 * The fixtures are gzipped (`.html.gz`) because the source pages -- especially
 * Bon Appétit's -- run over a megabyte raw. Each is decompressed on the fly with
 * `zlib.gunzipSync`; nothing here touches the network or an LLM.
 *
 * Fixtures are generated locally and may not exist on every machine (there is no
 * live-fetch step in CI). Each test is guarded with `it.runIf(existsSync(...))`
 * so the suite still passes -- by skipping -- when a given fixture is absent.
 *
 * `__dirname` is unavailable under Vitest's ESM transform, hence the
 * `fileURLToPath(new URL(...))` resolution.
 */
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))

const noopLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

function fixturePath(name: string): string {
  return `${FIXTURES_DIR}${name}.html.gz`
}

function loadFixture(name: string): string {
  return gunzipSync(readFileSync(fixturePath(name))).toString('utf-8')
}

describe('fixtures: bonappetit.com/recipe/bas-best-bolognese', () => {
  const name = 'bonappetit-bolognese'
  const url = 'https://www.bonappetit.com/recipe/bas-best-bolognese'

  it.runIf(existsSync(fixturePath(name)))('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Best Bolognese')
    expect(result.author).toBe('Andy Baraghani')
    expect(result.servings).toBe(4)
    expect(result.ingredients).toHaveLength(15)
    expect(result.steps).toHaveLength(8)
    expect(result.ingredients[0].rawText).toBe('1 medium onion, chopped')
    expect(result.steps[0].text).toContain('Pulse 1 medium onion, chopped')

    // Bon Appétit's JSON-LD serves totalTime as free-text ("3 hours") rather than
    // an ISO 8601 duration ("PT3H"), so the strict schema.org parser in
    // duration.ts correctly yields null here -- this is real upstream data, not
    // a malformed fixture, and documents a known gap: real cook times are lost
    // for Condé Nast recipes.
    expect(result.claimedTimeMinutes).toBeNull()

    expect(result.heroImageUrl).toMatch(/^https:\/\/assets\.bonappetit\.com\//)
    expect(result.tags).toContainEqual({ facet: 'cuisine', value: 'italian' })
    expect(result.tags).toContainEqual({ facet: 'course', value: 'main' })

    // Confirmed by manual inspection: for this page, Readability's output is not
    // narrative prose. Bon Appétit's recipe-card markup matches none of
    // narrative.ts's RECIPE_CARD_SELECTORS, so the full step-by-step
    // instructions survive into "narrative" and duplicate the structured
    // extraction verbatim (formatted as "<h4>Step 1</h4>..."). Asserting the
    // presence of that duplication here pins the known-bad behavior so a future
    // fix to narrative.ts's selector list shows up as a meaningful test change
    // rather than silent drift.
    expect(result.narrativeHtml).toContain('Step 1')
    expect(result.narrativeHtml).toContain('Pulse')
  })
})

describe('fixtures: bonappetit.com/recipe/slow-roast-gochujang-chicken', () => {
  const name = 'bonappetit-gochujang-chicken'
  const url = 'https://www.bonappetit.com/recipe/slow-roast-gochujang-chicken'

  it.runIf(existsSync(fixturePath(name)))('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Slow-Roast Gochujang Chicken')
    expect(result.servings).toBe(4)
    expect(result.ingredients).toHaveLength(11)
    expect(result.steps).toHaveLength(11)
    expect(result.claimedTimeMinutes).toBeNull() // same free-text totalTime issue

    expect(result.heroImageUrl).toMatch(/^https:\/\/assets\.bonappetit\.com\//)
    expect(result.tags).toContainEqual({ facet: 'cuisine', value: 'korean' })
    expect(result.tags).toContainEqual({ facet: 'ingredient', value: 'chicken' })
  })
})

describe('fixtures: bonappetit.com/recipe/cheesy-cabbage-gratin', () => {
  const name = 'bonappetit-cabbage-gratin'
  const url = 'https://www.bonappetit.com/recipe/cheesy-cabbage-gratin'

  it.runIf(existsSync(fixturePath(name)))('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Cheesy Cabbage Gratin')
    expect(result.servings).toBe(8)
    expect(result.ingredients).toHaveLength(11)
    expect(result.steps).toHaveLength(5)
    expect(result.heroImageUrl).toMatch(/^https:\/\/assets\.bonappetit\.com\//)
    expect(result.tags).toContainEqual({ facet: 'ingredient', value: 'cheese' })

    // Confirmed by manual inspection: unlike a genuine narrative, this "content"
    // is the whole recipe-page DOM -- publish date, star rating, ingredient
    // list, and full instructions -- because none of narrative.ts's card
    // selectors match Bon Appétit's markup. The single real editorial sentence
    // on the page is buried inside it.
    expect(result.narrativeHtml).toContain(
      'Every editor who claimed this cheesy gratin would be',
    )
    expect(result.narrativeHtml).toContain('Step 1')
  })
})

describe('fixtures: easyweeknightrecipes.com/homemade-flatbread-recipe', () => {
  const name = 'easyweeknightrecipes-flatbread'
  const url = 'https://www.easyweeknightrecipes.com/homemade-flatbread-recipe/'

  it.runIf(existsSync(fixturePath(name)))('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Homemade Flatbread Recipe')
    expect(result.servings).toBe(10)
    expect(result.claimedTimeMinutes).toBe(60)
    expect(result.ingredients).toHaveLength(12)
    expect(result.steps).toHaveLength(9)
    expect(result.heroImageUrl).toBe(
      'https://easyweeknightrecipes.com/wp-content/uploads/2020/04/Flatbread-4.jpg',
    )
    expect(result.tags).toContainEqual({ facet: 'course', value: 'bread' })

    // WordPress Recipe Maker markup matches narrative.ts's selectors, so unlike
    // the Bon Appétit fixtures, the narrative here is genuinely prose -- no
    // recipe-step or ingredient-list duplication.
    expect(result.narrativeHtml).toContain('cherished comfort food')
    expect(result.narrativeHtml).not.toContain('Step 1')
  })
})

describe('fixtures: cafedelites.com/creamy-garlic-butter-tuscan-shrimp', () => {
  const name = 'cafedelites-tuscan-shrimp'
  const url = 'https://cafedelites.com/creamy-garlic-butter-tuscan-shrimp/'

  it.runIf(existsSync(fixturePath(name)))('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Creamy Garlic Butter Tuscan Shrimp')
    expect(result.servings).toBe(4)
    expect(result.claimedTimeMinutes).toBe(20)
    expect(result.ingredients).toHaveLength(15)
    expect(result.steps).toHaveLength(6)
    expect(result.ingredients[0].rawText).toContain('salted butter')
    expect(result.steps[0].text).toContain('Heat a large skillet')
    expect(result.heroImageUrl).toBe(
      'https://cafedelites.com/wp-content/uploads/2017/12/Tuscan-Shrimp-IMAGE-1.jpg',
    )
    expect(result.tags).toContainEqual({ facet: 'ingredient', value: 'seafood' })

    expect(result.narrativeHtml).toContain('Tuscan Butter Shrimp')
    expect(result.narrativeHtml).not.toContain('Step 1')
  })
})
