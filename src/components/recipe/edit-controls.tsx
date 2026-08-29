'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
// Type-only, so nothing from the query module (or drizzle, or the libsql
// driver) is emitted into the browser bundle.
import type { UserFields } from '@/lib/db/queries/recipes'
import { TimeChip } from './time-chip'

/**
 * The only Client Component on the recipe route, and the only place in the app
 * that writes the four fields nothing can regenerate.
 *
 * ## Why the boundary is drawn here and not around the page
 *
 * The recipe page shipped zero application JavaScript before this file
 * existed: uncontrolled ingredient checkboxes, a `<details>` for the
 * narrative, everything else static HTML. That is worth keeping, so what
 * crosses into the browser is these controls and the time chip they mutate —
 * not the page. `UserFieldsProvider` wraps the article, but the article itself
 * is passed as `children` and stays server-rendered; only the two consumers
 * below (`RecipeTimes` and `EditControls`) are client-rendered.
 *
 * ## Why the state is shared rather than local to the controls
 *
 * The measured time is edited at the bottom of the page and *displayed* at the
 * top, in the claims-versus-took-us chip. Recording "it took us an hour ten"
 * and watching the chip at the top still insist on the publisher's 35 minutes
 * until you reload is exactly the kind of thing that makes a person save the
 * same fact twice. One piece of state, two consumers.
 *
 * ## Optimistic, but never quietly
 *
 * Every save applies to the UI immediately and is reconciled against what the
 * server actually stored. When a request fails, only the keys that request
 * carried are rolled back (a concurrent edit to another field is not collateral
 * damage) and a message says out loud what was undone. Typed text — a note, a
 * measured time — is never thrown away on failure: the draft stays in the box
 * with the error beside it, because "we made this, it was a 5" disappearing
 * into a spinner is the one failure this app cannot have.
 */

type Patch = Partial<UserFields>

type Failure = { message: string }

type UserFieldsContextValue = {
  recipeId: string
  fields: UserFields
  /**
   * Applies `patch` optimistically and returns whether the server accepted it.
   * `failureMessage` is what the user is told if it did not, so the call site
   * composes it *before* the optimistic update, while it still knows the value
   * being rolled back to.
   */
  save: (patch: Patch, failureMessage: string) => Promise<boolean>
  saving: boolean
  failure: Failure | null
  reportLocalFailure: (message: string) => void
  clearFailure: () => void
  /** Draft text a save has not yet accepted, for the unload guard. */
  setHasUnsavedDraft: (key: string, unsaved: boolean) => void
}

const UserFieldsContext = createContext<UserFieldsContextValue | null>(null)

function useUserFields(): UserFieldsContextValue {
  const value = useContext(UserFieldsContext)
  if (!value) {
    throw new Error('Recipe edit controls must be rendered inside <UserFieldsProvider>')
  }
  return value
}

/** The subset of `source` named by `keys`. */
function pick(source: UserFields, keys: readonly (keyof UserFields)[]): Patch {
  const out: Patch = {}
  for (const key of keys) Object.assign(out, { [key]: source[key] })
  return out
}

export function UserFieldsProvider({
  recipeId,
  initial,
  children,
}: {
  recipeId: string
  initial: UserFields
  children: ReactNode
}) {
  const router = useRouter()
  const [fields, setFieldsState] = useState<UserFields>(initial)
  const [saving, setSaving] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const unsavedDrafts = useRef(new Set<string>())

  // A ref beside the state so an in-flight save can read and roll back the
  // *current* values rather than the ones captured when its closure was
  // created. Two saves overlapping (tap a star, then immediately press Save on
  // the notes) must not have one undo the other's optimistic update.
  const fieldsRef = useRef(fields)
  const setFields = useCallback((next: UserFields) => {
    fieldsRef.current = next
    setFieldsState(next)
  }, [])

  const save = useCallback(
    async (patch: Patch, failureMessage: string): Promise<boolean> => {
      const keys = Object.keys(patch) as (keyof UserFields)[]
      const previous = pick(fieldsRef.current, keys)

      setFields({ ...fieldsRef.current, ...patch })
      setFailure(null)
      setSaving((n) => n + 1)

      try {
        const response = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!response.ok) throw new Error(`PATCH failed with ${response.status}`)

        // Converge on what the database actually holds: notes are trimmed and
        // empty-collapsed server-side, so the echo is not always the request.
        // Only the keys this request carried are merged — a concurrent edit to
        // another field is not this response's to overwrite.
        const body = (await response.json()) as { recipe: UserFields }
        setFields({ ...fieldsRef.current, ...pick(body.recipe, keys) })

        // Re-render the server components for this route so anything derived
        // from the row on the server agrees with what is on screen. Client
        // state (this provider's, and the ingredient checkboxes') survives it.
        router.refresh()
        return true
      } catch {
        setFields({ ...fieldsRef.current, ...previous })
        setFailure({ message: failureMessage })
        return false
      } finally {
        setSaving((n) => n - 1)
      }
    },
    [recipeId, router, setFields],
  )

  const reportLocalFailure = useCallback((message: string) => setFailure({ message }), [])
  const clearFailure = useCallback(() => setFailure(null), [])

  const setHasUnsavedDraft = useCallback((key: string, unsaved: boolean) => {
    if (unsaved) unsavedDrafts.current.add(key)
    else unsavedDrafts.current.delete(key)
  }, [])

  // Closing the tab on a half-typed note loses it, and a note is not
  // recoverable from anywhere. This catches a reload or a close; it cannot
  // catch an in-app client-side navigation, which is why the controls also
  // show an explicit "not saved yet" marker rather than relying on this.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (unsavedDrafts.current.size === 0) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <UserFieldsContext.Provider
      value={{
        recipeId,
        fields,
        save,
        saving: saving > 0,
        failure,
        reportLocalFailure,
        clearFailure,
        setHasUnsavedDraft,
      }}
    >
      {children}
    </UserFieldsContext.Provider>
  )
}

/**
 * The header's chip row: the claims-versus-took-us chip beside the yield.
 *
 * A client consumer rather than the server-rendered block it replaces, because
 * the measured half of that chip is editable further down the page and has to
 * appear the moment it is recorded. The row as a whole is conditional here for
 * the same reason: a recipe with no times and no yield must render no row at
 * all (an empty row still carries its margin, and a stripe of dead space above
 * the ingredients is what makes the sparsest recipes look broken) — but the
 * moment a time is recorded, the row has to come into existence.
 */
export function RecipeTimes({
  claimedMinutes,
  servingsLabel,
}: {
  claimedMinutes: number | null
  servingsLabel: string | null
}) {
  const { fields } = useUserFields()

  if (claimedMinutes === null && fields.actualTimeMinutes === null && servingsLabel === null) {
    return null
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <TimeChip claimedMinutes={claimedMinutes} actualMinutes={fields.actualTimeMinutes} />
      {servingsLabel && (
        <p className="rounded-full bg-sunken px-3 py-1 text-sm text-ink-muted">
          {servingsLabel}
        </p>
      )}
    </div>
  )
}

const RATINGS = [1, 2, 3, 4, 5] as const

const STATUS_LABELS = {
  want_to_make: 'Want to make',
  made_it: 'Made it',
} as const

function ratingPhrase(rating: number | null): string {
  if (rating === null) return 'unrated'
  return `${rating} ${rating === 1 ? 'star' : 'stars'}`
}

function statusPhrase(status: UserFields['status']): string {
  return status === null ? 'not set' : `“${STATUS_LABELS[status]}”`
}

/**
 * Rating, status, measured time and notes — the panel at the foot of the
 * recipe, where you land when you finish cooking.
 */
export function EditControls() {
  const { fields, save, failure, reportLocalFailure, clearFailure, setHasUnsavedDraft } =
    useUserFields()

  const [timeDraft, setTimeDraft] = useState(
    fields.actualTimeMinutes === null ? '' : String(fields.actualTimeMinutes),
  )
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState(fields.notes ?? '')

  const savedTimeText = fields.actualTimeMinutes === null ? '' : String(fields.actualTimeMinutes)
  const timeUnsaved = timeDraft.trim() !== savedTimeText
  const notesUnsaved = editingNotes && notesDraft !== (fields.notes ?? '')

  useEffect(() => {
    setHasUnsavedDraft('time', timeUnsaved)
    return () => setHasUnsavedDraft('time', false)
  }, [setHasUnsavedDraft, timeUnsaved])

  useEffect(() => {
    setHasUnsavedDraft('notes', notesUnsaved)
    return () => setHasUnsavedDraft('notes', false)
  }, [setHasUnsavedDraft, notesUnsaved])

  async function chooseRating(next: number | null) {
    if (next === fields.rating) return
    await save(
      { rating: next },
      `We couldn't save that rating. It's back to ${ratingPhrase(fields.rating)} — try again.`,
    )
  }

  async function toggleStatus(value: NonNullable<UserFields['status']>) {
    // Pressing the status it already has clears it. Without that, "actually we
    // never made this" would be unsayable once the button had been pressed by
    // mistake.
    const next = fields.status === value ? null : value
    await save(
      { status: next },
      `We couldn't save that. It's back to ${statusPhrase(fields.status)} — try again.`,
    )
  }

  async function submitTime(event: React.FormEvent) {
    event.preventDefault()
    const raw = timeDraft.trim()

    if (raw === '') {
      const ok = await save(
        { actualTimeMinutes: null },
        "We couldn't clear the time. Your entry is still here — try again.",
      )
      if (ok) setTimeDraft('')
      return
    }

    const minutes = Number(raw)
    if (!Number.isInteger(minutes) || minutes < 0) {
      // Refused locally rather than round-tripped to a 400: the message is the
      // same either way, and the draft must survive it.
      reportLocalFailure('Give the time in whole minutes, as a number — for example 70.')
      return
    }

    const ok = await save(
      { actualTimeMinutes: minutes },
      "We couldn't save that time. Your entry is still here — try again.",
    )
    if (ok) setTimeDraft(String(minutes))
  }

  async function submitNotes(event: React.FormEvent) {
    event.preventDefault()
    const ok = await save(
      { notes: notesDraft },
      "We couldn't save your notes. Nothing was lost — your text is still here, try again.",
    )
    if (ok) setEditingNotes(false)
  }

  return (
    <section
      aria-labelledby="our-notes"
      className="mt-12 rounded-xl bg-accent-soft p-5"
    >
      <h2
        id="our-notes"
        className="text-sm font-semibold text-accent-on-soft"
      >
        Our notes
      </h2>

      {failure && (
        // `alert`, not a toast: this is the message that says a rating was
        // rolled back, and it stays on screen until the next save succeeds.
        <p
          role="alert"
          className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger"
        >
          {failure.message}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-sm font-medium text-ink">Rating</span>
          {/* No `role="group"` wrapper: `<details>` already exposes one for the
              narrative fold, and a second on this page makes "the group" an
              ambiguous thing to ask for. Each star carries its own label
              ("4 stars"), which is what a screen reader announces anyway. */}
          <div className="flex items-center">
            {/* A mistap here writes a wrong rating whose only undo is the
                "Clear" link below, so every star gets a full 44px tap
                target — `min-h-11 min-w-11` around the same `text-xl`
                glyph — rather than the glyph's own tiny box. The stars
                still sit close together visually (there is no gap
                between the buttons themselves); it is the invisible
                padding inside each one that keeps a thumb from landing on
                the wrong star. */}
            {RATINGS.map((value) => {
              const filled = fields.rating !== null && value <= fields.rating
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={fields.rating === value}
                  aria-label={ratingPhrase(value)}
                  onClick={() => chooseRating(value)}
                  className={`flex min-h-11 min-w-11 items-center justify-center rounded-md text-xl leading-none transition-colors duration-(--dur-fast) ${
                    filled
                      ? 'text-accent-text'
                      : 'text-ink-faint hover:text-accent-hover'
                  }`}
                >
                  <span aria-hidden="true">★</span>
                </button>
              )
            })}
          </div>
          {/* Only offered once there is something to clear. `null` and 0 are
              different values in the schema, and this writes `null` — the
              filter rail has no `rating:0` row, so a zero-star rating would
              be a recipe invisible to every rating filter. "Unrated" is the
              state a person means. */}
          {fields.rating !== null && (
            <button
              type="button"
              onClick={() => chooseRating(null)}
              className="inline-flex min-h-11 items-center rounded-md px-2 text-xs font-medium text-accent-on-soft underline underline-offset-2"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {(['want_to_make', 'made_it'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={fields.status === value}
              onClick={() => toggleStatus(value)}
              className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-medium transition-colors duration-(--dur-fast) ease-(--ease-out-quart) ${
                fields.status === value
                  ? 'bg-accent text-accent-ink'
                  : 'border border-line bg-bg text-ink-muted hover:border-line-strong hover:text-ink'
              }`}
            >
              {STATUS_LABELS[value]}
            </button>
          ))}
        </div>

        {/* `noValidate` so `step={1}` below stays a keypad and stepper hint
            rather than a gate. Left to the browser, a fractional entry is
            refused with a native bubble ("the two nearest valid values are 1
            and 2") in a different place, and a different voice, from every
            other message this panel produces — and it silently swallows the
            submit, which is the exact shape of failure this panel exists to
            avoid. The check in `submitTime` says it in the app's own words,
            in the app's own alert region. */}
        <form noValidate onSubmit={submitTime} className="flex flex-wrap items-center gap-2">
          {/* Deliberately not phrased "took us …": that exact wording belongs
              to the chip at the top of the page, and two controls answering to
              it makes "what does the page say it took us" an ambiguous
              question for a screen reader and a test alike. */}
          <label htmlFor="actual-time" className="text-sm font-medium text-ink">
            How long it really took
          </label>
          <input
            id="actual-time"
            name="actualTimeMinutes"
            // `inputMode` as well as `type`, because this is typed on a phone
            // and the numeric keypad is the difference between a two-second
            // entry and a fiddle.
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={timeDraft}
            onChange={(event) => {
              setTimeDraft(event.target.value)
              clearFailure()
            }}
            // `text-base` (16px) below the `sm` breakpoint: iOS Safari
            // zooms in on focus for any input under 16px and does not
            // zoom back out on blur — this field is edited mid-cook, on a
            // phone, so leaving the page zoomed afterward is the worst
            // possible moment for it. `w-24` (not the original `w-20`)
            // gives the larger digits room without wrapping.
            className="font-num min-h-11 w-24 rounded-md border border-line bg-bg px-2 text-base tabular-nums transition-colors duration-(--dur-fast) hover:border-line-strong sm:text-sm"
          />
          <span className="text-sm text-ink-muted">minutes</span>
          <button
            type="submit"
            className="min-h-11 rounded-md border border-line bg-bg px-4 text-sm font-medium transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-sunken"
          >
            Save
          </button>
          {timeUnsaved && (
            <span className="text-xs font-medium text-accent-on-soft">Not saved yet</span>
          )}
        </form>
      </div>

      {editingNotes ? (
        <form onSubmit={submitNotes} className="mt-4">
          <label htmlFor="notes" className="sr-only">
            Our notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={5}
            value={notesDraft}
            autoFocus
            onChange={(event) => setNotesDraft(event.target.value)}
            placeholder="What did you change? What would you do differently?"
            // `text-base` (16px) below `sm`: this field autofocuses, so
            // the iOS zoom-on-focus this fixes fires the instant the panel
            // opens, on the one field in the app most likely to be typed
            // one-handed. `sm:text-[15px]` keeps the original reading size
            // once the viewport is wide enough that focus doesn't zoom.
            className="w-full rounded-lg border border-line bg-bg p-3 text-base leading-relaxed transition-colors duration-(--dur-fast) hover:border-line-strong sm:text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-accent-hover"
            >
              Save notes
            </button>
            <button
              type="button"
              onClick={() => {
                // Explicitly discards the draft, so it is a decision the user
                // made rather than something that happened to them.
                setNotesDraft(fields.notes ?? '')
                setEditingNotes(false)
                clearFailure()
              }}
              className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-accent-on-soft underline underline-offset-2"
            >
              Cancel
            </button>
            {notesUnsaved && (
              <span className="text-xs font-medium text-accent-on-soft">Not saved yet</span>
            )}
          </div>
        </form>
      ) : (
        <div className="mt-3">
          {fields.notes && (
            // `whitespace-pre-line` because notes are typed by hand, in a
            // textarea, and the line breaks someone put in are meaningful.
            // Rendered as a text node — React escapes it, and notes never go
            // near `dangerouslySetInnerHTML` or a sanitizer.
            <p className="max-w-prose text-base leading-relaxed whitespace-pre-line text-ink">{fields.notes}</p>
          )}
          <button
            type="button"
            onClick={() => {
              setNotesDraft(fields.notes ?? '')
              setEditingNotes(true)
            }}
            className={`inline-flex min-h-11 items-center rounded-md text-sm font-medium text-accent-on-soft underline underline-offset-2 ${
              fields.notes ? 'mt-2' : ''
            }`}
          >
            {fields.notes ? 'Edit notes' : 'Add a note'}
          </button>
        </div>
      )}
    </section>
  )
}
