import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { db } from '@/lib/db'
import { authenticateBearer } from '@/lib/api-auth'
import { normalizeSourceUrl } from '@/lib/url'
import { findBySourceUrl } from '@/lib/db/queries/recipes'
import { createJob, markDuplicate } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'
import { createAnthropicClient } from '@/lib/llm/anthropic-client'
import { fetchPage } from '@/lib/fetch'
import { ingestHeroImage } from '@/lib/images'

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

const MAX_HTML_BYTES = 5 * 1024 * 1024
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
  // size is available for the 5MB check below rather than only the decoded
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

  waitUntil(
    runImport({
      db,
      store: createVercelBlobStore(),
      llm: createAnthropicClient(),
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
