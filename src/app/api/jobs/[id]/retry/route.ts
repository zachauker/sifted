import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { getJob } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'
import { createAnthropicClient } from '@/lib/llm/anthropic-client'
import { fetchPage } from '@/lib/fetch'
import { ingestHeroImage } from '@/lib/images'

/**
 * Session-authenticated retry for a job the tray shows as failed (or for a
 * `queued` job whose function never ran). Re-queues in the background the
 * same way the original import did.
 *
 * The optional `html` body is the recovery path for a `blocked` job: a
 * publisher that refuses our datacenter IP will refuse it again, so an
 * unchanged retry is pointless. HTML pasted from a browser on a residential
 * connection is the only way forward for that kind of failure.
 */

const MAX_HTML_BYTES = 5 * 1024 * 1024
const MAX_BODY_BYTES = MAX_HTML_BYTES + 4096

const bodySchema = z.object({
  html: z.string().nullish(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const job = await getJob(db, id)
  if (!job) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  // Never fan out two runs for one job: `markRunning` inside `runImport`
  // would just race itself, and the tray would show one job with two
  // concurrent attempts writing to the same recipe row.
  if (job.status === 'running') {
    return NextResponse.json({ error: 'job already running' }, { status: 409 })
  }

  // A request with no body at all must work — that's the ordinary retry
  // path with nothing pasted. `request.text()` on an empty body returns ''
  // rather than throwing, unlike `request.json()`.
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'html too large' }, { status: 413 })
  }

  let suppliedHtml: string | null = null
  if (raw) {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 })
    }

    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 })
    }

    // Same rule as the initial import: an empty string is not "html was
    // supplied".
    suppliedHtml = parsed.data.html ? parsed.data.html : null
    if (suppliedHtml && Buffer.byteLength(suppliedHtml, 'utf8') > MAX_HTML_BYTES) {
      return NextResponse.json({ error: 'html too large' }, { status: 413 })
    }
  }

  waitUntil(
    runImport({
      db,
      store: createVercelBlobStore(),
      llm: createAnthropicClient(),
      jobId: job.id,
      url: job.url,
      addedBy: job.requestedBy,
      suppliedHtml,
      fetchPage,
      ingestHeroImage,
    }),
  )

  return NextResponse.json({ status: 'queued', jobId: job.id }, { status: 202 })
}
