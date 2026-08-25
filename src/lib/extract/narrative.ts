import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

/** Selectors used by the common recipe-card plugins. */
const RECIPE_CARD_SELECTORS = [
  '.wprm-recipe-container',
  '.tasty-recipes',
  '.mv-create-wrapper',
  '.easyrecipe',
  '[itemtype*="schema.org/Recipe"]',
  '.recipe-card',
  '#recipe',
]

const MIN_NARRATIVE_LENGTH = 200

/**
 * Returns the article prose with the recipe card removed, or null when the page
 * has no narrative worth keeping. The recipe itself is extracted separately, so
 * leaving the card in would duplicate it.
 */
export function extractNarrative(html: string): string | null {
  const dom = new JSDOM(html, { url: 'https://example.com/' })
  const { document } = dom.window

  for (const selector of RECIPE_CARD_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) el.remove()
  }

  const article = new Readability(document).parse()
  const content = article?.content?.trim()
  if (!content) return null

  const textLength = (article?.textContent ?? '').replace(/\s+/g, ' ').trim().length
  return textLength >= MIN_NARRATIVE_LENGTH ? content : null
}
