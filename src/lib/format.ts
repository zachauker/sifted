/**
 * Presentation helpers shared across surfaces.
 *
 * `formatMinutes` lives here rather than beside either of its callers because
 * it had been copied into both: `src/components/recipe/format.ts` and
 * `src/components/library/recipe-card.tsx` each carried an identical copy,
 * written while those two trees were owned by different agents and could not
 * import from one another. Two copies of a formatter is a bug report waiting
 * to happen — the day one of them learns to say "1h10" and the other still
 * says "1h 10m", the same recipe reads as two different durations depending on
 * whether you are looking at the card or the page.
 *
 * `src/lib/` rather than `src/lib/library/` (which the old comment in
 * `components/recipe/format.ts` proposed) because the recipe page is not the
 * library, and a duration formatter is not filtering logic. Nothing here may
 * import from a component tree, which is what keeps it importable from both.
 */

/**
 * A duration as a cook reads it: `45` -> `45m`, `70` -> `1h 10m`, `120` ->
 * `2h`.
 *
 * The bare `2h` for a whole number of hours is deliberate — "2h 0m" is noise,
 * and this string is read at a glance on a phone in a kitchen.
 */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}
