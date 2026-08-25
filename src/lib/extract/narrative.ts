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
 * Above this share of the document's text, a card-selector match is treated as a
 * page-level wrapper rather than an embedded card, and is left alone. Some legacy
 * recipe themes put `itemscope itemtype="schema.org/Recipe"` on the whole <article>
 * wrapper instead of a small inner card. Without this guard, that selector would
 * match the wrapper and remove the entire article -- narrative included -- leaving
 * extractNarrative to silently return null even though the page has a real story.
 * Losing the narrative that way is worse than the alternative failure mode (a
 * genuine card surviving into the output), so this guard is deliberately generous.
 */
const WRAPPER_TEXT_SHARE_THRESHOLD = 0.6

function isRecipeCard(el: Element, totalTextLength: number): boolean {
  if (totalTextLength === 0) return true
  const elTextLength = (el.textContent ?? '').replace(/\s+/g, ' ').trim().length
  return elTextLength / totalTextLength < WRAPPER_TEXT_SHARE_THRESHOLD
}

/**
 * Returns the article prose with the recipe card removed, or null when the page
 * has no narrative worth keeping. The recipe itself is extracted separately, so
 * leaving the card in would duplicate it.
 */
export function extractNarrative(html: string): string | null {
  const dom = new JSDOM(html, { url: 'https://example.com/' })
  const { document } = dom.window

  // Measured once, before any removals, so removing one card doesn't shift the
  // denominator used to judge the next.
  const totalTextLength = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().length

  for (const selector of RECIPE_CARD_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (isRecipeCard(el, totalTextLength)) el.remove()
    }
  }

  const article = new Readability(document).parse()
  const content = article?.content?.trim()
  if (!content) return null

  const textLength = (article?.textContent ?? '').replace(/\s+/g, ' ').trim().length
  return textLength >= MIN_NARRATIVE_LENGTH ? content : null
}
