import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { recipes, images, recipeTags } from '@/lib/db/schema'

/**
 * One entry per recipe, sized to be handed to the browser whole. The whole
 * point of the library UI is that every filter click, sort, and keystroke is
 * an in-memory operation over this array — no request per interaction. That
 * only holds if this payload stays small, which is what
 * `tests/db/library-index.test.ts` measures against a realistic 156-recipe
 * library.
 */
export type LibraryEntry = {
  id: string
  slug: string
  title: string
  thumbUrl: string | null
  publisher: string | null
  rating: number | null
  status: 'want_to_make' | 'made_it' | null
  claimedTimeMinutes: number | null
  actualTimeMinutes: number | null
  createdAt: number // epoch ms — sorts and serializes cheaply
  tags: string[] // "facet:value", flat
}

/**
 * Builds the whole-library payload in two queries, not one per recipe.
 *
 * Query 1 selects every recipe column the client needs, with `thumbUrl` from
 * a correlated subquery that picks the recipe's cover photo — a chosen photo,
 * else the publisher's, else the oldest, the same rule `pickCover` applies in
 * memory for the recipe page. A subquery, not a join, because it must yield
 * exactly one value per recipe: a join would fan a five-photo recipe out into
 * five rows.
 *
 * Query 2 selects every tag in the library and groups it onto its recipe in
 * memory, rather than joining `recipe_tags` onto query 1. A join there would
 * multiply each recipe row by its tag count — a recipe with 6 tags would come
 * back as 6 rows, each carrying a full copy of every recipe column, which is
 * far more bytes over the wire (and more work for SQLite) than a second
 * narrow query grouped client-side. Measured against 156 recipes with 4-6
 * tags and an image each, both queries together run in low single-digit
 * milliseconds — see the test file for the measured number.
 *
 * Selected columns are deliberately narrow: no `narrative_html`, no
 * ingredient/step rows, no `archived_html_key`. None of those are in
 * `LibraryEntry`, and they are exactly the large columns this endpoint exists
 * to avoid loading on every page view.
 */
export async function buildLibraryIndex(db: Db): Promise<LibraryEntry[]> {
  // The cover rule in SQL — `pickCover`'s twin, held to it by
  // `tests/db/cover-rule.test.ts`. A correlated subquery rather than a join:
  // it yields exactly one value per recipe, so a recipe with five photos is
  // still one row.
  //
  // Built as its own `sql` value, then interpolated into the select below,
  // rather than written inline there. Drizzle's single-table selects (no
  // joins — which this query has none of) de-qualify every `Column` embedded
  // directly in a top-level select expression, on the assumption that one
  // table needs no `table.column` prefixes. That assumption breaks a
  // correlated subquery: both `images` and `recipes` are in scope, and both
  // have an `id` column, so a de-qualified `id` binds to whichever table SQL
  // resolves first (`images`, here) and the correlation silently matches
  // nothing. Nesting the subquery one level — an `SQL` chunk rather than a
  // `Column` chunk at the top level — keeps Drizzle from touching it, so
  // `images.id` and `recipes.id` stay `"images"."id"` and `"recipes"."id"`.
  // Both renditions must be stored, not just the thumbnail — isRenderable in
  // cover.ts applies the identical requirement in memory, and
  // tests/db/cover-rule.test.ts runs both against the same rows. A row with
  // only one URL (a legacy backfill, or a photo left half-written by a failed
  // upload) is not something PhotoManager or RecipeView will draw, so it must
  // not be picked as the library thumbnail either.
  const coverThumbUrl = sql`(
    SELECT ${images.thumbUrl} FROM ${images}
    WHERE ${images.recipeId} = ${recipes.id}
      AND ${images.thumbUrl} IS NOT NULL AND ${images.blobUrl} IS NOT NULL
    ORDER BY ${images.isCover} DESC, (${images.role} = 'source_hero') DESC,
      ${images.createdAt} ASC, ${images}.rowid ASC
    LIMIT 1
  )`

  const rows = await db
    .select({
      id: recipes.id,
      slug: recipes.slug,
      title: recipes.title,
      publisher: recipes.publisher,
      rating: recipes.rating,
      status: recipes.status,
      claimedTimeMinutes: recipes.claimedTimeMinutes,
      actualTimeMinutes: recipes.actualTimeMinutes,
      createdAt: recipes.createdAt,
      thumbUrl: sql<string | null>`${coverThumbUrl}`,
    })
    .from(recipes)
    // Newest first. `createdAt` is second-resolution and recipes migrated
    // from Notion (or imported in a burst) routinely tie on it, so `rowid`
    // — SQLite's monotonic insertion counter — breaks the tie the same way
    // `listJobs` does, keeping the order both correct and stable across
    // calls rather than depending on whatever order a tied group happens to
    // come back in.
    .orderBy(sql`${recipes.createdAt} desc`, sql`${recipes}.rowid desc`)

  const tagRows = await db
    .select({ recipeId: recipeTags.recipeId, facet: recipeTags.facet, value: recipeTags.value })
    .from(recipeTags)

  const tagsByRecipe = new Map<string, string[]>()
  for (const t of tagRows) {
    const tag = `${t.facet}:${t.value}`
    const existing = tagsByRecipe.get(t.recipeId)
    if (existing) existing.push(tag)
    else tagsByRecipe.set(t.recipeId, [tag])
  }

  const entries: LibraryEntry[] = []
  for (const r of rows) {
    entries.push({
      id: r.id,
      slug: r.slug,
      title: r.title,
      thumbUrl: r.thumbUrl ?? null,
      publisher: r.publisher,
      rating: r.rating,
      status: r.status,
      claimedTimeMinutes: r.claimedTimeMinutes,
      actualTimeMinutes: r.actualTimeMinutes,
      createdAt: r.createdAt.getTime(),
      tags: tagsByRecipe.get(r.id) ?? [],
    })
  }

  return entries
}
