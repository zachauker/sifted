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
  'w-full rounded-md border border-black/15 bg-white px-3 py-2 text-base sm:text-sm dark:border-white/20 dark:bg-neutral-900'

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null
  return <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>
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
          className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950/60 dark:text-red-200"
        >
          {state.message}
        </p>
      )}

      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-medium">Title</label>
        <input id="title" name="title" type="text" defaultValue={values.title} className={inputClass} />
        <FieldError message={errors.title} />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">Description</label>
        <textarea id="description" name="description" rows={2} defaultValue={values.description} className={inputClass} />
        <FieldError message={errors.description} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="publisher" className="mb-1 block text-sm font-medium">Publisher</label>
          <input id="publisher" name="publisher" type="text" defaultValue={values.publisher} className={inputClass} />
          <FieldError message={errors.publisher} />
        </div>
        <div>
          <label htmlFor="author" className="mb-1 block text-sm font-medium">Author</label>
          <input id="author" name="author" type="text" defaultValue={values.author} className={inputClass} />
          <FieldError message={errors.author} />
        </div>
      </div>

      <div>
        <label htmlFor="sourceUrl" className="mb-1 block text-sm font-medium">Source URL</label>
        <input id="sourceUrl" name="sourceUrl" type="text" inputMode="url" defaultValue={values.sourceUrl} className={inputClass} />
        <FieldError message={errors.sourceUrl} />
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
          />
          <FieldError message={errors.claimedTimeMinutes} />
        </div>
        <div>
          <label htmlFor="servings" className="mb-1 block text-sm font-medium">Servings</label>
          <input id="servings" name="servings" type="text" inputMode="numeric" defaultValue={values.servings} className={inputClass} />
          <FieldError message={errors.servings} />
        </div>
        <div>
          <label htmlFor="yieldText" className="mb-1 block text-sm font-medium">Yield</label>
          <input id="yieldText" name="yieldText" type="text" defaultValue={values.yieldText} className={inputClass} />
          <FieldError message={errors.yieldText} />
        </div>
      </div>

      <div>
        <label htmlFor="ingredients" className="mb-1 block text-sm font-medium">Ingredients</label>
        <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
          One per line, saved exactly as typed. A line ending in a colon — “For the sauce:” —
          becomes a heading for the lines under it.
        </p>
        <textarea id="ingredients" name="ingredients" rows={12} defaultValue={values.ingredients} className={`${inputClass} font-mono`} />
        <FieldError message={errors.ingredients} />
      </div>

      <div>
        <label htmlFor="steps" className="mb-1 block text-sm font-medium">Steps</label>
        <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
          One per line. Headings work here too.
        </p>
        <textarea id="steps" name="steps" rows={12} defaultValue={values.steps} className={inputClass} />
        <FieldError message={errors.steps} />
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Tags</h2>
        {VOCABULARY_FACETS.map((facet) => (
          <fieldset key={facet}>
            <legend className="mb-1 text-xs font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
              {FACET_LABELS[facet]}
            </legend>
            <div className="flex flex-wrap gap-1">
              {VOCABULARY[facet].map((value) => {
                const id = `${facet}:${value}`
                return (
                  <label
                    key={id}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-black/15 px-3 text-sm has-checked:bg-neutral-800 has-checked:text-white dark:border-white/20 dark:has-checked:bg-neutral-100 dark:has-checked:text-neutral-900"
                  >
                    <input type="checkbox" name="tag" value={id} defaultChecked={checked.has(id)} className="size-4" />
                    {value}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
        <FieldError message={errors.vocabularyTags} />

        <div>
          <label htmlFor="freeTags" className="mb-1 block text-sm font-medium">Other tags</label>
          <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
            Comma-separated. Anything the library already recognizes is filed under its own facet.
          </p>
          <input id="freeTags" name="freeTags" type="text" defaultValue={values.freeTags} className={inputClass} />
          <FieldError message={errors.freeTags} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-md bg-neutral-800 px-4 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? 'Saving…' : 'Save recipe'}
        </button>
        <Link
          href={`/recipes/${recipe.slug}`}
          className="inline-flex min-h-11 items-center px-2 text-sm text-neutral-600 underline underline-offset-2 dark:text-neutral-300"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
