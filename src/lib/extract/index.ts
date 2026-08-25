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
    return new URL(raw, base).href
  } catch {
    return null
  }
}

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
 * Turns a fetched page into a validated recipe. Pure: no network, no database,
 * no clock. The LLM is injected, so tests drive every path without a live call.
 *
 * Order matters — structured data is authoritative and free, so the LLM is only
 * asked to extract when neither JSON-LD nor microdata is present.
 */
export async function extract({ url, html, llm }: ExtractInput): Promise<ExtractedRecipe> {
  const node = findRecipeNode(html)
  const base =
    (node ? fromJsonLd(node) : null) ??
    fromMicrodata(html) ??
    (await fromLlm(url, html, llm))

  if (!base) throw new NoRecipeFoundError(url)

  const enriched = await applyEnrichment(base, llm)

  return {
    ...enriched,
    heroImageUrl: resolveImageUrl(enriched.heroImageUrl, url),
    narrativeHtml: extractNarrative(html),
  }
}

export type { ExtractedRecipe } from './types'
