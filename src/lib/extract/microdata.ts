import { JSDOM } from 'jsdom'
import { normalizeTags } from '@/lib/taxonomy'
import { parseIsoDurationMinutes } from './duration'
import type { PartialRecipe } from './types'

/** Microdata puts values in content/src/href attributes as often as in text. */
function valueOf(el: Element): string {
  const attr =
    el.getAttribute('content') ??
    el.getAttribute('src') ??
    el.getAttribute('datetime') ??
    (el.tagName === 'A' ? el.getAttribute('href') : null)
  if (attr) return attr.trim()
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * True when `el` belongs to `scope` under the microdata spec, i.e. no other
 * itemscope element sits between them. querySelectorAll(`[itemprop]`) walks
 * into nested itemscopes (a NutritionInformation or a Person author with its
 * own itemprop="name") indiscriminately, which would let a nested node's
 * value masquerade as the outer Recipe's. This walks up from `el` and
 * rejects it unless the nearest enclosing itemscope ancestor is `scope`
 * itself.
 */
function ownedBy(el: Element, scope: Element): boolean {
  let node: Element | null = el.parentElement
  while (node && node !== scope) {
    if (node.hasAttribute('itemscope')) return false
    node = node.parentElement
  }
  return node === scope
}

function all(scope: Element, prop: string): string[] {
  return [...scope.querySelectorAll(`[itemprop="${prop}"]`)]
    .filter((el) => ownedBy(el, scope))
    .map(valueOf)
    .filter(Boolean)
}

function one(scope: Element, prop: string): string | null {
  return all(scope, prop)[0] ?? null
}

/**
 * itemtype is a space-separated list of full IRIs. Matched by exact value
 * (scheme-optional) rather than substring, so a page marked up with
 * schema.org/RecipeReview or schema.org/RecipeCard — real, related but
 * distinct types — never masquerades as a Recipe.
 */
const RECIPE_ITEMTYPES = new Set([
  'https://schema.org/Recipe',
  'http://schema.org/Recipe',
  'schema.org/Recipe',
])

function isRecipeScope(el: Element): boolean {
  const itemtype = el.getAttribute('itemtype')
  if (!itemtype) return false
  return itemtype.split(/\s+/).some((t) => RECIPE_ITEMTYPES.has(t))
}

function findRecipeScope(doc: Document): Element | null {
  for (const el of doc.querySelectorAll('[itemscope]')) {
    if (isRecipeScope(el)) return el
  }
  return null
}

/**
 * Extracts a recipe marked up with schema.org microdata. Returns null when the
 * page has no Recipe itemscope or the itemscope carries no name, so the caller
 * can fall through to the LLM path.
 */
export function fromMicrodata(html: string): PartialRecipe | null {
  const { window } = new JSDOM(html)
  const scope = findRecipeScope(window.document)
  if (!scope) return null

  const title = one(scope, 'name')
  if (!title) return null

  const yieldText = one(scope, 'recipeYield')
  const servingsMatch = yieldText ? /\d+/.exec(yieldText) : null

  return {
    title,
    description: one(scope, 'description'),
    author: one(scope, 'author'),
    publisher: one(scope, 'publisher'),
    claimedTimeMinutes: parseIsoDurationMinutes(one(scope, 'totalTime')),
    servings: servingsMatch ? Number(servingsMatch[0]) : null,
    yieldText,
    ingredients: all(scope, 'recipeIngredient').map((rawText, position) => ({
      position,
      section: null,
      rawText,
      quantity: null,
      unit: null,
      item: null,
      note: null,
    })),
    steps: all(scope, 'recipeInstructions').map((text, position) => ({
      position,
      section: null,
      text,
    })),
    tags: normalizeTags([
      ...all(scope, 'recipeCategory'),
      ...all(scope, 'recipeCuisine'),
      ...all(scope, 'keywords'),
    ]),
    heroImageUrl: one(scope, 'image'),
    extractionMethod: 'microdata',
  }
}
