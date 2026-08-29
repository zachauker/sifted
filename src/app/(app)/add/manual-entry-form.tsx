'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type State =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

/**
 * Title, ingredients (one per line), steps (one per line), optional time and
 * servings — posted to `POST /api/recipes/manual`, which does the actual
 * line-splitting and blank-line skipping (see `parseLines` there). This
 * component sends the raw textarea values untouched.
 *
 * On failure the typed values are left exactly as they were. Losing a
 * hand-typed recipe to a network hiccup — the same category of "we made
 * this, it was a 5" data this app must never silently drop — would be worse
 * than making someone click Save twice.
 */
export function ManualEntryForm() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [ingredients, setIngredients] = useState('')
  const [steps, setSteps] = useState('')
  const [claimedTimeMinutes, setClaimedTimeMinutes] = useState('')
  const [servings, setServings] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setState({ kind: 'submitting' })

    try {
      const res = await fetch('/api/recipes/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          ingredients,
          steps,
          claimedTimeMinutes: claimedTimeMinutes.trim() ? Number(claimedTimeMinutes) : null,
          servings: servings.trim() ? Number(servings) : null,
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { recipeId?: string; slug?: string | null; error?: string }
        | null

      if (!res.ok) {
        setState({ kind: 'error', message: body?.error ?? `Could not save (HTTP ${res.status}).` })
        return
      }

      router.push(body?.slug ? `/recipes/${body.slug}` : '/')
    } catch {
      setState({
        kind: 'error',
        message: 'Could not reach the server. Nothing was lost — your recipe is still here; try again.',
      })
    }
  }

  const busy = state.kind === 'submitting'

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="manual-title" className="mb-1 block text-sm font-medium">
          Title
        </label>
        <input
          id="manual-title"
          type="text"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-base transition-colors duration-(--dur-fast) hover:border-line-strong disabled:opacity-50 sm:text-sm"
        />
      </div>

      <div>
        <label htmlFor="manual-ingredients" className="mb-1 block text-sm font-medium">
          Ingredients
        </label>
        <p className="mb-1 text-xs text-ink-muted">
          One per line, saved exactly as typed.
        </p>
        <textarea
          id="manual-ingredients"
          rows={8}
          value={ingredients}
          onChange={(e) => setIngredients(e.target.value)}
          disabled={busy}
          className="w-full rounded-md border border-line bg-bg p-3 font-mono text-base leading-relaxed transition-colors duration-(--dur-fast) hover:border-line-strong disabled:opacity-50 sm:text-sm"
        />
      </div>

      <div>
        <label htmlFor="manual-steps" className="mb-1 block text-sm font-medium">
          Steps
        </label>
        <p className="mb-1 text-xs text-ink-muted">One per line.</p>
        <textarea
          id="manual-steps"
          rows={8}
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          disabled={busy}
          className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-base transition-colors duration-(--dur-fast) hover:border-line-strong disabled:opacity-50 sm:text-sm"
        />
      </div>

      <div className="flex gap-4">
        <div>
          <label htmlFor="manual-time" className="mb-1 block text-sm font-medium">
            Time (minutes)
          </label>
          <input
            id="manual-time"
            type="number"
            min={1}
            step={1}
            value={claimedTimeMinutes}
            onChange={(e) => setClaimedTimeMinutes(e.target.value)}
            disabled={busy}
            className="font-num min-h-11 w-28 rounded-md border border-line bg-bg px-3 text-base tabular-nums transition-colors duration-(--dur-fast) hover:border-line-strong disabled:opacity-50 sm:text-sm"
          />
        </div>
        <div>
          <label htmlFor="manual-servings" className="mb-1 block text-sm font-medium">
            Servings
          </label>
          <input
            id="manual-servings"
            type="number"
            min={1}
            step={1}
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            disabled={busy}
            className="font-num min-h-11 w-28 rounded-md border border-line bg-bg px-3 text-base tabular-nums transition-colors duration-(--dur-fast) hover:border-line-strong disabled:opacity-50 sm:text-sm"
          />
        </div>
      </div>

      <div>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
        >
          {busy ? 'Saving…' : 'Save recipe'}
        </button>
      </div>

      {state.kind === 'error' && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  )
}
