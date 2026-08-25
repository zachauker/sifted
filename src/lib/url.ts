const STRIPPED_PARAM_PREFIXES = ['utm_']
const STRIPPED_PARAMS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', '_ga',
])

export type NormalizedUrl = { url: string; domain: string }

/**
 * Produces the canonical form of a source URL, used both for storage and as the
 * dedupe key. Tracking parameters and fragments are removed so the same recipe
 * clipped from two different links resolves to one row.
 */
export function normalizeSourceUrl(input: string): NormalizedUrl {
  const raw = input.trim()
  if (!raw) throw new Error('Invalid URL: empty input')

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`Invalid URL: ${input}`)
  }

  if (!parsed.hostname.includes('.')) throw new Error(`Invalid URL: ${input}`)

  parsed.hash = ''
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')

  for (const name of [...parsed.searchParams.keys()]) {
    const lower = name.toLowerCase()
    if (STRIPPED_PARAMS.has(lower) || STRIPPED_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
      parsed.searchParams.delete(name)
    }
  }

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  }

  const search = parsed.searchParams.toString()
  const url = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${search ? `?${search}` : ''}`

  return { url, domain: parsed.hostname }
}
