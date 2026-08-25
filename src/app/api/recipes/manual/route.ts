import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { upsertRecipe } from '@/lib/db/queries/recipes'
import { recipes } from '@/lib/db/schema'
import type { ExtractedIngredient, ExtractedStep } from '@/lib/extract/types'

/**
 * The hand-typed path into the library: a title, ingredients and steps
 * typed directly rather than clipped from a page. This is how a recipe with
 * no web source gets in — the same case as the hand-typed family recipes
 * the Notion migration rescued (a five-star "Ham Pot Pie" that exists
 * nowhere else). It goes through the same `upsertRecipe` every other path
 * uses, with `extractionMethod: 'manual'` and `sourceUrl: null`.
 */

const bodySchema = z.object({
  title: z.string().trim().min(1),
  // Raw textarea contents, one ingredient or step per line. Parsed with
  // `parseLines` below, not here — keeping the split logic in one function
  // is what makes "blank lines are skipped" a single, testable rule instead
  // of two copies that can drift.
  ingredients: z.string().nullish(),
  steps: z.string().nullish(),
  claimedTimeMinutes: z.coerce.number().int().positive().nullish(),
  servings: z.coerce.number().int().positive().nullish(),
})

/**
 * One entry per non-blank line, trimmed.
 *
 * A blank line — including one that is only whitespace — is dropped rather
 * than stored as an empty ingredient or step row; a stray blank line from
 * pasting a recipe out of Notes or an email must not become a phantom row
 * with nothing in it.
 *
 * Splits on `\r\n`, `\r`, and `\n` so a textarea's value survives a paste
 * from Windows (`\r\n`) as cleanly as from anywhere else — a lone `\r` left
 * in would otherwise ride along inside the last "line" of a `\r\n`-joined
 * paste, or turn a single logical line into two.
 */
function parseLines(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'a title is required' }, { status: 400 })
  }

  const ingredients: ExtractedIngredient[] = parseLines(parsed.data.ingredients).map(
    (rawText, position) => ({
      position,
      section: null,
      // Verbatim, always — never parsed here. This rule holds across every
      // write path in this codebase (see `upsertRecipe`'s own comments on
      // `rawText`), and a hand-typed line is no exception: quantity, unit,
      // item and note stay null rather than guessed at.
      rawText,
      quantity: null,
      unit: null,
      item: null,
      note: null,
    }),
  )

  const steps: ExtractedStep[] = parseLines(parsed.data.steps).map((text, position) => ({
    position,
    section: null,
    text,
  }))

  const recipeId = await upsertRecipe(db, {
    extracted: {
      title: parsed.data.title,
      description: null,
      author: null,
      publisher: null,
      claimedTimeMinutes: parsed.data.claimedTimeMinutes ?? null,
      servings: parsed.data.servings ?? null,
      yieldText: null,
      ingredients,
      steps,
      tags: [],
      heroImageUrl: null,
      narrativeHtml: null,
      extractionMethod: 'manual',
    },
    sourceUrl: null,
    sourceDomain: null,
    // There is no extraction step here for enrichment to have run after —
    // a human typed this in directly. `true` is what keeps a hand-entered
    // recipe out of `listUnenrichedRecipes`'s repair queue, where `false`
    // would otherwise strand it forever: that query's own comment notes a
    // null-`sourceUrl` row can never be fixed by a re-import, which is
    // exactly the position a hand-typed recipe with `false` here would be
    // in — flagged as broken with no possible repair.
    enrichmentApplied: true,
    addedBy: session.user.id,
  })

  // `upsertRecipe` returns only the id; the redirect target needs the slug
  // too, so it's read back here rather than having `upsertRecipe` grow a
  // richer return type for this one caller.
  const row = await db.select({ slug: recipes.slug }).from(recipes)
    .where(eq(recipes.id, recipeId)).get()

  return NextResponse.json({ recipeId, slug: row?.slug ?? null }, { status: 201 })
}
