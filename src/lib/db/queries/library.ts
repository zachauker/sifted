import { and, eq, sql } from 'drizzle-orm'
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
 * Query 1 selects every recipe column the client needs, left-joined to its
 * `source_hero` image. The role filter lives in the join's ON clause, not a
 * WHERE — a WHERE would turn the LEFT JOIN into an effective INNER JOIN and
 * silently drop every recipe with no image. This join is 1:1 in practice (one
 * `source_hero` row per recipe from `ingestHeroImage`), so it does not
 * multiply recipe rows.
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
      thumbUrl: images.thumbUrl,
    })
    .from(recipes)
    .leftJoin(images, and(eq(images.recipeId, recipes.id), eq(images.role, 'source_hero')))
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

  // Defensive de-dupe: `images` has no unique constraint on (recipeId,
  // role), so if a future bug ever wrote two `source_hero` rows for one
  // recipe, the LEFT JOIN above would fan out into two rows for it. Keeping
  // only the first occurrence (already in the newest-first / rowid order
  // established above) means that stays a data-quality issue to fix, not a
  // duplicated card in the grid.
  const seen = new Set<string>()
  const entries: LibraryEntry[] = []
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
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
