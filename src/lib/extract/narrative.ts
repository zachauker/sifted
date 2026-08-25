import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

/**
 * Selectors used by the common recipe-card plugins. These are removed *before*
 * Readability runs, because Readability strips `class` attributes from its
 * output, so a class-based hook only exists in the original document.
 */
const RECIPE_CARD_SELECTORS = [
  '.wprm-recipe-container',
  '.tasty-recipes',
  '.mv-create-wrapper',
  '.easyrecipe',
  '[itemtype*="schema.org/Recipe"]',
  '.recipe-card',
  '#recipe',
]

/**
 * Publisher-specific containers holding the ingredient list, the numbered steps,
 * and the yield/time slice. Currently Condé Nast (Bon Appétit, Epicurious), whose
 * custom React markup matches none of RECIPE_CARD_SELECTORS, so without these the
 * entire recipe survives into the "narrative" and is shown to the reader twice.
 *
 * `data-testid` is the hook rather than the class name on purpose: every one of
 * these containers also carries a CSS-modules class like
 * `InstructionsWrapper-gtQceH jpxWAk`, whose hash is regenerated on each build and
 * would rot within a release.
 */
const PUBLISHER_RECIPE_BLOCK_SELECTORS = [
  '[data-testid="IngredientList"]',
  '[data-testid="InstructionsWrapper"]',
  '[data-testid="InfoSliceList"]',
]

/**
 * Page furniture removed before Readability runs, matching what `pageText` in
 * index.ts already strips for the LLM path.
 *
 * This exists because of the interaction with the removals above, not on its own
 * merits. Readability picks a single top-scoring candidate; on a Bon Appétit page
 * the recipe *is* the biggest block of text, so once it is removed the site footer
 * -- a long slab of Condé Nast legalese and affiliate disclosure -- can outscore
 * the actual editorial copy and be returned as the "story". Deleting the chrome
 * first keeps the article the only serious candidate. Verified to leave the two
 * WordPress fixtures byte-for-byte unchanged.
 */
const PAGE_CHROME_SELECTORS = ['nav', 'footer']

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
 *
 * The same guard covers PUBLISHER_RECIPE_BLOCK_SELECTORS for the same reason.
 */
const WRAPPER_TEXT_SHARE_THRESHOLD = 0.6

/**
 * Shortest block, and shortest recipe line, considered for de-duplication. Below
 * this, a "match" carries no evidence: "Salt" or "Serve warm." occur in prose as
 * readily as in a recipe, and removing a block on that basis deletes narrative.
 */
const MIN_DUPLICATE_LENGTH = 24

/**
 * Share of a block's text that must be verbatim recipe content before the block is
 * dropped. High on purpose: a paragraph that quotes a step while adding commentary
 * around it is narrative, and the promise of this module is that the story
 * survives.
 */
const DUPLICATE_COVERAGE_THRESHOLD = 0.8

/**
 * When a block is a *fragment* of one recipe line rather than the whole of it, it
 * must still cover most of that line. This is what separates "medium head of green
 * or savoy cabbage, cut into 8 wedges" (an ingredient minus its quantity cell, and
 * a duplicate) from a 30-character clause that happens to appear inside a
 * 300-character step (prose, and not a duplicate).
 */
const FRAGMENT_COVERAGE_THRESHOLD = 0.6

const BLOCK_SELECTOR =
  'p, li, div, ul, ol, dl, dd, dt, section, article, aside, header, footer, ' +
  'blockquote, figure, figcaption, table, tr, td, th, pre, h1, h2, h3, h4, h5, h6'

/** Elements that carry meaning without carrying text, so an "empty" ancestor is not really empty. */
const MEDIA_SELECTOR = 'img, picture, video, audio, iframe, svg, embed, object'

/** The already-extracted recipe body, used to strip duplication from the narrative. */
export type RecipeBodyText = {
  steps: readonly string[]
  ingredients: readonly string[]
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function textOf(el: Element): string {
  return normalize(el.textContent ?? '')
}

function isRecipeCard(el: Element, totalTextLength: number): boolean {
  if (totalTextLength === 0) return true
  const elTextLength = textOf(el).length
  return elTextLength / totalTextLength < WRAPPER_TEXT_SHARE_THRESHOLD
}

/**
 * Normalized recipe lines worth matching against. Short lines are dropped rather
 * than matched loosely -- see MIN_DUPLICATE_LENGTH.
 */
function recipeLines(body: RecipeBodyText | undefined): string[] {
  if (!body) return []
  return [...body.steps, ...body.ingredients]
    .map(normalize)
    .filter((line) => line.length >= MIN_DUPLICATE_LENGTH)
}

/**
 * How much of `text` is verbatim recipe content, as a share of its length.
 *
 * Two ways to score, both requiring a whole recipe line rather than a stray word:
 * the block reproduces one or more complete lines, or the block is itself most of
 * a single line (the case where the publisher splits an ingredient's quantity and
 * description into sibling cells).
 */
function duplicateShare(text: string, lines: readonly string[]): number {
  let covered = 0
  for (const line of lines) {
    if (text.includes(line)) covered += line.length
    else if (line.includes(text) && text.length / line.length >= FRAGMENT_COVERAGE_THRESHOLD) {
      return 1
    }
  }
  return Math.min(covered, text.length) / text.length
}

/**
 * Drops blocks that merely repeat the recipe we already extracted.
 *
 * This is the half of the fix that generalizes: selector lists only ever cover the
 * publishers someone has looked at, but the step and ingredient text is known
 * exactly for every page, because the recipe body is parsed before the narrative.
 *
 * Walks top-down and does not descend into a block it removes, so a list wrapping
 * five steps goes in one piece -- taking its "Step 1"/"Step 2" labels with it,
 * which a leaf-only pass would strand.
 */
function removeDuplicatedBlocks(root: Element, lines: readonly string[]): void {
  if (lines.length === 0) return

  const queue: Element[] = [...root.children]
  while (queue.length > 0) {
    const el = queue.shift()
    if (!el) continue

    const text = textOf(el)
    if (
      el.matches(BLOCK_SELECTOR) &&
      text.length >= MIN_DUPLICATE_LENGTH &&
      duplicateShare(text, lines) >= DUPLICATE_COVERAGE_THRESHOLD
    ) {
      el.remove()
      continue
    }

    queue.push(...el.children)
  }
}

/** Removes containers left holding nothing after their recipe content was dropped. */
function removeEmptyContainers(root: Element): void {
  let removedAny = true
  while (removedAny) {
    removedAny = false
    for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
      if (textOf(el).length > 0) continue
      if (el.querySelector(MEDIA_SELECTOR) || el.matches(MEDIA_SELECTOR)) continue
      el.remove()
      removedAny = true
    }
  }
}

/**
 * Returns the article prose with the recipe removed, or null when the page has no
 * narrative worth keeping. The recipe itself is extracted separately, so leaving it
 * in would show the reader the same steps twice -- which is the exact complaint
 * this app exists to answer.
 *
 * `recipeBody` is optional: without it only the selector-based removals run, so
 * `extractNarrative(html)` remains usable standalone.
 */
export function extractNarrative(html: string, recipeBody?: RecipeBodyText): string | null {
  const dom = new JSDOM(html, { url: 'https://example.com/' })
  const { document } = dom.window

  // Measured once, before any removals, so removing one card doesn't shift the
  // denominator used to judge the next.
  const totalTextLength = textOf(document.body ?? document.documentElement).length

  for (const selector of [...RECIPE_CARD_SELECTORS, ...PUBLISHER_RECIPE_BLOCK_SELECTORS]) {
    for (const el of document.querySelectorAll(selector)) {
      if (isRecipeCard(el, totalTextLength)) el.remove()
    }
  }

  for (const selector of PAGE_CHROME_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) el.remove()
  }

  const article = new Readability(document).parse()
  const content = article?.content?.trim()
  if (!content) return null

  // Re-parsed so the de-duplication below works on the DOM Readability actually
  // chose, rather than on the whole page.
  const root = new JSDOM(content).window.document.body
  if (!root) return null

  removeDuplicatedBlocks(root, recipeLines(recipeBody))
  removeEmptyContainers(root)

  // Re-checked after the removals: stripping duplication can leave a stub, and a
  // stub is worse than an honest null.
  if (textOf(root).length < MIN_NARRATIVE_LENGTH) return null

  const cleaned = root.innerHTML.trim()
  return cleaned.length > 0 ? cleaned : null
}
