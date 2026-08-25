/**
 * Presentation helpers for the recipe page.
 *
 * `formatMinutes` is duplicated from `src/components/library/recipe-card.tsx`
 * rather than shared, and that is a deliberate (small) cost: the card and the
 * recipe page must agree — "1h 10m" on one surface and "1h10" on the other
 * reads as a bug — but the card lives in another agent's file tree during this
 * task. If a third surface ever needs it, lift both into `src/lib/library` and
 * delete these.
 */

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * A taxonomy value as a person would read it: `slow-cooker` -> `Slow cooker`,
 * `middle-eastern` -> `Middle eastern`.
 *
 * Only the first letter is capitalized, on purpose. Title-casing every word
 * would render the free-tag facet — an open vocabulary the user types
 * themselves — as `Weeknight Dinner For Two`, which is not what they wrote.
 */
export function humanizeTagValue(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim()
  if (spaced === '') return value
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * How long the narrative is, phrased so a reader can decide whether to open
 * it without opening it.
 *
 * Under 100 words the exact count is small enough to be meaningful ("62
 * words" — that's a paragraph, go ahead). Above it the exact number is false
 * precision, and what matters is the order of magnitude: 250 words is a
 * detour, 1,800 is the thing the user left Notion to escape. So it rounds to
 * the nearest 50 and says "about".
 */
export function describeWordCount(words: number): string {
  if (words < 100) return `${words} ${words === 1 ? 'word' : 'words'}`
  const rounded = Math.round(words / 50) * 50
  return `about ${rounded.toLocaleString('en-US')} words`
}

/**
 * Word count of already-sanitized HTML.
 *
 * The tag-stripping regex here is a *counting* aid and nothing more — its
 * output is never rendered, never inserted into the DOM, and never trusted.
 * The security boundary is `sanitizeNarrative`, which has already run on this
 * string by the time it gets here.
 */
export function countWords(sanitizedHtml: string): number {
  const text = sanitizedHtml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim()
  if (text === '') return 0
  return text.split(/\s+/).length
}
