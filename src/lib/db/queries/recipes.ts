import { eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import type { Db } from '@/lib/db'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

/**
 * The single write path for a recipe.
 *
 * Everything that stores a recipe goes through `upsertRecipe`. There are no SQL
 * triggers keeping `recipes_fts` in step with the base tables by design: one
 * function means one explicit, testable sync point, and a trigger that silently
 * stops firing is far harder to notice than a function that fails a test.
 */

export type UpsertInput = {
  extracted: ExtractedRecipe
  sourceUrl: string | null
  sourceDomain: string | null
  archivedHtmlKey?: string | null
  sourceEncoding?: string | null
  enrichmentApplied?: boolean
  addedBy?: string | null
}

export async function findBySourceUrl(db: Db, sourceUrl: string) {
  return db.select().from(recipes).where(eq(recipes.sourceUrl, sourceUrl)).get()
}

/**
 * Every recipe stored without the model's contribution: no parsed quantities,
 * no units, no items, and no tags.
 *
 * This is the consumer that makes `enrichment_applied` mean something. The flag
 * is written on every import, but until now nothing ever read it, and a flag
 * nobody reads is a comment that costs a column. The failure it exists to
 * surface is quiet by construction: `applyEnrichment` swallows its own errors
 * by design, so a rate-limited model produces a recipe that stores cleanly,
 * reads fine on the page, and reports `done` — with zero tags and every
 * quantity null. Nothing fails. Nobody is told. The only symptom is a faceted
 * filter rail that under-counts, weeks later, with no failed job anywhere to
 * explain it.
 *
 * The migration is exactly the shape that triggers it: 156 imports replayed in
 * a burst, one sustained rate limit, and an arbitrary slice of the library
 * lands unenriched. And the guard built to prevent enrichment loss cannot see
 * it — `EnrichmentRegressionError` only fires when the stored recipe *already*
 * has enrichment, so first-import damage is precisely the case it is blind to.
 *
 * Ordered oldest first so a repair pass works through the backlog in the order
 * it accumulated. `sourceUrl` comes back because it is what a repair needs: a
 * recipe with a source can be fixed by retrying its import, and one without a
 * source (the handful imported from Notion) never can be, so seeing the null
 * is the answer to "why is this one still here".
 */
export type UnenrichedRecipe = {
  id: string
  title: string
  sourceUrl: string | null
}

export async function listUnenrichedRecipes(db: Db): Promise<UnenrichedRecipe[]> {
  return db
    .select({ id: recipes.id, title: recipes.title, sourceUrl: recipes.sourceUrl })
    .from(recipes)
    .where(eq(recipes.enrichmentApplied, false))
    .orderBy(recipes.createdAt)
}

export async function upsertRecipe(db: Db, input: UpsertInput): Promise<string> {
  const { extracted } = input

  // The whole write is one transaction: a recipe row whose ingredients failed to
  // land is worse than no recipe at all, because nothing downstream can tell the
  // difference between "this recipe has no ingredients" and "this write broke".
  return db.transaction(async (tx) => {
    const existing = input.sourceUrl
      ? await tx.select().from(recipes).where(eq(recipes.sourceUrl, input.sourceUrl)).get()
      : undefined

    // Source-derived fields only. `rating`, `status`, `notes` and
    // `actualTimeMinutes` are deliberately absent: they are the only columns in
    // the row that cannot be regenerated from the archived page, so a
    // re-extraction must never touch them. Everything here is by definition a
    // better read of the same source than what we stored last time.
    const sourceFields = {
      title: extracted.title,
      sourceDomain: input.sourceDomain,
      publisher: extracted.publisher,
      author: extracted.author,
      description: extracted.description,
      claimedTimeMinutes: extracted.claimedTimeMinutes,
      servings: extracted.servings,
      yieldText: extracted.yieldText,
      narrativeHtml: extracted.narrativeHtml,
      archivedHtmlKey: input.archivedHtmlKey ?? null,
      sourceEncoding: input.sourceEncoding ?? null,
      extractionMethod: extracted.extractionMethod,
      enrichmentApplied: input.enrichmentApplied ?? false,
      updatedAt: new Date(),
    }

    let recipeId: string
    if (existing) {
      // `slug` and `createdAt` are omitted on purpose: a recipe saved in 2019
      // must still read as 2019 after a re-extraction, and a slug is a URL that
      // may already be bookmarked.
      await tx.update(recipes).set(sourceFields).where(eq(recipes.id, existing.id))
      recipeId = existing.id
    } else {
      const [row] = await tx.insert(recipes).values({
        ...sourceFields,
        slug: makeSlug(extracted.title),
        sourceUrl: input.sourceUrl,
        addedBy: input.addedBy ?? null,
      }).returning({ id: recipes.id })
      recipeId = row.id
    }

    // Children are replaced wholesale rather than diffed. Positions shift
    // whenever a publisher edits a recipe, so matching an old row to a new one
    // is guesswork; inside a transaction, delete-then-insert is both simpler and
    // correct.
    await tx.delete(ingredients).where(eq(ingredients.recipeId, recipeId))
    await tx.delete(steps).where(eq(steps.recipeId, recipeId))
    await tx.delete(recipeTags).where(eq(recipeTags.recipeId, recipeId))

    if (extracted.ingredients.length > 0) {
      await tx.insert(ingredients).values(extracted.ingredients.map((i) => ({
        recipeId,
        position: i.position,
        section: i.section,
        rawText: i.rawText,
        quantity: i.quantity,
        unit: i.unit,
        item: i.item,
        note: i.note,
      })))
    }

    if (extracted.steps.length > 0) {
      await tx.insert(steps).values(extracted.steps.map((s) => ({
        recipeId,
        position: s.position,
        section: s.section,
        text: s.text,
      })))
    }

    if (extracted.tags.length > 0) {
      await tx.insert(recipeTags).values(extracted.tags.map((t) => ({
        recipeId,
        facet: t.facet,
        value: t.value,
      })))
    }

    // Delete-then-insert, never a bare insert: a re-import that only replaced
    // the base row would leave the previous extraction's terms searchable
    // forever, and a search hit that opens a recipe not containing the term is
    // the kind of bug nobody reports and everybody distrusts.
    await tx.run(sql`DELETE FROM recipes_fts WHERE recipe_id = ${recipeId}`)
    await tx.run(sql`
      INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
      VALUES (${recipeId}, ${extracted.title}, ${ingredientsText(extracted)},
              ${stepsText(extracted)}, '', ${narrativeText(extracted)})
    `)

    return recipeId
  })
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * FTS5 `MATCH` takes a query *language*, not a string of words. A bare `AND`, a
 * stray `(`, an unmatched `"` or a lone `*` are all syntax errors that throw at
 * the driver — and a search box hands us exactly those, constantly. Rather than
 * ask every future caller to remember that, the sanitization lives here, next to
 * the table it protects.
 */

// FTS5 operators are only operators in upper case; a lower-case `and` is an
// ordinary term. Dropping them honours what the user meant (we already AND
// everything) instead of searching for the literal word "AND".
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR'])

// Dropped because every term is ANDed: one function word the document happens
// not to contain would zero out an otherwise good query. "chicken and rice"
// must find "Chicken with Rice", and a search box returning nothing looks like
// an empty library rather than a wrong query — the worst failure mode we have.
//
// Kept deliberately short. Aggressive stopword lists start eating real terms,
// and for recipes even `in` is borderline (an "in-shell" ingredient, say).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'or', 'of', 'with', 'for', 'in', 'on', 'to',
])

// A pathological query — a pasted paragraph, a fuzzer — would otherwise build an
// expression tree deep enough for SQLite to reject outright.
const MAX_TERMS = 16
const MAX_TERM_LENGTH = 64

/**
 * Turn arbitrary user input into a valid FTS5 MATCH expression, or `null` when
 * there is nothing to search for. Tokens are quoted, which makes every operator
 * character and keyword a literal term rather than syntax; because the tokenizer
 * only emits letters and digits, no token can carry a quote back out.
 *
 * Tokens are otherwise passed through untransformed — no stemming or folding
 * here, because the FTS5 tokenizer (`porter unicode61`) already does both, on
 * the indexed side and the query side alike.
 */
export function toMatchExpression(query: string): string | null {
  const tokens = (query ?? '').match(/[\p{L}\p{N}]+/gu)
  if (!tokens) return null

  const terms: string[] = []
  for (const token of tokens) {
    if (FTS_OPERATORS.has(token)) continue
    if (STOPWORDS.has(token.toLowerCase())) continue
    terms.push(token.slice(0, MAX_TERM_LENGTH))
    if (terms.length === MAX_TERMS) break
  }
  // A query of nothing but stopwords searches for nothing. Returning every
  // recipe instead would be strictly worse than returning none.
  if (terms.length === 0) return null

  // Multi-word queries AND, which is what a search box is expected to do:
  // adding a word should narrow the results, not widen them.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
}

export async function searchRecipes(db: Db, query: string, limit = 50): Promise<string[]> {
  const match = toMatchExpression(query)
  if (!match) return []

  const rows = await db.all<{ recipe_id: string }>(sql`
    SELECT recipe_id FROM recipes_fts
    WHERE recipes_fts MATCH ${match}
    ORDER BY rank
    LIMIT ${limit}
  `)
  return rows.map((r) => r.recipe_id)
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function makeSlug(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  // There is no unique constraint on slug, and two sites publish the same title
  // constantly. A short random suffix is cheaper than a retry loop and keeps the
  // human-readable part intact.
  return `${base || 'recipe'}-${createId().slice(0, 8)}`
}

function ingredientsText(extracted: ExtractedRecipe): string {
  return extracted.ingredients
    .map((i) => [i.section, i.rawText, i.item, i.note].filter(Boolean).join(' '))
    .join('\n')
}

function stepsText(extracted: ExtractedRecipe): string {
  return extracted.steps
    .map((s) => [s.section, s.text].filter(Boolean).join(' '))
    .join('\n')
}

function narrativeText(extracted: ExtractedRecipe): string {
  // Tags would otherwise be indexed as terms: a search for "strong" should not
  // match every recipe whose narrative uses bold text.
  const narrative = (extracted.narrativeHtml ?? '').replace(/<[^>]*>/g, ' ')
  return [extracted.description ?? '', narrative].join(' ').replace(/\s+/g, ' ').trim()
}
