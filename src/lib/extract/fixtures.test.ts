import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { extract } from './index'
import type { LlmClient } from './llm-types'
import type { ExtractedRecipe } from './types'

/**
 * Regression tests against real, frozen pages captured by
 * `npm run extract -- <url> <path> --no-llm` (see scripts/extract-url.ts).
 *
 * The fixtures are gzipped (`.html.gz`) because the source pages -- especially
 * Bon Appétit's -- run over a megabyte raw. Each is decompressed on the fly with
 * `zlib.gunzipSync`; nothing here touches the network or an LLM.
 *
 * The fixtures are committed to the repo, so a missing one is never an
 * environment difference worth silently skipping over -- it means a filename
 * typo, a `.gitattributes` mishap, or a sparse checkout quietly deleted this
 * entire real-page regression suite while the build stayed green. `beforeAll`
 * below asserts every expected fixture is present and fails loudly, by name,
 * if one is not, instead of the suite skipping tests one by one.
 *
 * `__dirname` is unavailable under Vitest's ESM transform, hence the
 * `fileURLToPath(new URL(...))` resolution.
 */
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))

const FIXTURE_NAMES = [
  'bonappetit-bolognese',
  'bonappetit-gochujang-chicken',
  'bonappetit-cabbage-gratin',
  'easyweeknightrecipes-flatbread',
  'cafedelites-tuscan-shrimp',
]

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

beforeAll(() => {
  const missing = FIXTURE_NAMES.filter((name) => !existsSync(fixturePath(name)))
  if (missing.length > 0) {
    throw new Error(
      `Missing fixture file(s), regenerate with \`npm run extract -- <url> <path> --no-llm\`: ` +
        missing.map(fixturePath).join(', '),
    )
  }
})

/**
 * The product promise is "recipe at the top, story collapsed at the bottom", so
 * the narrative must contain neither the steps nor the ingredient lines that were
 * already extracted into structured fields. Asserted against the recipe's own
 * output rather than hand-copied strings, so it keeps holding if a fixture is
 * refreshed.
 *
 * Also pins that the narrative was built against the real page URL rather than
 * the placeholder JSDOM base: a relative href/src resolving to `example.com`
 * would mean broken links and broken images shown inside the collapsed story.
 */
function expectNoRecipeDuplication(result: ExtractedRecipe): void {
  expect(result.narrativeHtml).not.toBeNull()
  expect(result.narrativeHtml).not.toContain('example.com')
  for (const step of result.steps) {
    expect(result.narrativeHtml).not.toContain(step.text)
  }
  for (const ingredient of result.ingredients) {
    expect(result.narrativeHtml).not.toContain(ingredient.rawText)
  }
}

describe('fixtures: bonappetit.com/recipe/bas-best-bolognese', () => {
  const name = 'bonappetit-bolognese'
  const url = 'https://www.bonappetit.com/recipe/bas-best-bolognese'

  it('extracts the full recipe from JSON-LD', async () => {
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
    // an ISO 8601 duration ("PT3H"). duration.ts's freeform fallback parses it.
    expect(result.claimedTimeMinutes).toBe(180)

    expect(result.heroImageUrl).toMatch(/^https:\/\/assets\.bonappetit\.com\//)
    expect(result.tags).toContainEqual({ facet: 'cuisine', value: 'italian' })
    expect(result.tags).toContainEqual({ facet: 'course', value: 'main' })

    // The narrative is the editor's headnote, not the recipe a second time.
    // Asserting the real prose is load-bearing: an empty narrative would satisfy
    // "contains no steps" while quietly throwing away the story this feature
    // exists to keep.
    expect(result.narrativeHtml).toContain('standout ragù alla Bolognese')
    expect(result.narrativeHtml).toContain('What it does take is patience')
    expect(result.narrativeHtml).not.toContain('Step 1')
    expectNoRecipeDuplication(result)
  })
})

describe('fixtures: bonappetit.com/recipe/slow-roast-gochujang-chicken', () => {
  const name = 'bonappetit-gochujang-chicken'
  const url = 'https://www.bonappetit.com/recipe/slow-roast-gochujang-chicken'

  it('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Slow-Roast Gochujang Chicken')
    expect(result.servings).toBe(4)
    expect(result.ingredients).toHaveLength(11)
    expect(result.steps).toHaveLength(11)
    // No data upstream, not a parser failure: this page's JSON-LD carries no
    // totalTime, prepTime, or cookTime at all.
    expect(result.claimedTimeMinutes).toBeNull()

    expect(result.heroImageUrl).toMatch(/^https:\/\/assets\.bonappetit\.com\//)
    expect(result.tags).toContainEqual({ facet: 'cuisine', value: 'korean' })
    expect(result.tags).toContainEqual({ facet: 'ingredient', value: 'chicken' })

    expect(result.narrativeHtml).toContain('crisp-skinned, high-heat roast chicken')
    expect(result.narrativeHtml).toContain('nearly-confited potatoes')
    expect(result.narrativeHtml).not.toContain('Step 1')
    expectNoRecipeDuplication(result)
  })
})

describe('fixtures: bonappetit.com/recipe/cheesy-cabbage-gratin', () => {
  const name = 'bonappetit-cabbage-gratin'
  const url = 'https://www.bonappetit.com/recipe/cheesy-cabbage-gratin'

  it('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Cheesy Cabbage Gratin')
    expect(result.servings).toBe(8)
    expect(result.ingredients).toHaveLength(11)
    expect(result.steps).toHaveLength(5)
    expect(result.heroImageUrl).toMatch(/^https:\/\/assets\.bonappetit\.com\//)
    expect(result.tags).toContainEqual({ facet: 'ingredient', value: 'cheese' })

    // No data upstream: no totalTime, prepTime, or cookTime in this page's JSON-LD.
    expect(result.claimedTimeMinutes).toBeNull()

    // The thinnest page of the five -- one editorial sentence against a full
    // recipe -- and therefore the one that catches an over-eager fix. Keeping
    // that sentence is the point; a narrative that came back empty here would
    // pass a steps-are-gone assertion while failing the user.
    expect(result.narrativeHtml).toContain(
      'Every editor who claimed this cheesy gratin would be',
    )
    expect(result.narrativeHtml).toContain('going back for seconds and thirds')
    expect(result.narrativeHtml).not.toContain('Step 1')
    expectNoRecipeDuplication(result)
  })
})

describe('fixtures: easyweeknightrecipes.com/homemade-flatbread-recipe', () => {
  const name = 'easyweeknightrecipes-flatbread'
  const url = 'https://www.easyweeknightrecipes.com/homemade-flatbread-recipe/'

  it('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Homemade Flatbread Recipe')
    expect(result.servings).toBe(10)
    expect(result.claimedTimeMinutes).toBe(60) // ISO 8601 "PT60M" upstream
    expect(result.ingredients).toHaveLength(12)
    expect(result.steps).toHaveLength(9)
    expect(result.heroImageUrl).toBe(
      'https://easyweeknightrecipes.com/wp-content/uploads/2020/04/Flatbread-4.jpg',
    )
    expect(result.tags).toContainEqual({ facet: 'course', value: 'bread' })

    // WordPress Recipe Maker markup matches narrative.ts's selectors, so this
    // fixture was already clean before the Condé Nast fix. It is pinned here as
    // the regression guard for that fix: losing prose on the publishers that
    // already worked would be worse than the bug being fixed.
    expect(result.narrativeHtml).toContain('cherished comfort food')
    expect(result.narrativeHtml).toContain('Why You’ll Love This Easy Flatbread Recipe')
    expect(result.narrativeHtml).not.toContain('Step 1')
    expectNoRecipeDuplication(result)
  })
})

describe('fixtures: cafedelites.com/creamy-garlic-butter-tuscan-shrimp', () => {
  const name = 'cafedelites-tuscan-shrimp'
  const url = 'https://cafedelites.com/creamy-garlic-butter-tuscan-shrimp/'

  it('extracts the full recipe from JSON-LD', async () => {
    const result = await extract({ url, html: loadFixture(name), llm: noopLlm })

    expect(result.extractionMethod).toBe('jsonld')
    expect(result.title).toBe('Creamy Garlic Butter Tuscan Shrimp')
    expect(result.servings).toBe(4)
    expect(result.claimedTimeMinutes).toBe(20) // ISO 8601 "PT20M" upstream
    expect(result.ingredients).toHaveLength(15)
    expect(result.steps).toHaveLength(6)
    expect(result.ingredients[0].rawText).toContain('salted butter')
    expect(result.steps[0].text).toContain('Heat a large skillet')
    expect(result.heroImageUrl).toBe(
      'https://cafedelites.com/wp-content/uploads/2017/12/Tuscan-Shrimp-IMAGE-1.jpg',
    )
    expect(result.tags).toContainEqual({ facet: 'ingredient', value: 'seafood' })

    // Second regression guard for the Tasty Recipes / WPRM path -- see the
    // flatbread fixture.
    expect(result.narrativeHtml).toContain('Tuscan Butter Shrimp')
    expect(result.narrativeHtml).toContain('sun-dried tomatoes and spinach')
    expect(result.narrativeHtml).not.toContain('Step 1')
    expectNoRecipeDuplication(result)
  })
})
