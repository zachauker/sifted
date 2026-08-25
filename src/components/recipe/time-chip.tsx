import { formatMinutes } from '@/lib/format'

/**
 * What the publisher claimed, beside what it actually took.
 *
 * This is the feature the user asked for by name, and it is the one number on
 * the page that exists nowhere else in the world. Recipe sites systematically
 * understate time — the 35-minute weeknight dinner that reliably takes an hour
 * and ten — and every cook privately re-learns the same corrections. Keeping
 * both numbers side by side is how the household stops re-learning them: the
 * claim is what the source said, `took us` is what this kitchen measured, and
 * the gap between them is the institutional knowledge the app accumulates.
 *
 * Which is why they are shown *together* rather than the measured time simply
 * overwriting the claim. "took us 1h 10m" alone is useful; "claims 35m · took
 * us 1h 10m" tells you not to trust this publisher's next estimate either.
 *
 * With only a claim, just the claim. With only a measurement (a recipe typed
 * in by hand, or rescued from Notion with a time we recorded ourselves), just
 * that. With neither, nothing at all — an empty chip reading "—" is furniture
 * that costs a glance on every recipe that has no time, which after the
 * migration is a great many of them.
 */
export function TimeChip({
  claimedMinutes,
  actualMinutes,
}: {
  claimedMinutes: number | null
  actualMinutes: number | null
}) {
  if (claimedMinutes === null && actualMinutes === null) return null

  return (
    // Inline, not flex: the separator is a text node with real spaces around
    // it, and a flex container would trim them and glue the two halves
    // together.
    <p className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-sm dark:bg-neutral-800">
      {claimedMinutes !== null && (
        <span className="text-neutral-500 dark:text-neutral-400">
          claims {formatMinutes(claimedMinutes)}
        </span>
      )}
      {claimedMinutes !== null && actualMinutes !== null && (
        <span aria-hidden="true" className="text-neutral-400 dark:text-neutral-600">
          {' · '}
        </span>
      )}
      {actualMinutes !== null && (
        <span className="font-medium">took us {formatMinutes(actualMinutes)}</span>
      )}
    </p>
  )
}
