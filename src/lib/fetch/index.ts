const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const TIMEOUT_MS = 20_000

// JSDOM amplifies HTML roughly 300x in memory once the extraction pipeline
// parses it, and this app runs on serverless functions with roughly 1-2 GB
// of memory — a 10 MB page was measured OOM-crashing the process at 4.5 GB
// peak RSS. Real recipe pages from the user's library run 0.6-1.63 MB (Bon
// Appétit: 1.36/1.63/1.25 MB; two WordPress food blogs: ~600 KB each), so
// 3 MB is roughly 2x the largest real page observed and bounds worst-case
// memory to something a serverless function survives.
const MAX_BYTES = 3 * 1024 * 1024

/** The site refused us — typically a datacenter-IP block. Retry from the phone. */
export class BlockedError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`Blocked by ${url} (HTTP ${status})`)
    this.name = 'BlockedError'
  }
}

export class FetchFailedError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`Failed to fetch ${url}: ${reason}`)
    this.name = 'FetchFailedError'
  }
}

export type FetchedPage = { html: string; finalUrl: string; status: number }

const BLOCKED_STATUSES = new Set([401, 403, 429, 451])

// Content types that are clearly not a document we can extract a recipe from.
// A missing or unrecognized content-type still passes through unchecked —
// plenty of small blogs serve HTML with sloppy or absent headers, and
// rejecting those would break real imports.
const DISALLOWED_CONTENT_TYPES = [
  /^application\/pdf$/,
  /^image\//,
  /^video\//,
  /^audio\//,
  /^application\/zip$/,
  /^application\/octet-stream$/,
]

function rejectedContentType(response: Response): string | null {
  const raw = response.headers?.get('content-type')
  if (!raw) return null
  const base = raw.split(';')[0].trim().toLowerCase()
  return DISALLOWED_CONTENT_TYPES.some((pattern) => pattern.test(base)) ? base : null
}

/**
 * The only place in the codebase that talks to the open internet. Distinguishes
 * "they blocked us" from "it broke", because the two have different fixes: a
 * block routes the import to the phone-supplied fallback, a failure retries.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })

    if (!response.ok) {
      if (BLOCKED_STATUSES.has(response.status)) throw new BlockedError(url, response.status)
      throw new FetchFailedError(url, `HTTP ${response.status}`)
    }

    const badType = rejectedContentType(response)
    if (badType) throw new FetchFailedError(url, `unsupported content-type: ${badType}`)

    const contentLength = Number(response.headers?.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      throw new FetchFailedError(
        url,
        `response too large (Content-Length ${contentLength} bytes exceeds ${MAX_BYTES} byte cap)`
      )
    }

    const html = await response.text()

    const byteLength = new TextEncoder().encode(html).length
    if (byteLength > MAX_BYTES) {
      throw new FetchFailedError(url, `response too large (${byteLength} bytes exceeds ${MAX_BYTES} byte cap)`)
    }

    return {
      html,
      finalUrl: response.url || url,
      status: response.status,
    }
  } catch (error) {
    // Preserve our own error types — a BlockedError caught here must stay a
    // BlockedError, or the block-vs-failure distinction this module exists
    // to provide silently collapses into a generic failure.
    if (error instanceof BlockedError || error instanceof FetchFailedError) throw error
    throw new FetchFailedError(url, error instanceof Error ? error.message : 'unknown error')
  } finally {
    clearTimeout(timer)
  }
}
