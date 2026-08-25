import { JSDOM } from 'jsdom'

export type JsonLdNode = Record<string, unknown> & { name?: string }

function typesOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return []
  const raw = (node as Record<string, unknown>)['@type']
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string')
  return []
}

/** Yields every object in a JSON-LD document, descending through arrays and @graph. */
function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item)
    return
  }
  if (!value || typeof value !== 'object') return

  const node = value as Record<string, unknown>
  yield node

  if (node['@graph']) yield* walk(node['@graph'])
}

/**
 * Returns the first schema.org Recipe node in the page's JSON-LD, or null.
 * Malformed script blocks are skipped rather than thrown, because a page with
 * one broken block and one good one is common.
 */
export function findRecipeNode(html: string): JsonLdNode | null {
  const { window } = new JSDOM(html)
  const scripts = window.document.querySelectorAll('script[type="application/ld+json"]')

  for (const script of scripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script.textContent ?? '')
    } catch {
      continue
    }

    for (const node of walk(parsed)) {
      if (typesOf(node).includes('Recipe')) return node as JsonLdNode
    }
  }

  return null
}
