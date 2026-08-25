'use client'

import { useState } from 'react'

type TokenSummary = {
  id: string
  label: string
  lastUsedAt: Date | string | null
  createdAt: Date | string
  revokedAt: Date | string | null
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

type IssueState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

/**
 * Token issuance and revocation for the settings page.
 *
 * The one rule this component exists to enforce visually: a freshly issued
 * token's plaintext value is shown exactly once, in the response body of
 * the `POST /api/tokens` call that created it (see the comment there). Only
 * `token_hash` is ever stored — there is no "show it again" — so the UI
 * says that plainly rather than implying the value can be retrieved later.
 */
export function TokenManager({ initialTokens }: { initialTokens: TokenSummary[] }) {
  const [tokens, setTokens] = useState<TokenSummary[]>(initialTokens)
  const [label, setLabel] = useState('')
  const [issueState, setIssueState] = useState<IssueState>({ kind: 'idle' })
  const [justIssued, setJustIssued] = useState<{ token: string; label: string } | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<{ id: string; message: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const issue = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) return
    setIssueState({ kind: 'submitting' })
    setCopied(false)

    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      })
      const body = (await res.json().catch(() => null)) as
        | { token?: string; tokenId?: string; error?: string }
        | null

      if (!res.ok || !body?.token || !body.tokenId) {
        setIssueState({ kind: 'error', message: body?.error ?? `Could not issue a token (HTTP ${res.status}).` })
        return
      }

      setTokens((current) => [
        { id: body.tokenId!, label: label.trim(), lastUsedAt: null, createdAt: new Date(), revokedAt: null },
        ...current,
      ])
      setJustIssued({ token: body.token, label: label.trim() })
      setLabel('')
      setIssueState({ kind: 'idle' })
    } catch {
      setIssueState({ kind: 'error', message: 'Could not reach the server. Check your connection and try again.' })
    }
  }

  const revoke = async (id: string) => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        'Revoke this token? Anything still using it — the Shortcut on that device — will stop being able to import recipes.',
      )
      if (!confirmed) return
    }

    setRevokingId(id)
    setRevokeError(null)
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setRevokeError({ id, message: body?.error ?? `Could not revoke (HTTP ${res.status}).` })
        return
      }
      setTokens((current) =>
        current.map((t) => (t.id === id ? { ...t, revokedAt: new Date() } : t)),
      )
    } catch {
      setRevokeError({ id, message: 'Could not reach the server. Check your connection and try again.' })
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {justIssued && (
        <div className="rounded border border-amber-600/40 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
          <p className="font-medium">
            Token for &quot;{justIssued.label}&quot; — copy it now
          </p>
          <p className="mt-1 text-neutral-700 dark:text-neutral-300">
            This is the only time this value will ever be shown. Only its hash is stored, so
            there is no way to display it again later — if it&apos;s lost, revoke this token and
            issue a new one.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-black/5 px-2 py-1.5 text-xs break-all dark:bg-white/10">
              {justIssued.token}
            </code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(justIssued.token)
                  setCopied(true)
                } catch {
                  // Clipboard access can be denied; the value is still
                  // selectable text right above this button.
                }
              }}
              className="shrink-0 rounded border border-black/20 px-2 py-1.5 text-xs font-medium dark:border-white/20"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setJustIssued(null)}
            className="mt-2 text-xs underline underline-offset-2"
          >
            Done — I&apos;ve copied it
          </button>
        </div>
      )}

      <form onSubmit={issue} className="flex gap-2">
        <label htmlFor="token-label" className="sr-only">
          Device label
        </label>
        <input
          id="token-label"
          type="text"
          placeholder="e.g. Zach's iPhone"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={issueState.kind === 'submitting'}
          className="w-full rounded border border-black/20 bg-transparent px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
        />
        <button
          type="submit"
          disabled={issueState.kind === 'submitting'}
          className="shrink-0 rounded border border-black/20 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
        >
          {issueState.kind === 'submitting' ? 'Issuing…' : 'Issue new token'}
        </button>
      </form>
      {issueState.kind === 'error' && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {issueState.message}
        </p>
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No tokens yet. Issue one above for the iOS Shortcut to use.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tokens.map((t) => {
            const revoked = Boolean(t.revokedAt)
            const lastUsed = formatDate(t.lastUsedAt)
            return (
              <li
                key={t.id}
                className="flex items-center justify-between gap-4 rounded border border-black/10 p-3 text-sm dark:border-white/10"
              >
                <div>
                  <p className="font-medium">{t.label}</p>
                  <p className="text-neutral-500 dark:text-neutral-400">
                    {revoked
                      ? `Revoked ${formatDate(t.revokedAt)}`
                      : lastUsed
                        ? `Last used ${lastUsed}`
                        : 'Never used'}
                  </p>
                  {revokeError?.id === t.id && (
                    <p role="alert" className="mt-1 text-red-700 dark:text-red-400">
                      {revokeError.message}
                    </p>
                  )}
                </div>
                {!revoked && (
                  <button
                    type="button"
                    onClick={() => revoke(t.id)}
                    disabled={revokingId === t.id}
                    className="shrink-0 rounded border border-black/20 px-3 py-1.5 font-medium disabled:opacity-50 dark:border-white/20"
                  >
                    {revokingId === t.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
