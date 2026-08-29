import { STALE_RUNNING_MS } from '@/lib/jobs/staleness'
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { importJobs, recipes } from '@/lib/db/schema'

/**
 * The import job row is the only thing the user can see while a background
 * import is running, and the only record of it once the function that ran it is
 * gone. Every state transition lives here so there is one place that knows what
 * a finished job looks like.
 */

/**
 * Why the kinds are distinct: the recovery paths differ.
 *
 * - `blocked`      the publisher refuses our datacenter IP and will refuse it
 *                  again, so an unchanged retry is pointless; recovery is HTML
 *                  captured from a browser on a residential connection.
 * - `fetch_failed` a transient network or server fault. Worth an ordinary retry.
 * - `no_recipe`    the page has no recipe in it. A retry never will help.
 * - `llm_failed`   the model call failed outright. Worth a retry.
 * - `internal`     a bug, or a budget we blew. Needs a human to look.
 */
export type FailureKind = 'blocked' | 'fetch_failed' | 'no_recipe' | 'llm_failed' | 'internal'

/**
 * A stack trace from a nested dependency can run to tens of kilobytes. The row
 * exists so a human can read what went wrong in the needs-attention tray, and
 * the first 2000 characters always contain that; the rest is only weight in
 * every query that selects the column.
 */
const MAX_ERROR_LENGTH = 2000

function errorText(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : String(error)
  return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH - 1)}…` : raw
}

export async function createJob(
  db: Db,
  url: string,
  requestedBy?: string | null,
): Promise<string> {
  const [row] = await db
    .insert(importJobs)
    .values({ url, status: 'queued', requestedBy: requestedBy ?? null })
    .returning({ id: importJobs.id })
  return row.id
}

/**
 * Clears the previous attempt's failure text as well as setting the status: a
 * job that is running right now must not still be displaying the error from the
 * run before it, or the tray shows a stale reason next to a live spinner.
 */
export async function markRunning(db: Db, jobId: string): Promise<void> {
  await db
    .update(importJobs)
    .set({ status: 'running', error: null, failureKind: null, finishedAt: null })
    .where(eq(importJobs.id, jobId))
}

/**
 * `error` and `failureKind` are cleared explicitly. A retry that finally
 * succeeds must not leave the previous failure's text behind on the row —
 * a `done` job carrying "Blocked by ... (HTTP 403)" is worse than no record at
 * all, because it reads as a bug in the thing that just worked.
 */
export async function markDone(db: Db, jobId: string, recipeId: string): Promise<void> {
  await db
    .update(importJobs)
    .set({
      status: 'done',
      recipeId,
      error: null,
      failureKind: null,
      finishedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId))
}

/** Same clearing rule as `markDone`: this is a successful outcome, not a fault. */
export async function markDuplicate(db: Db, jobId: string, recipeId: string): Promise<void> {
  await db
    .update(importJobs)
    .set({
      status: 'duplicate',
      recipeId,
      error: null,
      failureKind: null,
      finishedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId))
}

export async function markFailed(
  db: Db,
  jobId: string,
  kind: FailureKind,
  error: unknown,
): Promise<void> {
  await db
    .update(importJobs)
    .set({
      status: 'failed',
      failureKind: kind,
      error: errorText(error),
      finishedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId))
}

/**
 * Newest first, and genuinely so.
 *
 * `createdAt` is an INTEGER of *seconds*, so every job queued in the same
 * second ties — which is the normal case, not an edge case: a share sheet
 * queues several at once, an import and the duplicate that follows it land
 * milliseconds apart, and the migration replays 156 imports in a burst. The
 * previous tiebreak was `id DESC`, and cuid2 ids are deliberately not lexically
 * time-ordered (that is the point of the hash in them), so within a tied second
 * the order was effectively random. Observed: an import and its immediately
 * following duplicate came back oldest-first, and "the newest 50" of 156 jobs
 * created in a burst is an arbitrary 50.
 *
 * `rowid` is SQLite's own monotonically increasing insertion counter, so it is
 * exactly the chronological order we mean, at no storage cost and with no
 * migration — the alternative, widening `created_at` to `timestamp_ms`, is a
 * schema change plus a backfill that would still tie under a burst of inserts
 * inside one millisecond. `import_jobs` has a TEXT primary key and is not
 * WITHOUT ROWID, so the column is there.
 *
 * `createdAt` stays as the leading key so the visible ordering still follows
 * the timestamps the tray displays; `rowid` only decides what the timestamps
 * cannot.
 */
export async function listJobs(db: Db, limit = 50) {
  return db
    .select()
    .from(importJobs)
    .orderBy(desc(importJobs.createdAt), sql`${importJobs}.rowid desc`)
    .limit(limit)
}

export async function getJob(db: Db, jobId: string) {
  return db.select().from(importJobs).where(eq(importJobs.id, jobId)).get()
}

/**
 * The rows the needs-attention tray actually needs — `failed`, `running`
 * and `queued` — fetched directly, rather than sliced from `listJobs`'s
 * newest N of *every* status.
 *
 * That slicing is the wrong query for this screen: the migration replays
 * 156 imports in one burst, and if an early one fails while fifty-plus later
 * ones succeed, `listJobs(db, 50)` no longer contains the failure at all —
 * "the newest 50" is dominated by successes, and the tray that exists
 * specifically to surface the failure shows nothing wrong. Filtering after
 * the fact doesn't fix it either, because the failure was never in the page
 * that got fetched. Selecting on `status` directly is the only way the row
 * is guaranteed to be there.
 *
 * No default limit: the set this selects is bounded by how many imports are
 * actually broken or in flight, which has nothing to do with how much
 * traffic the app has ever seen, so there is no traffic-shaped number to cap
 * it at. A caller that wants one may still pass one.
 *
 * Same ordering as `listJobs`, for the same reason: `created_at` only holds
 * seconds, so a burst ties, and `rowid` is what breaks the tie correctly.
 */
/**
 * A job in an attention state whose URL already has a recipe is not something
 * anyone can act on: the import it records failed, and a later one succeeded.
 *
 * Without this the tray counts *attempts* rather than *problems*, and every
 * recovered failure nags forever. Measured on the real library that was 74 of
 * 86 rows — so the one number the tray exists to communicate was wrong by a
 * factor of seven, and the six URLs that genuinely needed a human were buried
 * under rows that did not.
 *
 * Matched on the URL as recorded rather than a canonical form, because that is
 * what the two tables actually share: `runImport` writes the canonical URL to
 * `recipes.source_url`, and a job whose canonical form differs from what was
 * shared is precisely a job whose stored recipe cannot be found by this
 * comparison. Those stay in the tray, which is the safe direction to be wrong
 * in — a recipe you already have shown once too often, rather than a genuine
 * failure hidden.
 */
export async function listJobsNeedingAttention(db: Db, limit?: number) {
  const base = db
    .select()
    .from(importJobs)
    .where(and(
      inArray(importJobs.status, ['failed', 'running', 'queued']),
      sql`not exists (select 1 from ${recipes} where ${recipes.sourceUrl} = ${importJobs.url})`,
    ))
    .orderBy(desc(importJobs.createdAt), sql`${importJobs}.rowid desc`)
  return limit === undefined ? base : base.limit(limit)
}

/**
 * How many rows `listJobsNeedingAttention` would return, without fetching any
 * of them.
 *
 * Exists for the header badge, which runs on every request through the app
 * shell (`src/app/(app)/layout.tsx`) purely to answer "is there anything to
 * look at" — it never renders a row, so pulling full `import_jobs` rows (as
 * `listJobsNeedingAttention` or, worse, the unfiltered `listJobs` would) is
 * pure waste on the most frequently executed query in the app. Same `WHERE`
 * as `listJobsNeedingAttention`, on purpose: the badge and the tray must
 * agree on what "needs attention" means, or the badge can show a count the
 * tray doesn't back up (or vice versa).
 *
 * This — not `listJobs(db)` filtered client-side for `status === 'failed'` —
 * is also the fix for the bug that motivated this function: `listJobs`
 * defaults to the newest 50 rows of *every* status, so a failure sitting
 * behind 50+ newer successes (the 156-recipe migration burst is exactly this
 * shape) fell out of that window and the badge read 0 while the tray it was
 * supposed to summarize still listed the failure. Selecting `count(*)` with
 * the same status filter as the tray has no row cap to fall out of.
 */
export async function countJobsNeedingAttention(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(importJobs)
    .where(and(
      inArray(importJobs.status, ['failed', 'running', 'queued']),
      sql`not exists (select 1 from ${recipes} where ${recipes.sourceUrl} = ${importJobs.url})`,
    ))
  return row?.count ?? 0
}

/**
 * How long a `running` job may stay `running` before `findInFlightJob` stops
 * treating it as in-flight.
 *
 * Bounded with reference to the same three budgets `run-import.ts` and every
 * route that calls it already reason about: fetch (20s, `TIMEOUT_MS` in
 * `@/lib/fetch`) + extraction (25s, `DEFAULT_EXTRACT_BUDGET_MS` in
 * `run-import.ts`) + hero image ingestion (15s, `@/lib/images`) = 60s worst
 * case, which is exactly why `maxDuration = 60` on `/api/import`,
 * `/api/recipes/import` and the retry route. A genuinely in-flight import can
 * never legitimately still be `running` much past that: the platform kills
 * the function at 60s, and `runImport` never throws past its own `catch` (see
 * its docstring), so the row either reaches `done`/`duplicate`/`failed`
 * within that budget or the process is killed out from under it — which is
 * precisely the wedge this bound exists to escape, since a kill mid-flight
 * leaves the row on `running` with nothing left running to finish it.
 *
 * 5 minutes — 5x the 60s worst case — rather than a bound flush against the
 * budget: cold starts, GC pauses and ordinary scheduling jitter can all push
 * a legitimately-still-running function a little past its nominal budget
 * before the platform's kill actually lands, and this is an escape hatch for
 * a *dead* job, not a race against a live one. Treating a job that merely ran
 * long as dead would let a second, wasteful (though not corrupting —
 * `upsertRecipe` keys on `sourceUrl`) import start concurrently with one that
 * was going to finish on its own; treating it as dead only once it is 5x past
 * any legitimate duration keeps that a rare, not a routine, event, while still
 * recovering well within a user's patience for "why is this stuck".
 */


/**
 * Finds an import already under way for a canonical URL.
 *
 * Both capture paths dedupe against *existing recipes* before starting work,
 * but that check cannot see an import that is still running — so sharing the
 * same link twice in quick succession (a double tap on the share sheet, or
 * both phones at once) fetches the page twice, pays for the model twice, and
 * races two runImport calls at one row. `upsertRecipe` keys on `sourceUrl`, so
 * nothing is corrupted, but the work and the spend are wasted and the tray
 * gains a spurious job.
 *
 * `queued` matches at any age — it is retryable (the tray's retry button
 * handles a `queued` job whose function apparently never ran), never
 * wedged, and never the thing this function needs to look past. `running`
 * only matches within `STALE_RUNNING_MS` of `createdAt` — see that constant
 * for why a `running` row past that bound is being treated as dead rather
 * than in flight. `createdAt` rather than a dedicated "entered running"
 * column because `markRunning` sets no such column (only `error`,
 * `failureKind` and `finishedAt` are cleared), and in the ordinary flow
 * (create the row, then kick off `runImport` in the same request) the two
 * land within milliseconds of each other, so `createdAt` stands in for it
 * here without a schema change. The one flow where that proxy runs loose is
 * a retry of an old `failed` job: it reuses the original `createdAt`, so a
 * long-dormant job retried today reads as already-stale the instant it goes
 * `running`. That does not reopen the wedge this function exists to close —
 * it only means a concurrent capture of the same URL is no longer blocked
 * during that retry, which is the same "wasteful, not corrupting" race this
 * function already tolerates elsewhere.
 */
export async function findInFlightJob(db: Db, url: string) {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS)
  return db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.url, url),
        or(
          eq(importJobs.status, 'queued'),
          and(eq(importJobs.status, 'running'), gt(importJobs.createdAt, staleBefore)),
        ),
      ),
    )
    .get()
}

