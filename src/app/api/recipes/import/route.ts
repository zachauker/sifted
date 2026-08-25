import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { normalizeSourceUrl } from '@/lib/url'
import { findBySourceUrl } from '@/lib/db/queries/recipes'
import { createJob, findInFlightJob, markDuplicate, markFailed } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'
import type { BlobStore } from '@/lib/storage'
import { createAnthropicClient } from '@/lib/llm/anthropic-client'
import type { LlmClient } from '@/lib/extract/llm-types'
import { fetchPage } from '@/lib/fetch'
import { ingestHeroImage } from '@/lib/images'

// See the matching comment in `src/app/api/import/route.ts`: this must
// cover the worst-case sum of the fetch, extraction and image-ingestion
// budgets `runImport` can spend.
export const maxDuration = 60

/**
 * The session-authenticated twin of `POST /api/import`, for the "paste a
 * URL" box on the Add page.
 *
 * The bridge problem this exists to solve: `/api/import` is
 * bearer-authenticated, deliberately, because the iOS Shortcut that calls
 * it shares a page from outside the browser and has no session cookie (see
 * `src/lib/api-auth.ts`). The Add page has the opposite shape — a NextAuth
 * session cookie, and no bearer token — so it cannot call `/api/import`
 * directly.
 *
 * The fix is a second, thin route rather than a change to the first one.
 * Two things were deliberately *not* done instead:
 *
 *   - `/api/import` was not taught to also accept a session. That would
 *     make "how is this endpoint authenticated" a question with two
 *     answers instead of one, for every future reader of that file, and
 *     bearer-only is a real guarantee something downstream may already be
 *     relying on.
 *   - The browser was not handed a bearer token to hold and send instead.
 *     A token that lives in a page's JS is reachable by any XSS on that
 *     page, can end up in browser history or a shared machine's storage,
 *     and is exactly the class of exposure per-device tokens
 *     (`docs/ios-shortcut.md`, `src/lib/db/queries/tokens.ts`) exist to
 *     contain to one device at a time. A session cookie, `httpOnly` and
 *     scoped to this origin, does not carry that risk the same way.
 *
 * So: this route re-implements the same steps `/api/import` takes
 * (dedupe by canonical URL, create a job, kick off `runImport` in the
 * background via `waitUntil`) under `auth()` instead of
 * `authenticateBearer()`. `/api/import` itself is untouched — the bearer
 * path is neither weakened nor asked to do double duty.
 */
const bodySchema = z.object({ url: z.string() })

// `queued` and `running` only. A `done` or `duplicate` job for this URL
// already resolved to a recipe row, which `findBySourceUrl` below would
// have caught; `failed` is not in-flight and pasting the same URL again
// after a failure is exactly how the tray's own retry works, so a fresh
// attempt here should proceed rather than being told to wait on a dead job.

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  let canonical
  try {
    canonical = normalizeSourceUrl(parsed.data.url)
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 })
  }

  const existing = await findBySourceUrl(db, canonical.url)
  if (existing) {
    const jobId = await createJob(db, canonical.url, session.user.id)
    await markDuplicate(db, jobId, existing.id)
    // `slug` rides along so the Add page can link straight to the existing
    // recipe rather than just saying "it's already saved" with nowhere to
    // go — the plan is explicit that a duplicate must report plainly *and*
    // link to it.
    return NextResponse.json(
      { status: 'duplicate', jobId, recipeId: existing.id, slug: existing.slug },
      { status: 200 },
    )
  }

  const inFlight = await findInFlightJob(db, canonical.url)
  if (inFlight) {
    return NextResponse.json(
      { status: 'already_importing', jobId: inFlight.id },
      { status: 202 },
    )
  }

  const jobId = await createJob(db, canonical.url, session.user.id)

  // See the matching comment in `src/app/api/import/route.ts` for why this
  // is caught and turned into a recorded `failed` job rather than a bare
  // 500: the job row already exists by this point, and a stranded `queued`
  // row with nothing to explain it is worse than a `failed` one the tray
  // can show.
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
      addedBy: session.user.id,
      // The Add page never pastes HTML — that recovery path only exists in
      // the needs-attention tray, once a fetch has already failed.
      suppliedHtml: null,
      fetchPage,
      ingestHeroImage,
    }),
  )

  return NextResponse.json({ status: 'queued', jobId }, { status: 202 })
}
