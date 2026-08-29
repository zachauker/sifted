import { JSDOM } from 'jsdom'

/**
 * The hero image a page advertises to link previews.
 *
 * Nothing in the normal extraction path reads this: a recipe's picture comes
 * from its JSON-LD or microdata, and when neither is present the model is asked
 * for it. This exists for repair rather than import — a recipe already stored
 * without a picture, whose page cannot be re-extracted cheaply (or at all,
 * because the publisher now refuses us) can still usually be given one, because
 * `og:image` survives in the archived HTML and points at a CDN that is far less
 * likely to block us than the page itself was.
 *
 * Ordered by how deliberate the choice is: `og:image` is what the publisher
 * chose to represent the page, `twitter:image` is the same idea, and
 * `<link rel="image_src">` is the old convention some recipe sites still emit.
 *
 * Pure, like everything else in `lib/extract` — it is handed HTML and returns a
 * URL, and never fetches anything.
 */
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:'])

const SELECTORS = [
  'meta[property="og:image:secure_url"]',
  'meta[property="og:image"]',
  'meta[name="og:image"]',
  'meta[property="twitter:image"]',
  'meta[name="twitter:image"]',
  'meta[name="twitter:image:src"]',
  'link[rel="image_src"]',
]

export function findOgImage(html: string, baseUrl: string): string | null {
  let doc: Document
  try {
    doc = new JSDOM(html, { url: baseUrl }).window.document
  } catch {
    return null
  }

  for (const selector of SELECTORS) {
    for (const el of doc.querySelectorAll(selector)) {
      const raw = (el.getAttribute('content') ?? el.getAttribute('href') ?? '').trim()
      if (!raw) continue
      try {
        const resolved = new URL(raw, baseUrl)
        // Same rule as `resolveImageUrl`: `new URL` validates syntax, not
        // scheme, and a `javascript:` or `file:` value would otherwise be
        // stored as a hero image and later handed to fetch.
        if (!SAFE_IMAGE_PROTOCOLS.has(resolved.protocol)) continue
        return resolved.toString()
      } catch {
        continue
      }
    }
  }
  return null
}
