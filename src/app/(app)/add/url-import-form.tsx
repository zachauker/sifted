'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

/**
 * How often to poll `GET /api/jobs/[id]` while a job is queued or running,
 * and how many times before giving up and pointing at the tray instead. A
 * prop rather than a bare constant so tests can drive this in milliseconds
 * instead of seconds — see `tests/components/add-page.test.tsx`.
 */
const DEFAULT_POLL_INTERVAL_MS = 1500
// 60s of polling at the default interval, matching `maxDuration` on the
// import routes: if the background import hasn't resolved by the time
// Vercel would have killed the function anyway, there is nothing left to
// wait for.
const DEFAULT_MAX_ATTEMPTS = 40

type JobRow = {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'duplicate'
  recipeId: string | null
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'polling'; jobId: string; status: 'queued' | 'running' }
  | { kind: 'duplicate'; recipeId: string; slug: string | null }
  | { kind: 'done'; recipeId: string; slug: string | null }
  | { kind: 'failed'; jobId: string }
  | { kind: 'timeout'; jobId: string }
  | { kind: 'error'; message: string }

/**
 * Looks a recipe id up in the whole-library index to find its slug.
 *
 * `GET /api/jobs/[id]` returns the raw `import_jobs` row, which carries
 * `recipeId` but not the recipe's `slug`, and a job route is not the place
 * to start joining in recipe columns. `/api/library-index` already has to
 * answer "what's this recipe's slug" for the whole app, so this reuses it
 * rather than inventing a second lookup.
 */
async function findSlug(recipeId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/library-index')
    if (!res.ok) return null
    const body = (await res.json()) as { entries?: { id: string; slug: string }[] }
    return body.entries?.find((e) => e.id === recipeId)?.slug ?? null
  } catch {
    return null
  }
}

export function UrlImportForm({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: {
  pollIntervalMs?: number
  maxAttempts?: number
}) {
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const attemptsRef = useRef(0)

  useEffect(() => {
    if (phase.kind !== 'polling') return

    attemptsRef.current = 0
    let cancelled = false

    const tick = async () => {
      attemptsRef.current += 1
      let job: JobRow | null
      try {
        // The job's own id, not a scan of `GET /api/jobs` (`listJobs`,
        // capped at the newest 50 rows of every status): during a migration
        // burst this job can fall out of that window entirely, and the
        // scan-based poller would then run its full timeout for an import
        // that actually finished seconds in. `GET /api/jobs/[id]` (`getJob`)
        // has no window to fall out of.
        const res = await fetch(`/api/jobs/${phase.jobId}`)
        if (!res.ok && res.status !== 404) throw new Error('failed to load job status')
        const body = (await res.json()) as { job?: JobRow | null }
        // Defensive against a malformed or unexpectedly-shaped response —
        // an absent `job` should mean "nothing to report yet", not an
        // uncaught crash on the next line.
        job = body.job ?? null
      } catch {
        return // transient — the next tick tries again
      }
      if (cancelled) return
      if (!job) return

      if (job.status === 'queued' || job.status === 'running') {
        // Narrowed to a local so the closure below carries the literal
        // `'queued' | 'running'` type rather than `job.status`'s full
        // `JobRow['status']` — TS does not carry a property narrowing
        // through into a nested function.
        const status = job.status
        setPhase((current) =>
          current.kind === 'polling' && current.status !== status
            ? { ...current, status }
            : current,
        )
        return
      }

      if (job.status === 'done' || job.status === 'duplicate') {
        const recipeId = job.recipeId
        // A `done` or `duplicate` job with no `recipeId` is not a state
        // `runImport` is meant to reach — `markDone` and `markDuplicate`
        // both require one — but resolving to a definite, visible outcome
        // here rather than falling through to keep polling matters: with no
        // handling for this, the effect just returns and polls in place
        // until `maxAttempts` is exhausted, telling the user nothing for up
        // to a minute over what should already be a known-bad outcome.
        if (!recipeId) {
          if (!cancelled) {
            setPhase({
              kind: 'error',
              message:
                'The import finished, but recorded no recipe. Check the needs-attention list.',
            })
          }
          return
        }

        const slug = await findSlug(recipeId)
        if (cancelled) return

        // A polled `duplicate` gets the same "already saved, here it is"
        // treatment as the synchronous one from the POST response — see
        // `markDuplicate` in `run-import.ts`, which exists precisely for a
        // shortened or redirecting URL that only resolves to a known recipe
        // *after* the fetch, so the synchronous response cannot report it.
        // Collapsing this into `done` would tell the user something was
        // saved when nothing was.
        setPhase(
          job.status === 'duplicate' ? { kind: 'duplicate', recipeId, slug } : { kind: 'done', recipeId, slug },
        )
        return
      }

      // failed
      if (!cancelled) setPhase({ kind: 'failed', jobId: job.id })
    }

    const interval = setInterval(() => {
      if (attemptsRef.current >= maxAttempts) {
        clearInterval(interval)
        if (!cancelled) setPhase((current) => (current.kind === 'polling' ? { kind: 'timeout', jobId: current.jobId } : current))
        return
      }
      void tick()
    }, pollIntervalMs)

    void tick()

    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on jobId, not the whole phase object
  }, [phase.kind === 'polling' ? phase.jobId : null, pollIntervalMs, maxAttempts])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setPhase({ kind: 'submitting' })

    try {
      const res = await fetch('/api/recipes/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const body = (await res.json().catch(() => null)) as
        | { status?: string; jobId?: string; recipeId?: string; slug?: string | null; error?: string }
        | null

      if (!res.ok) {
        setPhase({ kind: 'error', message: body?.error ?? `Could not start the import (HTTP ${res.status}).` })
        return
      }

      if (body?.status === 'duplicate' && body.recipeId) {
        setPhase({ kind: 'duplicate', recipeId: body.recipeId, slug: body.slug ?? null })
        return
      }

      if (body?.jobId) {
        setPhase({ kind: 'polling', jobId: body.jobId, status: 'queued' })
        return
      }

      setPhase({ kind: 'error', message: 'Unexpected response from the server.' })
    } catch {
      setPhase({ kind: 'error', message: 'Could not reach the server. Check your connection and try again.' })
    }
  }

  const busy = phase.kind === 'submitting' || phase.kind === 'polling'

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="recipe-url" className="sr-only">
          Recipe URL
        </label>
        <input
          id="recipe-url"
          type="url"
          inputMode="url"
          required
          placeholder="https://example.com/a-great-recipe"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-base transition-colors duration-(--dur-fast) hover:border-line-strong disabled:opacity-50 sm:text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>

      <div className="mt-3 text-sm" aria-live="polite">
        {phase.kind === 'polling' && (
          <p className="text-ink-muted">
            {phase.status === 'queued' ? 'Queued…' : 'Importing…'}
          </p>
        )}

        {phase.kind === 'duplicate' && (
          <p>
            Already in your library.{' '}
            {phase.slug ? (
              <Link href={`/recipes/${phase.slug}`} className="underline underline-offset-2">
                Open it
              </Link>
            ) : (
              'It has no page yet to link to — check the library.'
            )}
          </p>
        )}

        {phase.kind === 'done' && (
          <p>
            Saved.{' '}
            {phase.slug ? (
              <Link href={`/recipes/${phase.slug}`} className="underline underline-offset-2">
                Open it
              </Link>
            ) : (
              <Link href="/" className="underline underline-offset-2">
                Find it in the library
              </Link>
            )}
          </p>
        )}

        {phase.kind === 'failed' && (
          <p role="alert" className="text-danger">
            That import failed.{' '}
            <Link href="/needs-attention" className="underline underline-offset-2">
              See what went wrong
            </Link>
            .
          </p>
        )}

        {phase.kind === 'timeout' && (
          <p role="alert">
            Still working after a minute — this is taking longer than usual. Check the{' '}
            <Link href="/needs-attention" className="underline underline-offset-2">
              needs-attention list
            </Link>{' '}
            in a bit.
          </p>
        )}

        {phase.kind === 'error' && (
          <p role="alert" className="text-danger">
            {phase.message}
          </p>
        )}
      </div>
    </div>
  )
}
