import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { getJob } from '@/lib/db/queries/jobs'

/**
 * Session-authenticated status of a single import job, by id.
 *
 * Exists for `UrlImportForm`'s poller, which already knows the exact job id
 * it is waiting on (the `POST /api/recipes/import` response that started the
 * polling). It used to find that job by scanning `GET /api/jobs` — `listJobs`
 * under the hood — which defaults to the newest 50 rows of *every* status.
 * During a migration burst the job it's polling for can fall out of that
 * window entirely (the same 156-recipe-burst shape `tests/db/jobs.test.ts`
 * and `countJobsNeedingAttention` exist for), and the poller then runs its
 * full 60s timeout for an import that actually finished fine seconds in.
 * `getJob` looks the row up by id directly, with nothing to fall out of.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const job = await getJob(db, id)
  if (!job) {
    return NextResponse.json({ job: null }, { status: 404 })
  }
  return NextResponse.json({ job })
}
