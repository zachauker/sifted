import { JSDOM } from 'jsdom'
import { normalizeTags } from '@/lib/taxonomy'
import { parseDurationMinutes } from './duration'
import type { JsonLdNode } from './jsonld-find'
import type { ExtractedIngredient, ExtractedStep, PartialRecipe } from './types'

// A realistic recipe calls plainText() ~28 times (title, description, author,
// publisher, yield, every ingredient line, every step) and each call used to
// construct its own JSDOM instance — 28 JSDOM instantiations per recipe,
// measured at 75ms, more than parsing the entire 200KB source document
// twice. This module-level document and scratch element are created once
// and reused across every call instead. This is safe to share: assigning to
// `scratchElement.innerHTML` fully replaces its previous children before
// parsing the new markup (same as a browser), so nothing from one call's
// input can survive into the next call's output, even for malformed markup
// like an unclosed tag. Scripts never execute — `runScripts` is not passed
// to JSDOM, so <script> tags are inert.
const scratchElement = new JSDOM('').window.document.createElement('div')

/** Strips markup and decodes entities from a schema.org text field. */
function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  scratchElement.innerHTML = value
  return (scratchElement.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return plainText(value) || null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return firstString(obj.name ?? obj.url ?? null)
  }
  return null
}

function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return firstUrl(obj.url ?? obj.contentUrl ?? null)
  }
  return null
}

function toStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (Array.isArray(value)) return value.flatMap(toStringList)
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name
    return typeof name === 'string' ? [name] : []
  }
  return []
}

/**
 * "Dozen" yields are common on baking blogs (cookies, rolls, cinnamon buns)
 * and must be checked before the bare-digit fallback below — otherwise
 * "1 dozen" would read as 1 serving instead of 12, and "a dozen" (no leading
 * digit) would read as 0/null instead of 12.
 */
const DOZEN = /(\d+)?\s*dozen/i

function parseServings(yieldValue: unknown): number | null {
  const text = Array.isArray(yieldValue) ? String(yieldValue[0] ?? '') : String(yieldValue ?? '')

  const dozenMatch = DOZEN.exec(text)
  if (dozenMatch) {
    const dozens = dozenMatch[1] ? Number(dozenMatch[1]) : 1
    return Number.isFinite(dozens) && dozens > 0 ? dozens * 12 : null
  }

  const match = /\d+/.exec(text)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

function collectSteps(value: unknown, section: string | null, out: ExtractedStep[]): void {
  if (!value) return

  if (typeof value === 'string') {
    // Split the raw string first: plainText collapses all whitespace runs
    // (including newlines) to a single space, which would erase the very
    // newline/double-space boundaries this split relies on. Each resulting
    // segment is then run through plainText individually to strip markup
    // and decode entities.
    //
    // Deliberately does NOT split on a single space after a period. Cooking
    // prose is full of period-then-single-space abbreviations ("1 tsp. salt",
    // "approx. 5 minutes", "e.g."), and splitting on those would sever a step
    // mid-sentence — corrupt data that *reads* as correct, which is worse
    // than the alternative failure mode here (a single oversized step for a
    // blob that only used single-space sentence separators). Only newlines
    // and double-plus spaces are treated as reliable step boundaries.
    for (const line of value.split(/\n+|(?<=\.)\s{2,}/)) {
      const text = plainText(line)
      if (text) out.push({ position: out.length, section, text })
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectSteps(item, section, out)
    return
  }

  if (typeof value !== 'object') return
  const node = value as Record<string, unknown>
  const type = String(node['@type'] ?? '')

  if (type === 'HowToSection') {
    const name = typeof node.name === 'string' ? plainText(node.name) : null
    collectSteps(node.itemListElement, name || section, out)
    return
  }

  const text = plainText(node.text ?? node.name ?? '')
  if (text) out.push({ position: out.length, section, text })
}

function collectIngredients(value: unknown): ExtractedIngredient[] {
  const lines = Array.isArray(value) ? value : value ? [value] : []
  return lines
    .map((line) => plainText(line))
    .filter(Boolean)
    .map((rawText, position) => ({
      position,
      section: null,
      rawText,
      quantity: null,
      unit: null,
      item: null,
      note: null,
    }))
}

/**
 * Maps a schema.org Recipe node onto our contract. Ingredient lines are stored
 * verbatim; structured quantity/unit/item fields are filled in later by the
 * enrichment pass, never here.
 *
 * Security note: `ingredients[].rawText` and `steps[].text` are untrusted
 * third-party strings taken verbatim from arbitrary food-blog markup. HTML
 * tags are stripped and entities are decoded for readability, but the
 * resulting text is not sanitized against being interpreted as markup —
 * callers must render it as plain text (e.g. React's default text nodes),
 * never via `dangerouslySetInnerHTML` or equivalent.
 */
export function fromJsonLd(node: JsonLdNode): PartialRecipe {
  const steps: ExtractedStep[] = []
  collectSteps(node.recipeInstructions, null, steps)

  const rawTags = [
    ...toStringList(node.recipeCategory),
    ...toStringList(node.recipeCuisine),
    ...toStringList(node.keywords),
  ]

  return {
    title: plainText(node.name) || 'Untitled recipe',
    description: firstString(node.description),
    author: firstString(node.author),
    publisher: firstString(node.publisher),
    claimedTimeMinutes:
      parseDurationMinutes(node.totalTime as string | undefined) ??
      sumTimes(node.prepTime, node.cookTime),
    servings: parseServings(node.recipeYield),
    yieldText: firstString(node.recipeYield),
    ingredients: collectIngredients(node.recipeIngredient),
    steps,
    tags: normalizeTags(rawTags),
    heroImageUrl: firstUrl(node.image),
    extractionMethod: 'jsonld',
  }
}

function sumTimes(prep: unknown, cook: unknown): number | null {
  const p = parseDurationMinutes(prep as string | undefined)
  const c = parseDurationMinutes(cook as string | undefined)
  if (p === null && c === null) return null
  return (p ?? 0) + (c ?? 0)
}
