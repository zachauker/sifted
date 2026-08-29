'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { updateRecipeContent, type RecipeContentInput } from '@/lib/db/queries/recipes'
import { MAX_REASONABLE_MINUTES } from '@/lib/extract/duration'
import { parseSectionedLines } from '@/lib/recipe-text'
import { FACETS, isValidTag, normalizeTag, type Facet, type TagAssignment } from '@/lib/taxonomy'
import { normalizeSourceUrl } from '@/lib/url'

/**
 * Saving a hand-edited recipe.
 *
 * A Server Action rather than a JSON route, and the choice is about failure,
 * not style: this form can hold a recipe someone typed out of a family
 * cookbook, and a native form post plus `useActionState` keeps every character
 * on screen when a save is rejected. Every rejection below therefore returns
 * the submitted values verbatim — the form re-renders from `values`, not from
 * the database.
 *
 * `values` are raw strings throughout, exactly as they left the inputs. They
 * are the user's text, not a parse of it; converting them for echo would mean
 * a rejected "about an hour" came back as an empty box.
 */

const MAX_LINES = 500
const MAX_LINE_LENGTH = 1_000
const MAX_FREE_TAGS = 20
const MAX_FREE_TAG_LENGTH = 40

export type EditFormValues = {
  title: string
  description: string
  publisher: string
  author: string
  sourceUrl: string
  claimedTimeMinutes: string
  servings: string
  yieldText: string
  ingredients: string
  steps: string
  /** Checked chips, each `"facet:value"`. */
  vocabularyTags: string[]
  /** The open `tag` facet, comma-separated. */
  freeTags: string
}

export type EditFormState = {
  /** A whole-form problem. Empty when every problem is field-specific. */
  message: string
  fieldErrors: Partial<Record<keyof EditFormValues, string>>
  values: EditFormValues
} | null

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The submission as typed.
 *
 * Module-private, and it has to be: a `'use server'` file may export only
 * async functions, so a sync helper exported from here fails the build. The
 * form and this function agree on field names by convention, and the action
 * tests are what hold them together.
 */
function readEditFormValues(formData: FormData): EditFormValues {
  return {
    title: text(formData.get('title')),
    description: text(formData.get('description')),
    publisher: text(formData.get('publisher')),
    author: text(formData.get('author')),
    sourceUrl: text(formData.get('sourceUrl')),
    claimedTimeMinutes: text(formData.get('claimedTimeMinutes')),
    servings: text(formData.get('servings')),
    yieldText: text(formData.get('yieldText')),
    ingredients: text(formData.get('ingredients')),
    steps: text(formData.get('steps')),
    vocabularyTags: formData.getAll('tag').map(text),
    freeTags: text(formData.get('freeTags')),
  }
}

/** Trimmed, or null for empty — the schema spells "absent" as NULL, never `''`. */
function optional(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

type NumberResult = { ok: true; value: number | null } | { ok: false; error: string }

/**
 * Whole non-negative minutes or count, or null for blank. Parsed by regex
 * rather than `Number()`, which cheerfully accepts `"1e3"`, `" 12 "`, and
 * `"0x10"` — none of which a person means when they type a cook time.
 */
function wholeNumber(raw: string, max: number, label: string): NumberResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `Give the ${label} as a whole number, or leave it blank.` }
  }
  const value = Number(trimmed)
  if (value > max) return { ok: false, error: `That ${label} is implausibly large.` }
  return { ok: true, value }
}

/** `"course:main"` back into a tag, or null if it is not that shape. */
function parseChip(raw: string): TagAssignment | null {
  const separator = raw.indexOf(':')
  if (separator <= 0) return null
  const facet = raw.slice(0, separator)
  const value = raw.slice(separator + 1)
  if (!FACETS.includes(facet as Facet)) return null
  const tag = { facet: facet as Facet, value }
  return isValidTag(tag) ? tag : null
}

/**
 * A typed entry into a tag. `normalizeTag` gets first refusal, so "Thanksgiving"
 * lands as `tag:holiday` and "Soups" as `tag:soup` rather than as two new
 * free-form values meaning what an existing one already means. Anything it
 * does not recognize becomes a kebab-cased open tag, matching the shape of the
 * `tag`-facet values already in the library (`meal-prep`, `sheet-pan`).
 */
function parseFreeTag(raw: string): TagAssignment | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const known = normalizeTag(trimmed)
  if (known) return known

  const value = trimmed.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  return value.length > 0 ? { facet: 'tag', value } : null
}

export async function saveRecipeEdits(
  target: { id: string; slug: string },
  _prev: EditFormState,
  formData: FormData,
): Promise<EditFormState> {
  const values = readEditFormValues(formData)
  const fail = (
    fieldErrors: Partial<Record<keyof EditFormValues, string>>,
    message = '',
  ): EditFormState => ({ message, fieldErrors, values })

  // The route is already behind `proxy.ts`, but a Server Action is a POST
  // endpoint of its own and every other write path in this app checks for
  // itself.
  const session = await auth()
  if (!session?.user) {
    return fail({}, 'You need to be signed in to save. Nothing was lost — try signing in again.')
  }

  const fieldErrors: Partial<Record<keyof EditFormValues, string>> = {}

  const title = values.title.trim()
  if (title.length === 0) fieldErrors.title = 'A title is required.'
  else if (title.length > 300) fieldErrors.title = 'That title is too long.'

  if (values.description.length > 5_000) fieldErrors.description = 'That description is too long.'
  if (values.publisher.trim().length > 200) fieldErrors.publisher = 'That publisher name is too long.'
  if (values.author.trim().length > 200) fieldErrors.author = 'That author name is too long.'
  if (values.yieldText.trim().length > 200) fieldErrors.yieldText = 'That yield is too long.'

  let sourceUrl: string | null = null
  let sourceDomain: string | null = null
  if (values.sourceUrl.trim() !== '') {
    try {
      const normalized = normalizeSourceUrl(values.sourceUrl)
      sourceUrl = normalized.url
      sourceDomain = normalized.domain
    } catch {
      fieldErrors.sourceUrl = "That doesn't look like a web address."
    }
  }

  const time = wholeNumber(values.claimedTimeMinutes, MAX_REASONABLE_MINUTES, 'time')
  if (!time.ok) fieldErrors.claimedTimeMinutes = time.error

  const servings = wholeNumber(values.servings, 1_000, 'servings')
  if (!servings.ok) fieldErrors.servings = servings.error
  // Zero servings is not a smaller number of servings, it is a typo. `null` is
  // how "we don't know" is spelled, and the recipe page's `servingsLabel`
  // renders a stored 0 as the nonsense "0 servings".
  else if (servings.value === 0) fieldErrors.servings = 'Give a number of servings, or leave it blank.'

  const ingredientLines = parseSectionedLines(values.ingredients)
  if (ingredientLines.length > MAX_LINES) {
    fieldErrors.ingredients = `That's more than ${MAX_LINES} ingredients — is something pasted twice?`
  } else if (ingredientLines.some((line) => line.text.length > MAX_LINE_LENGTH)) {
    fieldErrors.ingredients = 'One of those lines is far too long to be an ingredient.'
  }

  const stepLines = parseSectionedLines(values.steps)
  if (stepLines.length > MAX_LINES) {
    fieldErrors.steps = `That's more than ${MAX_LINES} steps — is something pasted twice?`
  } else if (stepLines.some((line) => line.text.length > MAX_LINE_LENGTH)) {
    fieldErrors.steps = 'One of those steps is far too long.'
  }

  // Deduped by `facet:value`, first writer winning, so a chip and a typed tag
  // that agree produce one row rather than a UNIQUE violation.
  const tags: TagAssignment[] = []
  const seen = new Set<string>()
  const addTag = (tag: TagAssignment) => {
    const id = `${tag.facet}:${tag.value}`
    if (seen.has(id)) return
    seen.add(id)
    tags.push(tag)
  }

  for (const chip of values.vocabularyTags) {
    const tag = parseChip(chip)
    // Rejected, not dropped: a checked box that silently fails to save is a
    // tag someone believes is on the recipe and is not.
    if (!tag) {
      fieldErrors.vocabularyTags = 'One of those tags is not one this library knows. Try again.'
      break
    }
    addTag(tag)
  }

  const freeEntries = values.freeTags.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (freeEntries.length > MAX_FREE_TAGS) {
    fieldErrors.freeTags = `That's more than ${MAX_FREE_TAGS} tags.`
  } else if (freeEntries.some((entry) => entry.length > MAX_FREE_TAG_LENGTH)) {
    fieldErrors.freeTags = 'One of those tags is too long.'
  } else {
    for (const entry of freeEntries) {
      const tag = parseFreeTag(entry)
      if (tag) addTag(tag)
    }
  }

  if (Object.keys(fieldErrors).length > 0) return fail(fieldErrors)

  const content: RecipeContentInput = {
    title,
    description: optional(values.description),
    publisher: optional(values.publisher),
    author: optional(values.author),
    sourceUrl,
    sourceDomain,
    claimedTimeMinutes: time.ok ? time.value : null,
    servings: servings.ok ? servings.value : null,
    yieldText: optional(values.yieldText),
    ingredients: ingredientLines,
    steps: stepLines,
    tags,
  }

  let result
  try {
    result = await updateRecipeContent(db, target.id, content)
  } catch (error) {
    // Race backstop, not a substitute for `updateRecipeContent`'s own
    // pre-check: that function already looks for a source-URL collision
    // before writing, but the check and the write are two separate
    // statements, so a second save landing in between them can pass the
    // check and then lose to the database's own UNIQUE constraint on
    // `recipes.source_url` — surfacing here as a thrown driver error rather
    // than the `source_url_taken` result the pre-check returns. Only that
    // specific, recognizable shape gets the same field-level message the
    // pre-check gives; anything else is reported generically rather than
    // guessed at, so an unrelated failure is never misreported as a URL
    // collision.
    const message = error instanceof Error ? error.message : ''
    if (message.includes('UNIQUE constraint failed') && message.includes('source_url')) {
      return fail({ sourceUrl: 'Another recipe in the library already has that source URL.' })
    }
    return fail({}, 'Something went wrong saving those changes. Nothing was lost — try again.')
  }

  if (!result.ok) {
    if (result.reason === 'source_url_taken') {
      return fail({ sourceUrl: 'Another recipe in the library already has that source URL.' })
    }
    return fail({}, 'That recipe is no longer in the library. Your edits are still here — copy anything you need.')
  }

  revalidatePath(`/recipes/${target.slug}`)
  redirect(`/recipes/${target.slug}`)
}
