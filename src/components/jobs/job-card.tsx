'use client'

import { useId, useState, type ReactNode } from 'react'
import { explainFailure } from './failure-copy'
import type { Job } from './types'

/**
 * Mirrors `MAX_BYTES` in `@/lib/fetch`, which the retry endpoint enforces
 * server-side (see `MAX_HTML_BYTES` in
 * `src/app/api/jobs/[id]/retry/route.ts`). Duplicated here rather than
 * imported — that module pulls in server-only fetch/timeout code that has
 * no business in the client bundle. Keep this in sync if that one changes.
 */
const MAX_HTML_BYTES = 3 * 1024 * 1024

function formatBytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

type RetryState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string }

async function postRetry(jobId: string, html?: string): Promise<RetryState> {
  try {
    const res = await fetch(`/api/jobs/${jobId}/retry`, {
      method: 'POST',
      ...(html !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html }) }
        : {}),
    })
    if (res.status === 413) {
      return {
        kind: 'error',
        message:
          `That's too large for us to accept (limit ${formatBytes(MAX_HTML_BYTES)}). Try ` +
          'copying a smaller part of the page — just the recipe card, rather than the whole ' +
          'article — and paste that instead.',
      }
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      return { kind: 'error', message: body?.error ?? 'This job is no longer retryable.' }
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      return { kind: 'error', message: body?.error ?? `Retry failed (HTTP ${res.status}).` }
    }
    return { kind: 'sent' }
  } catch {
    return { kind: 'error', message: 'Could not reach the server. Check your connection and try again.' }
  }
}

/**
 * A snapshot notice shown after a retry is accepted.
 *
 * The tray does not poll: `listJobs` runs once, in the server component that
 * rendered this page, and nothing here re-fetches it. A retry moves the job
 * to `running` and, seconds later, to `done` or `failed` — none of which
 * this screen will show without a reload. A plain link is the honest way to
 * say that, rather than implying the button already updated anything below
 * it.
 */
function SentNotice() {
  return (
    <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
      Retry sent. This list is a snapshot from when the page loaded —{' '}
      <a href="/needs-attention" className="underline underline-offset-2">
        reload
      </a>{' '}
      in a few seconds to see the result.
    </p>
  )
}

function RetryButton({ jobId, label }: { jobId: string; label: string }) {
  const [state, setState] = useState<RetryState>({ kind: 'idle' })

  if (state.kind === 'sent') return <SentNotice />

  return (
    <div>
      <button
        type="button"
        disabled={state.kind === 'sending'}
        onClick={async () => {
          setState({ kind: 'sending' })
          setState(await postRetry(jobId))
        }}
        className="rounded border border-black/20 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-white/20"
      >
        {state.kind === 'sending' ? 'Retrying…' : label}
      </button>
      {state.kind === 'error' && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}
    </div>
  )
}

/**
 * The `blocked` recovery path: paste HTML captured from a real browser on a
 * residential connection, since the publisher will refuse our server again
 * on an unchanged retry.
 *
 * "Copy the page source" means View Page Source specifically (not DevTools'
 * *inspected*, live-modified DOM) — that is what the instructions below
 * name, because DevTools' Elements panel can differ from what the server
 * actually sent.
 */
function PasteHtmlForm({ jobId }: { jobId: string }) {
  const [html, setHtml] = useState('')
  const [state, setState] = useState<RetryState>({ kind: 'idle' })
  const fieldId = useId()

  if (state.kind === 'sent') return <SentNotice />

  const bytes = new TextEncoder().encode(html).length
  const tooLarge = bytes > MAX_HTML_BYTES
  const empty = html.trim().length === 0

  return (
    <div className="mt-2">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Open the page in your own browser, right-click anywhere on it and choose{' '}
        <strong>View Page Source</strong> (Ctrl+U on Windows, Cmd+Option+U on a Mac). Select
        all of that page, copy it, and paste it below.
      </p>
      <label htmlFor={fieldId} className="sr-only">
        Pasted page source for {jobId}
      </label>
      <textarea
        id={fieldId}
        value={html}
        onChange={(e) => setHtml(e.target.value)}
        placeholder="Paste the page source here"
        rows={4}
        className="mt-2 w-full rounded border border-black/20 bg-transparent p-2 font-mono text-xs dark:border-white/20"
      />
      <div className="mt-1 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
        <span className={tooLarge ? 'text-red-700 dark:text-red-400' : undefined}>
          {formatBytes(bytes)} of {formatBytes(MAX_HTML_BYTES)} max
        </span>
      </div>
      <button
        type="button"
        disabled={empty || tooLarge || state.kind === 'sending'}
        onClick={async () => {
          setState({ kind: 'sending' })
          setState(await postRetry(jobId, html))
        }}
        className="mt-2 rounded border border-black/20 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-white/20"
      >
        {state.kind === 'sending' ? 'Retrying…' : 'Retry with pasted HTML'}
      </button>
      {state.kind === 'error' && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}
    </div>
  )
}

function CardShell({ url, children }: { url: string; children: ReactNode }) {
  return (
    <li className="rounded border border-black/10 p-4 dark:border-white/10">
      <p className="break-all text-sm text-neutral-500 dark:text-neutral-400">{url}</p>
      {children}
    </li>
  )
}

export function JobCard({ job, onDismiss }: { job: Job; onDismiss: (id: string) => void }) {
  if (job.status === 'running') {
    return (
      <CardShell url={job.url}>
        <p className="mt-1 font-medium">In progress</p>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          This import is running right now — nothing to do yet.
        </p>
      </CardShell>
    )
  }

  if (job.status === 'queued') {
    return (
      <CardShell url={job.url}>
        <p className="mt-1 font-medium">Queued</p>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Waiting to start. If this has been sitting here a while, you can retry it.
        </p>
        <div className="mt-2">
          <RetryButton jobId={job.id} label="Retry" />
        </div>
      </CardShell>
    )
  }

  // Only `failed` remains — `done` and `duplicate` are filtered out by the
  // tray before any card is rendered, since neither needs attention.
  const explanation = explainFailure(job)

  return (
    <CardShell url={job.url}>
      <p className="mt-1 font-medium">{explanation.heading}</p>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{explanation.body}</p>

      {explanation.action === 'retry' && (
        <div className="mt-2">
          <RetryButton jobId={job.id} label={explanation.retryLabel ?? 'Retry'} />
        </div>
      )}

      {explanation.action === 'paste-html' && <PasteHtmlForm jobId={job.id} />}

      {explanation.action === 'remove' && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => onDismiss(job.id)}
            className="rounded border border-black/20 px-3 py-1.5 text-sm font-medium dark:border-white/20"
          >
            Remove from this list
          </button>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            This only hides it on this device — it doesn&apos;t delete anything on the server.
          </p>
        </div>
      )}
    </CardShell>
  )
}
