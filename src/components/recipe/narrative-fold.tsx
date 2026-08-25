import { sanitizeNarrative } from '@/lib/sanitize'
import { countWords, describeWordCount } from './format'

/**
 * The author's article, folded away underneath the recipe.
 *
 * ## Why this component exists at all
 *
 * The whole project exists because Notion's web clipper dumps the entire
 * article, so every saved recipe is buried under a thousand words about the
 * summer the author spent in Liguria — and cooking from it means scrolling
 * past that, every single time. Deleting the story instead would have been the
 * easy answer and the wrong one: the "why" is occasionally the best part of a
 * recipe, and it can never be recovered once dropped. So it survives, exactly
 * once, at the bottom, closed.
 *
 * ## Why `<details>` and not a state hook
 *
 * A disclosure is the one interaction the platform already implements
 * completely: keyboard operable, exposed to screen readers as a disclosure,
 * searchable by the browser's own find-in-page (Chrome and Safari open a
 * closed `<details>` to reveal a hit), and — the point — it needs no
 * JavaScript at all. A `useState` version would make this the page's only
 * Client Component, ship a hydration payload, and render the story *open* in
 * the server HTML for the moment before hydration, which is precisely the
 * thing being avoided.
 *
 * ## The only raw-HTML sink in the codebase
 *
 * `narrativeHtml` is third-party markup from arbitrary food blogs. Readability
 * strips `<script>` elements but leaves inline handlers untouched — `onclick`
 * and `onerror` were both measured surviving into the stored column — so this
 * value is attacker-influenced, and it is rendered into a page sitting behind
 * the user's session. Every character of it goes through `sanitizeNarrative`
 * first. `tests/lib/sanitize-render-guard.test.ts` enforces that this stays
 * the only `dangerouslySetInnerHTML` in `src`, and that it references the
 * sanitizer.
 *
 * Sanitizing happens here, in a Server Component, and not in the browser: the
 * sanitized *string* is what crosses to the client, not the ~195 KB parser
 * that produced it.
 */
export function NarrativeFold({
  html,
  publisher,
}: {
  html: string | null
  publisher: string | null
}) {
  const clean = sanitizeNarrative(html)
  const words = countWords(clean)

  // A narrative that is only markup ("<div><span> </span></div>", which
  // Readability does occasionally produce) sanitizes down to nothing. It must
  // not grow a fold that opens onto an empty box — a control that lies about
  // having content behind it is worse than no control.
  if (words === 0) return null

  const label = publisher ? `The story from ${publisher}` : 'The original article'

  return (
    <details className="mt-10 border-t border-black/10 pt-4 dark:border-white/10">
      <summary className="cursor-pointer list-none text-sm text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
        <span className="mr-1 inline-block transition-transform" aria-hidden="true">
          ▸
        </span>
        {label} — {describeWordCount(words)}
      </summary>
      <div
        className="prose mt-4 max-w-prose text-sm leading-relaxed text-neutral-600 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h2]:mt-6 [&_h2]:font-medium [&_h3]:mt-6 [&_h3]:font-medium [&_img]:my-4 [&_img]:max-w-full [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 dark:text-neutral-400"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    </details>
  )
}
