import { JSDOM } from 'jsdom'
import { applyEnrichment } from './enrich'
import { fromJsonLd } from './jsonld'
import { findRecipeNode } from './jsonld-find'
import { fromMicrodata } from './microdata'
import { llmRecipeSchema, type LlmClient } from './llm-types'
import { extractNarrative } from './narrative'
import type { ExtractedRecipe, PartialRecipe } from './types'

export class NoRecipeFoundError extends Error {
  constructor(url: string) {
    super(`No recipe found at ${url}`)
    this.name = 'NoRecipeFoundError'
    // tsconfig targets ES2017, so `Error` is subclassed natively and the
    // prototype chain survives; this line is a cheap guard in case the target
    // is ever lowered to ES5, where TypeScript's downlevel emit breaks
    // `instanceof` for Error subclasses.
    Object.setPrototypeOf(this, NoRecipeFoundError.prototype)
  }
}

export type ExtractInput = {
  url: string
  html: string
  llm: LlmClient
}

function pageText(html: string): string {
  const { window } = new JSDOM(html)
  for (const el of window.document.querySelectorAll('script, style, nav, footer')) el.remove()
  return (window.document.body?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Resolves a hero image reference against the page it came from. The individual
 * parsers only ever see `html`, so a page that writes `src="/img/sauce.jpg"`
 * (or a JSON-LD `image` given as a relative path — rarer, but legal) hands back
 * a bare path that is useless to a downstream image-downloader. This is the one
 * place that knows the source URL, so it fixes every extraction path at once.
 *
 * A value that cannot be resolved becomes null rather than being stored as
 * garbage: a recipe with no hero image is fine, a recipe with an unfetchable
 * one is a bug that surfaces much later.
 */
function resolveImageUrl(value: string | null, base: string): string | null {
  const raw = value?.trim()
  if (!raw) return null

  // Already self-contained, and re-serializing through URL would only risk
  // perturbing the payload.
  if (raw.startsWith('data:')) return raw

  try {
    const resolved = new URL(raw, base)

    // `new URL` validates syntax, not scheme, so `javascript:alert(1)` or
    // `file:///etc/passwd` parse happily and would be stored as a hero image.
    // Nothing renders one today, which is exactly why this is cheap to close
    // now rather than after an <img src> or a fetch starts trusting the field.
    if (!SAFE_IMAGE_PROTOCOLS.has(resolved.protocol)) return null

    return resolved.href
  } catch {
    return null
  }
}

/**
 * Schemes a hero image may use. `data:` is handled before parsing but is listed
 * here too, so the allowlist reads as the complete answer to "what may an image
 * URL be" rather than half of it.
 */
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'data:'])

async function fromLlm(url: string, html: string, llm: LlmClient): Promise<PartialRecipe | null> {
  let raw: unknown
  try {
    raw = await llm.extractRecipe({ url, text: pageText(html) })
  } catch {
    return null
  }

  const parsed = llmRecipeSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.title.trim()) return null

  const data = parsed.data
  return {
    title: data.title.trim(),
    description: data.description,
    author: data.author,
    publisher: null,
    claimedTimeMinutes: data.claimedTimeMinutes,
    servings: data.servings,
    yieldText: data.yieldText,
    ingredients: data.ingredients.map((rawText, position) => ({
      position, section: null, rawText, quantity: null, unit: null, item: null, note: null,
    })),
    steps: data.steps.map((text, position) => ({ position, section: null, text })),
    tags: [],
    heroImageUrl: null,
    extractionMethod: 'llm',
  }
}

/**
 * Guards the `??` chain against a structured node that parses but says nothing.
 *
 * `fromJsonLd` always returns a recipe -- `{"@type":"Recipe"}` with no content
 * yields "Untitled recipe" with no ingredients and no steps -- so without this
 * the chain short-circuits on the stub and microdata and the LLM never run. That
 * is not a corner case: WordPress SEO plugins routinely emit a stub Recipe node
 * while the real content sits in a WPRM microdata card, i.e. precisely the page
 * where the next parser would have succeeded. The result would look extracted
 * (method `jsonld`, no error) and land in the database as a permanent silent hole.
 *
 * `fromMicrodata` already rejects a nameless scope, but has the same hole one
 * level down: a scope with a name and no content.
 *
 * Ingredients OR steps, never AND: a spice-blend card is ingredients with no
 * steps and a technique card is steps with no ingredients, but neither-nor is
 * never a recipe.
 */
function usable(recipe: PartialRecipe | null): PartialRecipe | null {
  if (!recipe) return null
  return recipe.ingredients.length > 0 || recipe.steps.length > 0 ? recipe : null
}

/**
 * Turns a fetched page into a validated recipe. Pure: no network, no database,
 * no clock. The LLM is injected, so tests drive every path without a live call.
 *
 * Order matters — structured data is authoritative and free, so the LLM is only
 * asked to extract when neither JSON-LD nor microdata is present.
 */
export async function extract({ url, html, llm }: ExtractInput): Promise<ExtractedRecipe> {
  const node = findRecipeNode(html)
  const base =
    usable(node ? fromJsonLd(node) : null) ??
    usable(fromMicrodata(html)) ??
    (await fromLlm(url, html, llm))

  if (!base) throw new NoRecipeFoundError(url)

  const enriched = await applyEnrichment(base, llm)

  return {
    ...enriched,
    heroImageUrl: resolveImageUrl(enriched.heroImageUrl, url),
    // The recipe body is passed back in so the narrative can be stripped of the
    // steps and ingredients we already have. Without it the "story" ends up
    // being the recipe a second time, which is the exact thing this app exists
    // to stop doing.
    narrativeHtml: extractNarrative(html, {
      steps: enriched.steps.map((step) => step.text),
      ingredients: enriched.ingredients.map((ingredient) => ingredient.rawText),
    }),
  }
}

export type { ExtractedRecipe } from './types'
