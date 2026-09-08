import { parseHTML } from 'linkedom'

/**
 * The single place this app turns HTML into a DOM.
 *
 * It is linkedom rather than jsdom, and that is not a preference — it is the
 * only one of the two that can be loaded at all in the deployed runtime.
 * Vercel's Node starts functions with `--no-experimental-require-module`, so
 * `require()` of an ES module throws; jsdom reaches `@exodus/bytes`, which is
 * ESM-only, from CommonJS. The result was not a degraded import but a dead one:
 * the failure happens while the route module is still evaluating, so every
 * route that extracts returned a bare 500 before any handler code ran — no job
 * row, nothing in the needs-attention tray, and an iOS Shortcut reporting only
 * "the network connection was lost". `/api/health` reports the flag directly.
 *
 * Nothing about jsdom's *behaviour* was wrong, so the goal here is to be
 * uninteresting: same parsing, same queries, no new failure modes. linkedom is
 * pure JavaScript with no native bindings and no files read from disk at
 * runtime, which is also what made bundling jsdom impossible (it reads
 * `default-stylesheet.css` relative to its own path).
 *
 * The one real difference is the base URL, and it matters. jsdom takes a `url`
 * option and resolves relative hrefs against it; linkedom has no such option,
 * and Readability then leaves `/recipe/x` relative — which is exactly the bug
 * that was already fixed once here, when Readability was resolving against a
 * hardcoded `https://example.com/`. A `<base href>` element gives linkedom the
 * same `document.baseURI` jsdom would have had.
 */
export function parseDocument(html: string, baseUrl?: string): Document {
  let { document } = parseHTML(html)

  // jsdom always produced a full `<html><head></head><body>…</body></html>`,
  // wrapping a bare fragment on the way in. linkedom does not: given
  // `<div>…</div>` it makes that div the `documentElement` and synthesises an
  // **empty** `body` alongside it. Every caller here reads `document.body`, so
  // without this a fragment parses to a document whose text is silently empty —
  // which is precisely how this first went wrong: `extractNarrative` re-parses
  // Readability's own output (a `<div id="readability-page-1">` fragment), found
  // an empty body, and returned null for every page on the site.
  //
  // Re-parsing wrapped is cheap next to getting it wrong, and it restores the
  // one jsdom behaviour the rest of this directory was written against.
  if (document.documentElement?.tagName !== 'HTML') {
    ;({ document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`))
  }

  if (baseUrl) {
    // Only when the page does not set one itself. A page's own `<base>` is
    // authoritative — it is how a site tells everyone, us included, where its
    // relative URLs point — and jsdom behaves the same way: the document URL is
    // the fallback, and a `<base>` element overrides it. Inserting ours
    // unconditionally would silently re-point every relative URL on any page
    // that serves its assets from a different origin.
    if (!document.querySelector('base[href]')) {
      const base = document.createElement('base')
      base.setAttribute('href', baseUrl)
      // `head` can genuinely be absent on a fragment, which several callers
      // parse — a bare `<div>…</div>` has no head, and appending to null throws.
      const head = document.head ?? document.documentElement
      head?.insertBefore(base, head.firstChild)
    }
  }

  return document as unknown as Document
}

/**
 * An HTML fragment as an element, the way `new JSDOM(fragment).window.document.body`
 * used to give it. Null only when the fragment has no content at all.
 */
export function parseFragment(html: string): Element | null {
  return parseDocument(html).body
}
