import { JSDOM } from 'jsdom'
import { normalizeTags } from '@/lib/taxonomy'
import { parseIsoDurationMinutes } from './duration'
import type { JsonLdNode } from './jsonld-find'
import type { ExtractedIngredient, ExtractedStep, PartialRecipe } from './types'

/** Strips markup and decodes entities from a schema.org text field. */
function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const { window } = new JSDOM(`<div>${value}</div>`)
  return (window.document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
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

function parseServings(yieldValue: unknown): number | null {
  const text = Array.isArray(yieldValue) ? String(yieldValue[0] ?? '') : String(yieldValue ?? '')
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
      parseIsoDurationMinutes(node.totalTime as string | undefined) ??
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
  const p = parseIsoDurationMinutes(prep as string | undefined)
  const c = parseIsoDurationMinutes(cook as string | undefined)
  if (p === null && c === null) return null
  return (p ?? 0) + (c ?? 0)
}
