'use client'

import Link from 'next/link'
import { useActionState, useEffect, useState } from 'react'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { renderSectionedLines } from '@/lib/recipe-text'
import { FACETS, VOCABULARY, type Facet } from '@/lib/taxonomy'
import type { EditFormState, EditFormValues } from '@/app/(app)/recipes/[slug]/edit/actions'

/**
 * The recipe editor.
 *
 * A client component for exactly two reasons — `useActionState`, so a rejected
 * save re-renders with every character still in place, and the unload guard
 * below. Everything else is a plain form: the tag chips are checkboxes, the
 * lists are textareas, and the submit is a native form post to a Server
 * Action. The recipe *page* still ships almost no JavaScript; this is a
 * separate route precisely so it stays that way.
 *
 * Values come from `state.values` when there is a state and from the stored
 * recipe otherwise, so a rejection redisplays what was typed rather than what
 * is in the database — the difference between losing a hand-typed ingredient
 * list and not.
 */

const FACET_LABELS: Record<Exclude<Facet, 'tag'>, string> = {
  course: 'Course',
  ingredient: 'Ingredient',
  method: 'Method',
  cuisine: 'Cuisine',
}

const VOCABULARY_FACETS = FACETS.filter((facet): facet is Exclude<Facet, 'tag'> => facet !== 'tag')

/** The stored recipe as form values. Numbers become empty strings, not zeros. */
export function initialEditValues(recipe: RecipeDetail): EditFormValues {
  return {
    title: recipe.title,
    description: recipe.description ?? '',
    publisher: recipe.publisher ?? '',
    author: recipe.author ?? '',
    sourceUrl: recipe.sourceUrl ?? '',
    claimedTimeMinutes: recipe.claimedTimeMinutes === null ? '' : String(recipe.claimedTimeMinutes),
    servings: recipe.servings === null ? '' : String(recipe.servings),
    yieldText: recipe.yieldText ?? '',
    ingredients: renderSectionedLines(
      recipe.ingredients.map((i) => ({ section: i.section, text: i.rawText })),
    ),
    steps: renderSectionedLines(recipe.steps.map((s) => ({ section: s.section, text: s.text }))),
    vocabularyTags: recipe.tags
      .filter((tag) => tag.facet !== 'tag')
      .map((tag) => `${tag.facet}:${tag.value}`),
    // Pre-filled, and that is load-bearing: the save replaces the tag set
    // wholesale, so an empty box would silently delete every free-form tag on
    // every save.
    freeTags: recipe.tags.filter((tag) => tag.facet === 'tag').map((tag) => tag.value).join(', '),
  }
}

const inputClass =
  'min-h-11 w-full rounded-md border border-line bg-bg px-3 py-2 text-base transition-colors duration-(--dur-fast) hover:border-line-strong sm:text-sm'

/**
 * `id` is the field name — `aria-describedby` on the input it belongs to
 * points here, so a screen reader announces the reason a save was rejected
 * instead of leaving a silently-invalid box behind. Without this, the only
 * announced problem is the whole-form `role="alert"` banner, which is empty
 * for a field-only rejection.
 */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null
  return (
    <p id={id} className="mt-1 text-sm text-danger">
      {message}
    </p>
  )
}

export function RecipeEditForm({
  recipe,
  action,
  initialState = null,
}: {
  recipe: RecipeDetail
  action: (prev: EditFormState, formData: FormData) => Promise<EditFormState>
  /** Test seam: the state a rejected save would have produced. */
  initialState?: EditFormState
}) {
  const [state, formAction, pending] = useActionState(action, initialState)
  const stored = initialEditValues(recipe)
  const values = state?.values ?? stored
  const errors = state?.fieldErrors ?? {}
  const checked = new Set(values.vocabularyTags)

  // Every field is uncontrolled, with `defaultValue` read from `values`. React
  // resets an uncontrolled form after a form action completes, so a rejected
  // save re-renders with `state.values` as the new defaults and the reset
  // lands them in the boxes — the typing survives without a controlled-input
  // state tree for twelve fields.
  const [dirty, setDirty] = useState(false)

  // A close or reload mid-edit loses a hand-typed ingredient list, which is
  // not recoverable from anywhere. Same guard as the notes panel on the recipe
  // page; like that one it cannot catch an in-app navigation, which is why
  // Cancel is an explicit link rather than the only way out.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty || pending) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, pending])

  return (
    <form
      action={formAction}
      onChange={() => setDirty(true)}
      className="flex flex-col gap-5"
    >
      {state?.message && (
        <p
          role="alert"
          className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {state.message}
        </p>
      )}

      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-medium">Title</label>
        <input
          id="title"
          name="title"
          type="text"
          defaultValue={values.title}
          className={inputClass}
          aria-describedby={errors.title ? 'title-error' : undefined}
          aria-invalid={errors.title ? true : undefined}
        />
        <FieldError id="title-error" message={errors.title} />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">Description</label>
        <textarea
          id="description"
          name="description"
          rows={2}
          defaultValue={values.description}
          className={inputClass}
          aria-describedby={errors.description ? 'description-error' : undefined}
          aria-invalid={errors.description ? true : undefined}
        />
        <FieldError id="description-error" message={errors.description} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="publisher" className="mb-1 block text-sm font-medium">Publisher</label>
          <input
            id="publisher"
            name="publisher"
            type="text"
            defaultValue={values.publisher}
            className={inputClass}
            aria-describedby={errors.publisher ? 'publisher-error' : undefined}
            aria-invalid={errors.publisher ? true : undefined}
          />
          <FieldError id="publisher-error" message={errors.publisher} />
        </div>
        <div>
          <label htmlFor="author" className="mb-1 block text-sm font-medium">Author</label>
          <input
            id="author"
            name="author"
            type="text"
            defaultValue={values.author}
            className={inputClass}
            aria-describedby={errors.author ? 'author-error' : undefined}
            aria-invalid={errors.author ? true : undefined}
          />
          <FieldError id="author-error" message={errors.author} />
        </div>
      </div>

      <div>
        <label htmlFor="sourceUrl" className="mb-1 block text-sm font-medium">Source URL</label>
        <input
          id="sourceUrl"
          name="sourceUrl"
          type="text"
          inputMode="url"
          defaultValue={values.sourceUrl}
          className={inputClass}
          aria-describedby={errors.sourceUrl ? 'sourceUrl-error' : undefined}
          aria-invalid={errors.sourceUrl ? true : undefined}
        />
        <FieldError id="sourceUrl-error" message={errors.sourceUrl} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="claimedTimeMinutes" className="mb-1 block text-sm font-medium">
            How long it claims to take
          </label>
          <input
            id="claimedTimeMinutes"
            name="claimedTimeMinutes"
            type="text"
            inputMode="numeric"
            defaultValue={values.claimedTimeMinutes}
            className={inputClass}
            aria-describedby={errors.claimedTimeMinutes ? 'claimedTimeMinutes-error' : undefined}
            aria-invalid={errors.claimedTimeMinutes ? true : undefined}
          />
          <FieldError id="claimedTimeMinutes-error" message={errors.claimedTimeMinutes} />
        </div>
        <div>
          <label htmlFor="servings" className="mb-1 block text-sm font-medium">Servings</label>
          <input
            id="servings"
            name="servings"
            type="text"
            inputMode="numeric"
            defaultValue={values.servings}
            className={inputClass}
            aria-describedby={errors.servings ? 'servings-error' : undefined}
            aria-invalid={errors.servings ? true : undefined}
          />
          <FieldError id="servings-error" message={errors.servings} />
        </div>
        <div>
          <label htmlFor="yieldText" className="mb-1 block text-sm font-medium">Yield</label>
          <input
            id="yieldText"
            name="yieldText"
            type="text"
            defaultValue={values.yieldText}
            className={inputClass}
            aria-describedby={errors.yieldText ? 'yieldText-error' : undefined}
            aria-invalid={errors.yieldText ? true : undefined}
          />
          <FieldError id="yieldText-error" message={errors.yieldText} />
        </div>
      </div>

      <div>
        <label htmlFor="ingredients" className="mb-1 block text-sm font-medium">Ingredients</label>
        <p className="mb-1 text-xs text-ink-muted">
          One per line, saved exactly as typed. A line ending in a colon — “For the sauce:” —
          becomes a heading for the lines under it.
        </p>
        <textarea
          id="ingredients"
          name="ingredients"
          rows={12}
          defaultValue={values.ingredients}
          className={`${inputClass} font-mono`}
          aria-describedby={errors.ingredients ? 'ingredients-error' : undefined}
          aria-invalid={errors.ingredients ? true : undefined}
        />
        <FieldError id="ingredients-error" message={errors.ingredients} />
      </div>

      <div>
        <label htmlFor="steps" className="mb-1 block text-sm font-medium">Steps</label>
        <p className="mb-1 text-xs text-ink-muted">
          One per line. Headings work here too.
        </p>
        <textarea
          id="steps"
          name="steps"
          rows={12}
          defaultValue={values.steps}
          className={inputClass}
          aria-describedby={errors.steps ? 'steps-error' : undefined}
          aria-invalid={errors.steps ? true : undefined}
        />
        <FieldError id="steps-error" message={errors.steps} />
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Tags</h2>
        {VOCABULARY_FACETS.map((facet) => (
          <fieldset
            key={facet}
            aria-describedby={errors.vocabularyTags ? 'vocabularyTags-error' : undefined}
          >
            <legend className="mb-1.5 text-xs font-semibold text-ink-muted">
              {FACET_LABELS[facet]}
            </legend>
            <div className="flex flex-wrap gap-1">
              {VOCABULARY[facet].map((value) => {
                const id = `${facet}:${value}`
                return (
                  <label
                    key={id}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line px-3 text-sm transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-sunken has-checked:border-accent has-checked:bg-accent has-checked:text-accent-ink"
                  >
                    <input type="checkbox" name="tag" value={id} defaultChecked={checked.has(id)} className="size-4 accent-accent" />
                    {value}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
        <FieldError id="vocabularyTags-error" message={errors.vocabularyTags} />

        <div>
          <label htmlFor="freeTags" className="mb-1 block text-sm font-medium">Other tags</label>
          <p className="mb-1 text-xs text-ink-muted">
            Comma-separated. Anything the library already recognizes is filed under its own facet.
          </p>
          <input
            id="freeTags"
            name="freeTags"
            type="text"
            defaultValue={values.freeTags}
            className={inputClass}
            aria-describedby={errors.freeTags ? 'freeTags-error' : undefined}
            aria-invalid={errors.freeTags ? true : undefined}
          />
          <FieldError id="freeTags-error" message={errors.freeTags} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
        >
          {pending ? 'Saving…' : 'Save recipe'}
        </button>
        <Link
          href={`/recipes/${recipe.slug}`}
          className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-ink-muted underline underline-offset-2 transition-colors duration-(--dur-fast) hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
