import { db } from '@/lib/db'
import { listJobs } from '@/lib/db/queries/jobs'
import { NeedsAttentionTray } from '@/components/jobs/needs-attention-tray'

/**
 * Failure has to surface somewhere, because imports run in the background:
 * `POST /api/import` answers in under a second and the real work — fetch,
 * extract, enrich, store — finishes later, unattended. This is where that
 * later finish becomes visible. See `NeedsAttentionTray` for what "visible"
 * means per `failureKind`.
 *
 * `listJobs` caps at 50 rows, newest first. For the day-to-day case (a share
 * or two a week) that is every job that has ever existed. It is not enough
 * after a bulk event: the 156-recipe Notion migration replayed every import
 * in one burst, and if a meaningful fraction of those failed, only the
 * newest 50 of *all* jobs — successes included — would be visible here, and
 * older failures would be invisible with no indication anything was cut off.
 * Widening this page past a flat "show the newest 50" (pagination, or a
 * status-filtered query) is real scope this task doesn't cover; flagged here
 * rather than fixed silently.
 */
export default async function NeedsAttentionPage() {
  const jobs = await listJobs(db)

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="mb-1 text-xl font-semibold">Needs attention</h1>
      <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
        Imports that failed, or that haven&apos;t finished yet.
      </p>
      <NeedsAttentionTray jobs={jobs} />
    </div>
  )
}
