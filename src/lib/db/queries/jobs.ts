import { desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { importJobs } from '@/lib/db/schema'

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
