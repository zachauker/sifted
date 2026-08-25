import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { getJob, markFailed } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'
import type { BlobStore } from '@/lib/storage'
import { createAnthropicClient } from '@/lib/llm/anthropic-client'
import type { LlmClient } from '@/lib/extract/llm-types'
import { fetchPage, MAX_BYTES as MAX_FETCHED_BYTES } from '@/lib/fetch'
import { ingestHeroImage } from '@/lib/images'

/**
 * Vercel kills a function once it exceeds this many seconds, and `waitUntil`
 * only keeps background work alive up to that same ceiling — so this must be
 * at least the worst-case sum of every budget the import can spend:
 * fetch (20s, `TIMEOUT_MS` in `@/lib/fetch`) + extraction (25s,
 * `DEFAULT_EXTRACT_BUDGET_MS` in `run-import.ts`) + hero image ingestion
 * (15s, see `@/lib/images`) = 60s. Bump this if any of those three budgets
 * grow.
 */
export const maxDuration = 60

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

// Supplied/pasted HTML skips `fetchPage` entirely and goes straight into the
// same JSDOM parses a fetched page does, so it must never be allowed past the
// size that pipeline is documented as able to survive (see `MAX_BYTES` and
// its comment in `@/lib/fetch`). Importing the constant, rather than
// redeclaring a number here, is what keeps the two from drifting apart again.
const MAX_HTML_BYTES = MAX_FETCHED_BYTES
const MAX_BODY_BYTES = MAX_HTML_BYTES + 4096

const bodySchema = z.object({
  html: z.string().nullish(),
})

// The only statuses a retry may act on. `running` is excluded so a retry
// never fans out a second concurrent attempt at the same job. `duplicate`
// and `done` are excluded too: retrying a `duplicate` job would re-fetch,
// re-extract and pay for the model again just to overwrite the recipe it
// merely pointed at, leaving two `done` jobs on one recipe with no record
// that the second share was ever a duplicate; retrying a `done` job is the
// same pointless re-spend with nothing broken to fix. Only `failed` (a real
// error to recover from) and `queued` (a function that apparently never ran)
// describe a job retrying can actually help.
const RETRYABLE_STATUSES = new Set(['failed', 'queued'])

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
  if (!RETRYABLE_STATUSES.has(job.status)) {
    return NextResponse.json(
      { error: `cannot retry a job with status ${job.status}` },
      { status: 409 },
    )
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

  // `createVercelBlobStore` and `createAnthropicClient` throw synchronously
  // when their env var is unset. See the matching comment in
  // `src/app/api/import/route.ts` for the full reasoning: catching it here
  // and marking the job failed turns what would otherwise be a 500 plus a
  // job stranded on its pre-retry status into a normal, visible, recorded
  // failure — and 202 is still the right response because the job row
  // already reflects that outcome by the time we respond.
  let deps: { store: BlobStore; llm: LlmClient }
  try {
    deps = { store: createVercelBlobStore(), llm: createAnthropicClient() }
  } catch (error) {
    await markFailed(db, job.id, 'internal', error)
    return NextResponse.json({ status: 'queued', jobId: job.id }, { status: 202 })
  }

  waitUntil(
    runImport({
      db,
      store: deps.store,
      llm: deps.llm,
      jobId: job.id,
      url: job.url,
      addedBy: job.requestedBy,
      suppliedHtml,
      // A human pressed retry, so re-extracting over an existing recipe is the
      // point rather than a duplicate to skip. Without this, retrying a job
      // whose canonical URL already has a row is marked `duplicate` and does
      // nothing — a button that silently no-ops.
      allowExistingUpdate: true,
      fetchPage,
      ingestHeroImage,
    }),
  )

  return NextResponse.json({ status: 'queued', jobId: job.id }, { status: 202 })
}
