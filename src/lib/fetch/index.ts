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

// How much of the body to scan for a `<meta charset>` declaration. The HTML
// spec's own prescan caps at 1024 bytes; we allow a little more because real
// blogs push the meta down past a bloated comment banner or a CMS preamble.
// The prefix is decoded as windows-1252 purely to find the declaration — that
// is always safe, because an encoding declaration is by definition ASCII, and
// windows-1252 maps all 256 byte values without ever producing U+FFFD, so no
// byte in the prefix can corrupt the regex scan.
const SNIFF_BYTES = 2048

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

export type FetchedPage = {
  /**
   * The body decoded with the encoding named by `encoding` — never a blind
   * UTF-8 decode. `Response.text()` is spec-bound to assume UTF-8 and ignore
   * the `charset` parameter, which turns any windows-1252 / ISO-8859-1 page
   * into mojibake (`sauté` -> `saut�ed`) with no error raised anywhere.
   */
  html: string
  /**
   * The exact bytes the server sent, before any decoding.
   *
   * This is the authoritative copy of the page and the reason re-extraction
   * is possible at all: the archive step (Plan 2, raw-HTML blob storage) must
   * persist THESE bytes, not `html` re-encoded. A re-encode is lossy the
   * moment the decode was wrong — the U+FFFD replacement characters a bad
   * decode produces are unrecoverable, so an archive built from `html` bakes
   * today's decoding bugs permanently into every future re-extraction. Keep
   * the bytes; the parser can always be improved and re-run against them.
   */
  bytes: Uint8Array
  /**
   * Canonical WHATWG label of the encoding actually used to produce `html`
   * (e.g. `'utf-8'`, `'windows-1252'`). Recorded so a later re-extraction can
   * tell a deliberate decode from a guessed one, and so a page decoded by the
   * undeclared-body fallback is auditable after the fact.
   */
  encoding: string
  finalUrl: string
  status: number
}

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
 * A byte-order mark outranks every declaration, including the Content-Type
 * header — a document that starts with one IS in that encoding regardless of
 * what the server claims. Only UTF-8 and UTF-16 marks are recognized, which
 * matches what browsers sniff.
 */
function encodingFromBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return null
}

/** Pulls the `charset` parameter out of a Content-Type value, quoted or bare. */
function charsetFromContentType(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(value)
  if (!match) return null
  return match[1].replace(/^["']|["']$/g, '').trim() || null
}

/**
 * Scans the head of the document for an in-band declaration. One pattern
 * covers both spellings, because in
 * `<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">`
 * it is the `charset=` inside the `content` attribute that matches, which is
 * exactly the value we want.
 */
function charsetFromMeta(bytes: Uint8Array): string | null {
  const prefix = decodeWindows1252(bytes.subarray(0, SNIFF_BYTES))
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>;]+)/i.exec(prefix)
  return match ? match[1].trim() || null : null
}

// Bytes 0x80-0x9F in windows-1252, per the WHATWG index. This range is the
// only place windows-1252 and ISO-8859-1 disagree, and it holds exactly the
// punctuation blog prose is made of: curly quotes, en/em dashes, the ellipsis.
//
// We carry the table because Node's own `TextDecoder` does not implement it.
// Measured on Node 24: `new TextDecoder('windows-1252')` reports its encoding
// as 'windows-1252' but decodes 0x92 to U+0092, a C1 control, instead of the
// U+2019 the standard (and every browser) produces — so `Gran<0x92>s pâté`
// comes back as `Grans pâté` with an invisible control character wedged in.
// That is the same silent-corruption failure this module exists to prevent,
// just quieter: it never raises U+FFFD, so nothing flags it. Decoding the
// range ourselves makes the result identical on every runtime.
const CP1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
]

const DECODE_CHUNK = 8192

/**
 * Spec-correct windows-1252. Every byte maps to exactly one code point, so
 * this decoder can never produce U+FFFD — which is what makes it a safe last
 * resort for a body of unknown encoding.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  const scratch = new Uint16Array(Math.min(DECODE_CHUNK, bytes.length))
  let out = ''
  for (let start = 0; start < bytes.length; start += DECODE_CHUNK) {
    const end = Math.min(start + DECODE_CHUNK, bytes.length)
    const length = end - start
    for (let i = 0; i < length; i++) {
      const byte = bytes[start + i]
      scratch[i] = byte >= 0x80 && byte <= 0x9f ? CP1252_C1[byte - 0x80] : byte
    }
    out += String.fromCharCode.apply(null, scratch.subarray(0, length) as unknown as number[])
  }
  return out
}

type Decoded = { html: string; encoding: string }

/**
 * Returns null — rather than throwing — when `TextDecoder` does not recognize
 * the label. A site declaring a charset we have never heard of is a page we
 * should still import, not an import that fails.
 *
 * `TextDecoder` is still what canonicalizes the label (so `latin1`, `cp1252`,
 * `ISO_8859-1:1987` and friends all resolve to `windows-1252` the way the
 * Encoding Standard says they must), but the windows-1252 family is then
 * decoded by our own table rather than the platform's.
 */
function tryDecode(bytes: Uint8Array, label: string): Decoded | null {
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(label)
  } catch {
    return null
  }
  if (decoder.encoding === 'windows-1252') {
    return { html: decodeWindows1252(bytes), encoding: 'windows-1252' }
  }
  return { html: decoder.decode(bytes), encoding: decoder.encoding }
}

/**
 * The no-declaration case: UTF-8 first, strictly.
 *
 * A body that is valid UTF-8 is decoded as UTF-8 — so the overwhelmingly
 * common modern page cannot regress, and a correct UTF-8 decode is exact.
 * A body that is NOT valid UTF-8 cannot have been UTF-8, so decoding it as
 * UTF-8 would be guaranteed mojibake; windows-1252 is the right guess for
 * what it actually is (it is what browsers default to in a Western locale,
 * it is the encoding legacy food blogs are served in, and it maps all 256
 * byte values, so it never produces U+FFFD itself).
 *
 * The tradeoff: a genuinely-UTF-8 page carrying a handful of corrupt bytes
 * gets read as windows-1252 wholesale instead of losing just those bytes.
 * That is rare, it is recorded in `encoding`, and it is recoverable — the
 * original bytes ride along on `FetchedPage`.
 */
function decodeUndeclared(bytes: Uint8Array): Decoded {
  try {
    return { html: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    return { html: decodeWindows1252(bytes), encoding: 'windows-1252' }
  }
}

/**
 * Precedence: BOM, then the Content-Type `charset` parameter, then an in-band
 * `<meta charset>`, then the undeclared-body fallback above. A declaration
 * `TextDecoder` cannot honor is skipped rather than fatal, so a garbage
 * charset degrades to the next candidate instead of failing the import.
 */
function decodeBody(bytes: Uint8Array, contentTypeHeader: string | null): Decoded {
  const candidates = [
    encodingFromBom(bytes),
    charsetFromContentType(contentTypeHeader),
    charsetFromMeta(bytes),
  ]

  for (const label of candidates) {
    if (!label) continue
    const decoded = tryDecode(bytes, label)
    if (decoded) return decoded
  }

  return decodeUndeclared(bytes)
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

    // Read bytes, not text. `response.text()` would decide the encoding for us
    // — always UTF-8 — and hand back a string that has already lost whatever
    // the server actually sent.
    const bytes = new Uint8Array(await response.arrayBuffer())

    // Cap on the byte length, which is what actually bounds memory, and is
    // known before we pay to decode anything.
    if (bytes.byteLength > MAX_BYTES) {
      throw new FetchFailedError(
        url,
        `response too large (${bytes.byteLength} bytes exceeds ${MAX_BYTES} byte cap)`
      )
    }

    const { html, encoding } = decodeBody(bytes, response.headers?.get('content-type') ?? null)

    return {
      html,
      bytes,
      encoding,
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
