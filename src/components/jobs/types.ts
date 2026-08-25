import type { FailureKind } from '@/lib/db/queries/jobs'

/**
 * Shaped to match a row from `listJobs`, but declared independently rather
 * than imported from `@/lib/db/schema`. `needs-attention-tray.tsx` and
 * `job-card.tsx` are client components; the schema module exists to be
 * bundled with the Drizzle driver on the server, and there is no reason for
 * this small, stable shape to drag that boundary into question.
 */
export type Job = {
  id: string
  url: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'duplicate'
  failureKind: FailureKind | null
  error: string | null
  recipeId: string | null
  requestedBy: string | null
  createdAt: Date
  finishedAt: Date | null
}
