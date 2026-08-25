import { JSDOM } from 'jsdom'
import { normalizeTags } from '@/lib/taxonomy'
import { parseDurationMinutes } from './duration'
import type { PartialRecipe } from './types'

/**
 * Properties whose microdata value is a human-readable label rather than a
 * reference to something. For these, a `content` attribute still wins (some
 * sites legitimately put the canonical string there, leaving the visible
 * text empty or differently formatted), but `src`/`href` do not: a linked
 * byline such as `<a itemprop="author" href="/author/elise">Elise
 * Bauer</a>` must read as "Elise Bauer", the byline text, not
 * "/author/elise", a reference to it.
 *
 * This deliberately diverges from strict microdata semantics, where an
 * anchor's value IS its href — that is correct for a genuine reference
 * property. Do not "fix" this set to match the spec; for these particular
 * properties the spec-correct value is the wrong value for us.
 *
 * `image` is intentionally NOT in this set: it is a reference property, and
 * its `src` genuinely is the value the rest of the app needs.
 */
const TEXT_VALUED_PROPS = new Set([
  'name',
  'description',
  'author',
  'publisher',
  'recipeYield',
  'recipeCategory',
  'recipeCuisine',
  'keywords',
])

/** Microdata puts values in content/src/href attributes as often as in text; see TEXT_VALUED_PROPS for the per-property tradeoff. */
function valueOf(el: Element, prop: string): string {
  const content = el.getAttribute('content')
  if (content) return content.trim()

  if (!TEXT_VALUED_PROPS.has(prop)) {
    const attr =
      el.getAttribute('src') ??
      el.getAttribute('datetime') ??
      (el.tagName === 'A' ? el.getAttribute('href') : null)
    if (attr) return attr.trim()
  }

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
    .map((el) => valueOf(el, prop))
    .filter(Boolean)
}

function one(scope: Element, prop: string): string | null {
  return all(scope, prop)[0] ?? null
}

const BLOCK_SELECTOR = 'p, li, div'

/**
 * Returns the outermost block-level (p/li/div) descendants of `el` — that
 * is, skips any match that is itself nested inside another match. This
 * makes a wrapping `<div itemprop="recipeInstructions"><p>...</p><p>...
 * </p></div>` yield the two `<p>` texts (not the wrapper's, which would
 * duplicate them), and lets an `<ol><li>` nested two levels under the
 * wrapper still yield one entry per `<li>` even though neither `<ol>` nor
 * the wrapper itself is a match.
 */
function outermostBlocks(el: Element): Element[] {
  const candidates = [...el.querySelectorAll(BLOCK_SELECTOR)]
  return candidates.filter((c) => !candidates.some((other) => other !== c && other.contains(c)))
}

/**
 * Collects recipeInstructions text, one entry per step. A page may either
 * repeat `itemprop="recipeInstructions"` once per step (each a plain
 * text-only element — the common case) or place it once on a wrapper that
 * contains a run of block-level children (several `<p>`, or an `<ol>` of
 * `<li>`). In the latter case, splitting on those DOM boundaries is safe —
 * unlike JSON-LD, which is only ever handed an opaque string and can't
 * split on ". " without risking "1 tsp." being read as a sentence break —
 * because here each child element already IS a discrete instruction the
 * page author wrote as its own node.
 */
function collectSteps(scope: Element): string[] {
  const out: string[] = []
  for (const el of scope.querySelectorAll('[itemprop="recipeInstructions"]')) {
    if (!ownedBy(el, scope)) continue

    const blocks = outermostBlocks(el)
    const texts =
      blocks.length > 0
        ? blocks.map((block) => valueOf(block, 'recipeInstructions'))
        : [valueOf(el, 'recipeInstructions')]

    for (const text of texts) {
      if (text) out.push(text)
    }
  }
  return out
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
    claimedTimeMinutes: parseDurationMinutes(one(scope, 'totalTime')),
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
    steps: collectSteps(scope).map((text, position) => ({
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
