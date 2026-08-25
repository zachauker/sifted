const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const TIMEOUT_MS = 20_000

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

/**
 * The only place in the codebase that talks to the open internet. Distinguishes
 * "they blocked us" from "it broke", because the two have different fixes: a
 * block routes the import to the phone-supplied fallback, a failure retries.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
  } catch (error) {
    throw new FetchFailedError(url, error instanceof Error ? error.message : 'unknown error')
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    if (BLOCKED_STATUSES.has(response.status)) throw new BlockedError(url, response.status)
    throw new FetchFailedError(url, `HTTP ${response.status}`)
  }

  return {
    html: await response.text(),
    finalUrl: response.url || url,
    status: response.status,
  }
}
