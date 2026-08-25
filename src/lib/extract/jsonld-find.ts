import { JSDOM } from 'jsdom'

export type JsonLdNode = Record<string, unknown> & { name?: string }

const SCHEMA_ORG_PREFIXES = ['https://schema.org/', 'http://schema.org/']

/** Strips a leading schema.org IRI prefix, if present, leaving the bare term. Case-sensitive otherwise. */
function normalizeType(type: string): string {
  for (const prefix of SCHEMA_ORG_PREFIXES) {
    if (type.startsWith(prefix)) return type.slice(prefix.length)
  }
  return type
}

function typesOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return []
  const raw = (node as Record<string, unknown>)['@type']
  if (typeof raw === 'string') return [normalizeType(raw)]
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string').map(normalizeType)
  return []
}

/** Properties known to hold a nested JSON-LD node (or array of nodes) worth descending into. */
const DESCEND_PROPS = ['@graph', 'mainEntity', 'mainEntityOfPage']

/**
 * Yields every object in a JSON-LD document, descending through arrays and a
 * narrow, explicit set of properties (@graph, mainEntity, mainEntityOfPage).
 * Deliberately does NOT walk every object-valued property — that would risk
 * matching a Recipe referenced from an unrelated property (e.g. `about`,
 * `isPartOf`) instead of the page's actual subject.
 *
 * Assumes acyclic input, which holds for anything produced by JSON.parse
 * (JSON syntax cannot express back-references). If this function is ever
 * changed to accept pre-parsed objects from another source, revisit this
 * assumption — a cycle here would infinite-loop.
 */
function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item)
    return
  }
  if (!value || typeof value !== 'object') return

  const node = value as Record<string, unknown>
  yield node

  for (const prop of DESCEND_PROPS) {
    if (node[prop]) yield* walk(node[prop])
  }
}

/**
 * Strips a wrapper that encloses the entire script body — either an HTML
 * comment (`<!-- ... -->`) or a CDATA-style guard (`//<![CDATA[ ... //]]>`) —
 * both emitted by certain caching/minification CMS plugins as a legacy
 * workaround for old parsers. Only a wrapper around the whole body is
 * stripped; comments appearing mid-JSON are left alone and will simply fail
 * to parse, which the caller already handles by skipping the block.
 */
function unwrapScriptBody(raw: string): string {
  const text = raw.trim()

  if (text.startsWith('<!--') && text.endsWith('-->')) {
    return text.slice('<!--'.length, -'-->'.length).trim()
  }

  if (text.startsWith('//<![CDATA[') && text.endsWith('//]]>')) {
    return text.slice('//<![CDATA['.length, -'//]]>'.length).trim()
  }

  return text
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
      parsed = JSON.parse(unwrapScriptBody(script.textContent ?? ''))
    } catch {
      continue
    }

    for (const node of walk(parsed)) {
      if (typesOf(node).includes('Recipe')) return node as JsonLdNode
    }
  }

  return null
}
