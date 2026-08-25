import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { listJobs } from '@/lib/db/queries/jobs'

/**
 * Session-authenticated (the browser UI, not the Shortcut) list of import
 * jobs, newest first. This is what the needs-attention tray reads.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const jobs = await listJobs(db)
  return NextResponse.json({ jobs })
}
