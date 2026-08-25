import { db } from '@/lib/db'
import { listJobsNeedingAttention } from '@/lib/db/queries/jobs'
import { NeedsAttentionTray } from '@/components/jobs/needs-attention-tray'

/**
 * Failure has to surface somewhere, because imports run in the background:
 * `POST /api/import` answers in under a second and the real work — fetch,
 * extract, enrich, store — finishes later, unattended. This is where that
 * later finish becomes visible. See `NeedsAttentionTray` for what "visible"
 * means per `failureKind`.
 *
 * Deliberately `listJobsNeedingAttention`, not `listJobs`. `listJobs` caps
 * at the newest 50 rows of *every* status, and the 156-recipe Notion
 * migration replays every import in one burst — a fixed-size window of "the
 * newest N" can be dominated by successes and miss an older failure
 * entirely, with nothing telling anyone it was cut off. Selecting on
 * `failed` / `running` / `queued` directly, with no row cap, means the row
 * is there regardless of how much traffic came after it.
 */
export default async function NeedsAttentionPage() {
  const jobs = await listJobsNeedingAttention(db)

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
