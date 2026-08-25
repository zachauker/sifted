import { and, eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import type { Db } from '@/lib/db'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'
import type { TagAssignment } from '@/lib/taxonomy'

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
  // A historical save date for a migrated recipe (e.g. from Notion). Applied
  // only on insert — see the note beside `sourceFields` below for why a
  // re-import must never touch it. Omit to fall back to the column default of
  // "now", which is correct for a fresh import.
  createdAt?: Date
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
      // `createdAt` is validated here, not just accepted, because it comes from
      // parsing a Notion timestamp string upstream: a bad parse should fail the
      // import loudly rather than silently write a corrupt date that only shows
      // up later when someone sorts the library by age.
      if (input.createdAt !== undefined && Number.isNaN(input.createdAt.getTime())) {
        throw new Error(`upsertRecipe: createdAt is an invalid Date (sourceUrl: ${input.sourceUrl ?? 'null'})`)
      }
      const [row] = await tx.insert(recipes).values({
        ...sourceFields,
        slug: makeSlug(extracted.title),
        sourceUrl: input.sourceUrl,
        addedBy: input.addedBy ?? null,
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      }).returning({ id: recipes.id })
      recipeId = row.id
    }

    // Children are replaced wholesale rather than diffed. Positions shift
    // whenever a publisher edits a recipe, so matching an old row to a new one
    // is guesswork; inside a transaction, delete-then-insert is both simpler and
    // correct.
    await tx.delete(ingredients).where(eq(ingredients.recipeId, recipeId))
    await tx.delete(steps).where(eq(steps.recipeId, recipeId))

    // Tags are the one exception, and `source` is why. Ingredients and steps
    // can only ever have come from the page, so replacing all of them is the
    // same thing as replacing ours. Tags can also have come from a human —
    // seven years of Notion curation, and soon a tag editor in the UI — and
    // those are not derivable from the page, so re-extraction cannot produce
    // them again once it has deleted them. Replacing wholesale here is exactly
    // how the documented repair procedure ("re-import it") destroyed the tags
    // it was meant to repair. We delete only what we wrote.
    await tx.delete(recipeTags)
      .where(and(eq(recipeTags.recipeId, recipeId), eq(recipeTags.source, 'extracted')))

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
      // `onConflictDoNothing`, because `(recipe_id, facet, value)` is unique
      // across every source: if a human already owns `method:oven`, the tag is
      // already present and extraction has nothing to add. Doing nothing leaves
      // their row — and their ownership — intact, where an upsert would demote
      // it to `extracted` and put it right back in the path of the next
      // re-import.
      await tx.insert(recipeTags).values(extracted.tags.map((t) => ({
        recipeId,
        facet: t.facet,
        value: t.value,
        source: 'extracted' as const,
      }))).onConflictDoNothing()
    }

    // Delete-then-insert, never a bare insert: a re-import that only replaced
    // the base row would leave the previous extraction's terms searchable
    // forever, and a search hit that opens a recipe not containing the term is
    // the kind of bug nobody reports and everybody distrusts.
    // Carry the household note across. It is user-authored and never arrives
    // from extraction, so rewriting the row with an empty notes column would
    // leave a note that is still stored and still displayed but no longer
    // findable — and the documented repair for an unenriched recipe is exactly
    // a re-import, so the search index would silently rot on the recipes most
    // likely to be repaired.
    const existingNote = await tx
      .select({ notes: recipes.notes })
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .get()

    await tx.run(sql`DELETE FROM recipes_fts WHERE recipe_id = ${recipeId}`)
    await tx.run(sql`
      INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
      VALUES (${recipeId}, ${extracted.title}, ${ingredientsText(extracted)},
              ${stepsText(extracted)}, ${existingNote?.notes ?? ''}, ${narrativeText(extracted)})
    `)

    return recipeId
  })
}

/**
 * Layers Notion-only facts onto a recipe that `upsertRecipe` already wrote.
 *
 * Rating, status, and the original Notion tags cannot be produced by
 * extraction — they only ever existed in Notion — so the migration applies
 * them in a second pass after the import. That means this function must
 * tolerate being run twice: a migration resumed after a crash will re-apply
 * metadata to recipes it already touched. Tags rely on the
 * `(recipe_id, facet, value)` unique constraint for that; rating and status
 * are idempotent by construction.
 *
 * A null `rating` or `status` means "Notion had nothing in this cell", never
 * "clear what is stored". The difference matters because two Notion rows whose
 * links canonicalize to the same URL land on the same recipe: the second row,
 * blank, would otherwise erase the rating the first row supplied. Ratings and
 * cooking status are two of the three fields that exist nowhere but Notion, so
 * there is no second chance at them.
 *
 * Wrapped in a transaction even though the function is independently
 * idempotent (a crash between the two writes would leave a state a re-run
 * heals): without it, a reader could observe the rating updated but the tags
 * not yet added, and there's no reason to allow that when a transaction is
 * free.
 *
 * No FTS re-index here. `upsertRecipe`'s FTS row indexes only
 * title/ingredients/steps/notes/narrative (see the INSERT above) — tags were
 * never part of the searchable text, so adding Notion tags cannot make that
 * row stale.
 */
export async function applyNotionMetadata(
  db: Db,
  recipeId: string,
  input: { rating: number | null; status: 'made_it' | 'want_to_make' | null; tags: TagAssignment[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    // Only the fields Notion actually had. Absent keys are left off the `.set()`
    // entirely rather than written as null, which is what keeps a blank
    // duplicate row from wiping a real value — while a non-null rating still
    // sets one on a recipe that has none, and still overwrites one that does.
    const patch: {
      updatedAt: Date
      rating?: number
      status?: 'made_it' | 'want_to_make'
    } = { updatedAt: new Date() }
    if (input.rating !== null) patch.rating = input.rating
    if (input.status !== null) patch.status = input.status

    await tx.update(recipes).set(patch).where(eq(recipes.id, recipeId))

    if (input.tags.length > 0) {
      // Notion tags are user curation, so they are stamped `notion` and
      // `upsertRecipe` will not touch them again.
      //
      // On conflict we *escalate* rather than skip. Extraction and Notion both
      // producing `course:bread` is not a disagreement about the tag — both
      // want it there — it is a question of ownership, and the unique
      // constraint means only one row can answer. If the row stayed stamped
      // `extracted`, the next re-import would delete a tag the user curated by
      // hand: precisely the loss this column exists to prevent. Ownership
      // therefore only ever climbs the ladder extracted -> notion -> user, and
      // `setWhere` is what stops it going the other way — a `user` row is left
      // exactly as it is.
      await tx.insert(recipeTags)
        .values(input.tags.map((t) => ({
          recipeId, facet: t.facet, value: t.value, source: 'notion' as const,
        })))
        .onConflictDoUpdate({
          target: [recipeTags.recipeId, recipeTags.facet, recipeTags.value],
          set: { source: 'notion' },
          setWhere: eq(recipeTags.source, 'extracted'),
        })
    }
  })
}

/* -------------------------------------------------------------------------- */
/* The four fields no extraction can produce                                   */
/* -------------------------------------------------------------------------- */

/**
 * `rating`, `status`, `notes` and `actualTimeMinutes` — the only data in a
 * recipe row that cannot be regenerated. Everything else on the row is a read
 * of the archived page and can be re-extracted at will, which is exactly why
 * `upsertRecipe`'s `sourceFields` deliberately omits these four.
 */
export type UserFields = {
  rating: number | null
  status: 'want_to_make' | 'made_it' | null
  notes: string | null
  actualTimeMinutes: number | null
}

/**
 * A partial edit. **An absent key and an explicit `null` mean different
 * things**, and the distinction is the whole contract: `{ rating: 5 }` sets the
 * rating and must not touch the notes, while `{ rating: null }` clears the
 * rating on purpose. Writing every key on every call would mean a rating tap
 * silently erased a paragraph of notes typed last week — the one loss this
 * data has no way to recover from.
 *
 * `undefined` counts as absent rather than as "clear it", because that is what
 * comes back from a JSON body: JSON has `null` and has no `undefined`, so a key
 * that arrives at all arrives with a real value.
 */
export type UserFieldPatch = Partial<UserFields>

/**
 * Apply a partial edit to the four user-owned fields, and keep the search index
 * honest about the notes.
 *
 * Returns the four fields as they stand after the write, or `null` when there
 * is no such recipe — a missing id is a 404 for the caller to render, not an
 * exception to unwind. Reading them back rather than merging the patch onto
 * what was read first means the returned values are what the database actually
 * holds, including the empty-string-to-null normalization below.
 */
export async function updateUserFields(
  db: Db,
  recipeId: string,
  fields: UserFieldPatch,
): Promise<UserFields | null> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: recipes.id, title: recipes.title })
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .get()
    if (!existing) return null

    const patch: Partial<UserFields> & { updatedAt?: Date } = {}
    if (fields.rating !== undefined) patch.rating = fields.rating
    if (fields.status !== undefined) patch.status = fields.status
    if (fields.actualTimeMinutes !== undefined) patch.actualTimeMinutes = fields.actualTimeMinutes

    // Whitespace-only notes collapse to null rather than to `''`. Two ways to
    // spell "there is no note" would mean every reader needs both checks, and
    // the recipe page's `{recipe.notes && …}` would happily render an empty
    // amber panel for one of them.
    const notesEdited = fields.notes !== undefined
    const notes = notesEdited ? ((fields.notes ?? '').trim() || null) : null
    if (notesEdited) patch.notes = notes

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date()
      await tx.update(recipes).set(patch).where(eq(recipes.id, recipeId))
    }

    if (notesEdited) {
      // An UPDATE of the one FTS column that is user-owned, not a
      // delete-and-reinsert of the whole row. FTS5 handles an UPDATE by
      // removing the old column's terms from the index and adding the new
      // ones, so the previous note stops matching (asserted in
      // `tests/db/update-recipe.test.ts`); a bare INSERT would instead leave
      // the stale row in place *and* duplicate the recipe in every result.
      //
      // `''` rather than NULL for a cleared note, matching what `upsertRecipe`
      // writes, so the column has one representation of "nothing here".
      const updated = await tx.run(sql`
        UPDATE recipes_fts SET notes = ${notes ?? ''} WHERE recipe_id = ${recipeId}
      `)

      // Every production write path goes through `upsertRecipe`, which always
      // inserts an FTS row, so this branch should be unreachable. It exists
      // because the alternative when it *is* reached is the exact failure this
      // function was written to end: an UPDATE matching no rows succeeds
      // silently, and the note is saved, visible on the page, and unfindable
      // forever with nothing anywhere saying so. (Found by hand-seeding a
      // recipe row directly for a local run — searching for a word in its
      // saved note returned nothing at all.)
      //
      // The recovered row carries the title and the note. The source-derived
      // columns stay empty because they are `upsertRecipe`'s to write and
      // guessing at them here would put a second, divergent indexing rule in
      // the codebase; they were not indexed before this either, so nothing is
      // lost by leaving them.
      if (updated.rowsAffected === 0) {
        await tx.run(sql`
          INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
          VALUES (${recipeId}, ${existing.title}, '', '', ${notes ?? ''}, '')
        `)
      }
    }

    const after = await tx
      .select({
        rating: recipes.rating,
        status: recipes.status,
        notes: recipes.notes,
        actualTimeMinutes: recipes.actualTimeMinutes,
      })
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .get()

    return after ?? null
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
