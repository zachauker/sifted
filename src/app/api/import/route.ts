import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { db } from '@/lib/db'
import { authenticateBearer } from '@/lib/api-auth'
import { normalizeSourceUrl } from '@/lib/url'
import { findBySourceUrl } from '@/lib/db/queries/recipes'
import { createJob, findInFlightJob, markDuplicate, markFailed } from '@/lib/db/queries/jobs'
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
 * The iOS Shortcut's entry point. No session cookie exists on a share sheet,
 * so this is bearer-authenticated instead of session-authenticated (see
 * `authenticateBearer`).
 *
 * This always answers fast and finishes the real work in the background via
 * `waitUntil`: the caller is on a share sheet, often on cellular in a grocery
 * aisle, and extraction takes 5-20s. Making that a synchronous request would
 * mean either a spinner that outlives the share sheet or a slow-but-working
 * blog reading as a failure.
 */

// Supplied/pasted HTML skips `fetchPage` entirely and goes straight into the
// same JSDOM parses a fetched page does, so it must never be allowed past the
// size that pipeline is documented as able to survive (see `MAX_BYTES` and
// its comment in `@/lib/fetch`). Importing the constant, rather than
// redeclaring a number here, is what keeps the two from drifting apart again.
const MAX_HTML_BYTES = MAX_FETCHED_BYTES
// Allows room for the `url` field and JSON punctuation around a `html` field
// that is right at the cap; the request body is otherwise almost entirely
// `html`, so this margin is deliberately small.
const MAX_BODY_BYTES = MAX_HTML_BYTES + 4096

const bodySchema = z.object({
  url: z.string(),
  html: z.string().nullish(),
})

export async function POST(request: Request) {
  const authenticated = await authenticateBearer(request)
  if (!authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Read the raw body once as text rather than `request.json()`. Two things
  // fall out of that: malformed JSON becomes a caught `SyntaxError` instead
  // of an uncaught throw from inside `request.json()`, and the *raw* wire
  // size is available for the size check below rather than only the decoded
  // string — JSON-decoding a string never makes it longer, so checking the
  // raw text is always at least as strict as checking the parsed `html`
  // field, and it avoids fully parsing a pathologically large payload.
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'html too large' }, { status: 413 })
  }

  let json: unknown
  try {
    json = raw ? JSON.parse(raw) : {}
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  // An empty string is what a Shortcut sends when it failed to capture the
  // page — that must not silently become "html was supplied", or a fetch
  // that would have worked fine gets skipped in favor of nothing.
  const suppliedHtml = parsed.data.html ? parsed.data.html : null
  if (suppliedHtml && Buffer.byteLength(suppliedHtml, 'utf8') > MAX_HTML_BYTES) {
    return NextResponse.json({ error: 'html too large' }, { status: 413 })
  }

  let canonical
  try {
    canonical = normalizeSourceUrl(parsed.data.url)
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 })
  }

  const inFlight = await findInFlightJob(db, canonical.url)
  if (inFlight) {
    return NextResponse.json({ status: 'already_importing', jobId: inFlight.id }, { status: 202 })
  }

  const existing = await findBySourceUrl(db, canonical.url)
  if (existing) {
    const jobId = await createJob(db, canonical.url, authenticated.userId)
    await markDuplicate(db, jobId, existing.id)
    return NextResponse.json(
      { status: 'duplicate', jobId, recipeId: existing.id },
      { status: 200 },
    )
  }

  const jobId = await createJob(db, canonical.url, authenticated.userId)

  // `createVercelBlobStore` and `createAnthropicClient` throw synchronously
  // when their env var is unset. That throw happens here, not inside
  // `runImport` — its "must never throw" contract only covers code that runs
  // once it has been entered — so without this try/catch a missing env var
  // would 500 the request and leave the job row just-created above stuck on
  // `queued` forever: no status, no `failureKind`, no error text, invisible
  // in the tray. Catching it and marking the job failed turns a stranded row
  // into the same kind of recorded, visible failure any other import error
  // produces.
  //
  // Still 202, not 500: a job row now exists and has already been marked
  // `failed` with the error text by the time we respond, so the response is
  // accurate — the request WAS accepted and recorded, exactly what 202
  // promises. The docs already establish that "queued" only ever means "we
  // recorded it, check the tray for the outcome" (see docs/ios-shortcut.md);
  // the phone has no handling for anything but 401/400/413/200/202 and
  // was never going to learn about a failure synchronously anyway, whether
  // it happens now or five seconds from now inside `runImport`. A 500 here
  // would be the one path where "the tray is the source of truth for
  // failures" stops being true.
  let deps: { store: BlobStore; llm: LlmClient }
  try {
    deps = { store: createVercelBlobStore(), llm: createAnthropicClient() }
  } catch (error) {
    await markFailed(db, jobId, 'internal', error)
    return NextResponse.json({ status: 'queued', jobId }, { status: 202 })
  }

  waitUntil(
    runImport({
      db,
      store: deps.store,
      llm: deps.llm,
      jobId,
      url: canonical.url,
      addedBy: authenticated.userId,
      suppliedHtml,
      fetchPage,
      ingestHeroImage,
    }),
  )

  return NextResponse.json({ status: 'queued', jobId }, { status: 202 })
}
