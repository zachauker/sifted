import sanitizeHtml from 'sanitize-html'

/**
 * Render-time sanitization for stored third-party HTML.
 *
 * `recipes.narrativeHtml` holds the author's article prose, lifted off an
 * arbitrary food blog by `@mozilla/readability`. Readability removes `<script>`
 * and `<style>` *elements*, but it does not touch attributes: `<p onclick=...>`
 * and `<img onerror=...>` were both measured passing through unchanged into the
 * stored column. Ingredient `rawText` and step text are untrusted strings from
 * the same source. So the stored value is attacker-influenced markup, and it is
 * rendered into a page that sits behind the user's session and shows their whole
 * recipe library.
 *
 * ## Why this runs at render time and not at extract time
 *
 * Sanitizing on the way *in* is tempting -- it happens once per import rather
 * than once per render -- but it is the wrong boundary, for two reasons.
 *
 * First, doing it in both places is worse than doing it in one. A render layer
 * that believes its input was already cleaned is a render layer that will one day
 * be handed something that was not: a row imported before the rule existed, a
 * backfill script, a migration from Notion, a future ingestion path that skipped
 * the pipeline. The only assumption that stays true is "everything reaching a
 * raw-HTML sink is hostile", and that assumption only holds if the sink is the
 * thing that enforces it. `tests/lib/sanitize-render-guard.test.ts` enforces
 * exactly that: one `dangerouslySetInnerHTML` in the codebase, and it references
 * this function.
 *
 * Second, the stored value should stay faithful to what the source actually said.
 * Today's allowlist drops `<table>` and `<video>`; a narrative that wanted them
 * loses them forever if the loss is baked into the row. Keeping the original
 * means a future re-render can do better than today's rules, and means a bug in
 * this file is a deploy away from being fixed rather than a re-import of every
 * recipe ever saved.
 *
 * ## Allowlist, never denylist
 *
 * Everything below is an allowlist. A denylist of dangerous tags is a losing game
 * -- it has to be right about every element, attribute, and scheme that browsers
 * have shipped or will ship. Anything not named here is dropped.
 *
 * ## Server-side only
 *
 * This module carries no client directive, so under the App Router it stays on
 * the server unless a Client Component imports it -- at which point Next would
 * bundle all of `sanitize-html` into the browser payload for no benefit. Call it
 * from the Server Component that renders the narrative; the sanitized string is
 * what should cross to the browser, not the sanitizer. There is no
 * `server-only` guard import because that package throws outside a react-server
 * condition and would break this module under Vitest; the guard test asserts the
 * absence of a client directive instead.
 */

/** Prose markup Readability actually emits for an article body. */
const ALLOWED_TAGS = [
  'p',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'blockquote',
  'em',
  'strong',
  'i',
  'b',
  'code',
  'pre',
  'sub',
  'sup',
  'del',
  's',
  'hr',
  'a',
  'img',
  'figure',
  'figcaption',
  'br',
]

/**
 * Attributes, per tag. There is no `'*'` entry on purpose: an allowlist that
 * applies to every tag is how `style`, `class`, and `id` creep back in.
 *
 * `style` is excluded outright rather than filtered by property. The narrative is
 * rendered inside a collapsed fold on a page it does not own, and CSS alone is
 * enough to escape that fold -- `position:fixed;inset:0` over the whole viewport,
 * or a background image pointing at an attacker's server to phone home when the
 * page loads. `class` and `id` are excluded for the smaller version of the same
 * problem: they let the narrative reach into the app's own stylesheet.
 *
 * `srcset` is excluded because it is a second URL-bearing attribute with its own
 * parser and its own bugs, and dropping it costs the reader nothing but a
 * higher-resolution variant.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
}

/**
 * `script` and `style` are in sanitize-html's default `nonTextTags`, meaning
 * their *text content* is discarded along with the tag rather than surfacing as
 * visible prose -- `<p>a<script>alert(1)</script>b</p>` renders "ab", not
 * "aalert(1)b". `iframe` and `noscript` are added for the same reason: their
 * bodies are fallback content, not narrative.
 *
 * Every other disallowed element (`div`, `table`, `svg`, `form`, ...) keeps its
 * text, so unwrapping a layout element never silently eats a sentence.
 */
const NON_TEXT_TAGS = ['script', 'style', 'textarea', 'option', 'noscript', 'iframe']

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  nonTextTags: NON_TEXT_TAGS,
  disallowedTagsMode: 'discard',
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto'],
    img: ['http', 'https'],
  },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  // `//evil.example/x` inherits the page's scheme and reads as a relative URL to
  // a careless eye. Nothing in a stored narrative needs it.
  allowProtocolRelative: false,
  allowedClasses: {},
  allowVulnerableTags: false,
  enforceHtmlBoundary: false,
  transformTags: {
    // Applied to every anchor, not just ones missing the attributes: an
    // author-supplied `rel="opener"` or `target="_top"` is overwritten, so the
    // narrative cannot reach `window.opener` or navigate the app's own frame.
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'noopener noreferrer',
      target: '_blank',
    }),
  },
}

/**
 * Strip everything executable or page-altering from a stored narrative, keeping
 * the prose.
 *
 * Returns `''` for null, undefined, empty, and whitespace-only input so callers
 * can render the result unconditionally instead of branching.
 *
 * Idempotent: the output is itself valid input, and sanitizing it again is a
 * no-op. `tests/lib/sanitize.test.ts` pins this, because the recipe page may
 * sanitize the same value more than once per render pass.
 */
export function sanitizeNarrative(html: string | null | undefined): string {
  if (!html || html.trim() === '') return ''
  return sanitizeHtml(html, OPTIONS)
}
