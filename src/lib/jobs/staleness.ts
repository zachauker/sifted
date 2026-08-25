/**
 * How long a job may claim to be `running` before we treat it as dead.
 *
 * The worst case a legitimate import can spend is the sum of its three
 * budgets — fetch 20s, extraction 25s, hero image 15s — which is exactly why
 * the import routes set `maxDuration = 60`. The platform kills the function at
 * that ceiling, so a row still `running` well past it was cut short with
 * nothing left alive to record the failure.
 *
 * Five minutes is five times that budget: far enough out to never race a
 * function that is merely slow through a cold start, close enough that a wedged
 * URL recovers inside anyone's patience.
 */
export const STALE_RUNNING_MS = 5 * 60 * 1000

/**
 * True when a job claims to be running but cannot be.
 *
 * Without this, such a row is a permanent wedge: the tray shows "in progress"
 * forever, and `findInFlightJob` refuses every future import of that URL.
 *
 * Deliberately dependency-free so the tray — a Client Component — can share
 * one definition with the query layer instead of keeping a second copy that
 * drifts. Importing it from `lib/db/queries/jobs` would pull Drizzle and the
 * libsql driver into the browser bundle.
 */
export function isStaleRunning(job: { status: string; createdAt?: Date | null }): boolean {
  if (job.status !== 'running') return false

  // Without a usable timestamp we cannot tell a wedged job from a healthy one,
  // and the two mistakes are not symmetric: calling a live import dead lets a
  // second one race it, while calling a dead one live costs at most a wait for
  // the next page load. So an unreadable date means "still running".
  const startedAt = job.createdAt?.getTime()
  if (startedAt === undefined || Number.isNaN(startedAt)) return false

  return Date.now() - startedAt > STALE_RUNNING_MS
}
