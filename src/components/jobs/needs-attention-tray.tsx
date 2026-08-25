'use client'

import { useMemo, useState } from 'react'
import { JobCard } from './job-card'
import type { Job } from './types'

const DISMISSED_KEY = 'recipe-manager:needs-attention:dismissed'

/**
 * `no_recipe` jobs can be "removed" from the tray (see `failure-copy.ts`),
 * but there is no delete endpoint for `import_jobs` — this task's file
 * ownership is the tray UI, and `GET /api/jobs` plus the retry endpoint are
 * the only job endpoints in scope. So "remove" is a client-side dismissal,
 * persisted in `localStorage` so it survives a reload on the device that
 * dismissed it, rather than an illusion that resets the moment the page is
 * refreshed. It is described to the user as exactly that — see the copy in
 * `job-card.tsx` — nothing is deleted server-side.
 */
function loadDismissed(): ReadonlySet<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function saveDismissed(ids: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]))
  } catch {
    // Private browsing, storage full, etc. — dismissal just won't survive a
    // reload on this device. Not worth failing the interaction over.
  }
}

/**
 * The needs-attention tray: everything a background import might need a
 * human to look at.
 *
 * `done` and `duplicate` jobs are filtered out entirely rather than shown
 * "resolved" — they are the two outcomes that need nothing from anyone, and
 * this screen exists to be short and worth checking. The library and the
 * job's own history (via `recipeId`) are where a finished import belongs.
 *
 * This is a snapshot of the `listJobs` rows passed in as props at render
 * time, not a live view — see the comment on `SentNotice` in `job-card.tsx`
 * for what that means after a retry is submitted.
 */
export function NeedsAttentionTray({ jobs }: { jobs: Job[] }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => loadDismissed())

  const visible = useMemo(
    () =>
      jobs.filter(
        (job) => job.status !== 'done' && job.status !== 'duplicate' && !dismissed.has(job.id),
      ),
    [jobs, dismissed],
  )

  const dismiss = (id: string) => {
    setDismissed((current) => {
      const next = new Set(current)
      next.add(id)
      saveDismissed(next)
      return next
    })
  }

  if (visible.length === 0) {
    return (
      <p className="rounded border border-black/10 p-4 text-sm text-neutral-600 dark:border-white/10 dark:text-neutral-400">
        Nothing needs attention.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {visible.map((job) => (
        <JobCard key={job.id} job={job} onDismiss={dismiss} />
      ))}
    </ul>
  )
}
