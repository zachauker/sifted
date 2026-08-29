import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { recipes, ingredients, steps, recipeTags, images } from '@/lib/db/schema'

/**
 * Everything the recipe page renders, for one recipe.
 *
 * Deliberately not `typeof recipes.$inferSelect`: `archivedHtmlKey` and
 * `sourceEncoding` are re-extraction plumbing that nothing on the page reads,
 * and spreading the whole row would quietly hand them to a future component
 * (and, once any of this crosses into a Client Component's props, to the
 * browser). The columns named here are the ones the page actually draws —
 * plus `id`, `rating`, `status`, `notes` and `actualTimeMinutes`, which the
 * edit controls in the next task need.
 */
export type RecipeDetail = {
  id: string
  slug: string
  title: string
  sourceUrl: string | null
  sourceDomain: string | null
  publisher: string | null
  author: string | null
  description: string | null
  claimedTimeMinutes: number | null
  actualTimeMinutes: number | null
  servings: number | null
  yieldText: string | null
  rating: number | null
  status: 'want_to_make' | 'made_it' | null
  notes: string | null
  narrativeHtml: string | null
  extractionMethod: 'jsonld' | 'microdata' | 'llm' | 'notion' | 'manual'
  handEdited: boolean
  createdAt: Date
  ingredients: DetailIngredient[]
  steps: DetailStep[]
  tags: DetailTag[]
  images: DetailImage[]
}

export type DetailIngredient = {
  position: number
  section: string | null
  /**
   * The source line, verbatim, and the only ingredient field the page is
   * allowed to render as the ingredient. The parsed columns beside it are an
   * LLM enhancement that may be absent or simply wrong; the raw line is the
   * guarantee. See the column comment in `schema.ts`.
   */
  rawText: string
  quantity: number | null
  unit: string | null
  item: string | null
  note: string | null
}

export type DetailStep = {
  position: number
  section: string | null
  text: string
}

export type DetailTag = {
  facet: 'course' | 'ingredient' | 'method' | 'cuisine' | 'tag'
  value: string
}

export type DetailImage = {
  role: 'source_hero' | 'user'
  blobUrl: string | null
  thumbUrl: string | null
  width: number
  height: number
}

/**
 * The recipe behind a slug, with its children, or `null`.
 *
 * ## Round trips: five statements in two waves, never N+1
 *
 * The recipe row is fetched first because everything else keys off its id and
 * because a miss must cost exactly one statement — a slug typo should not
 * fan out into four child queries against an id that does not exist. Once it
 * hits, the four child queries are independent and go out together under
 * `Promise.all`, so the wall-clock cost is two waves, not five.
 *
 * The children are *not* joined onto the recipe. A single join across
 * ingredients, steps, tags and images is a four-way cartesian product: a
 * pedestrian recipe with 12 ingredients, 8 steps, 5 tags and 1 image comes
 * back as 480 rows, each carrying a full copy of every recipe column
 * (including `narrative_html`, which is the largest column in the schema and
 * routinely kilobytes). Four narrow statements against an indexed
 * `recipe_id` are both less work for SQLite and dramatically fewer bytes over
 * the wire — the same reasoning `buildLibraryIndex` records for its tag
 * query.
 *
 * ## Ordering
 *
 * `ingredients` and `steps` come back ordered by `position`, in SQL, not in
 * memory. Nothing else in the codebase may re-sort them. Steps served in the
 * wrong order render perfectly and ruin the dish, and there is no visible
 * symptom to notice — which is why `tests/db/recipe-detail.test.ts` inserts
 * them scrambled and asserts the order rather than trusting SQLite's
 * insertion-order default to keep quietly covering for a missing ORDER BY.
 *
 * ## Duplicate slugs
 *
 * `recipes.slug` carries no unique constraint (dedupe is on `sourceUrl`), so
 * two recipes can in principle collide on one. Ordering by `rowid` and taking
 * the first makes that resolve to the older recipe, deterministically, on
 * every request — a stable wrong answer that a reader can report, rather than
 * a page that shows a different recipe depending on the query plan.
 */
export async function getRecipeBySlug(db: Db, slug: string): Promise<RecipeDetail | null> {
  const recipe = await db
    .select({
      id: recipes.id,
      slug: recipes.slug,
      title: recipes.title,
      sourceUrl: recipes.sourceUrl,
      sourceDomain: recipes.sourceDomain,
      publisher: recipes.publisher,
      author: recipes.author,
      description: recipes.description,
      claimedTimeMinutes: recipes.claimedTimeMinutes,
      actualTimeMinutes: recipes.actualTimeMinutes,
      servings: recipes.servings,
      yieldText: recipes.yieldText,
      rating: recipes.rating,
      status: recipes.status,
      notes: recipes.notes,
      narrativeHtml: recipes.narrativeHtml,
      extractionMethod: recipes.extractionMethod,
      handEdited: recipes.handEdited,
      createdAt: recipes.createdAt,
    })
    .from(recipes)
    .where(eq(recipes.slug, slug))
    .orderBy(sql`${recipes}.rowid`)
    .limit(1)
    .get()

  if (!recipe) return null

  const [ingredientRows, stepRows, tagRows, imageRows] = await Promise.all([
    db
      .select({
        position: ingredients.position,
        section: ingredients.section,
        rawText: ingredients.rawText,
        quantity: ingredients.quantity,
        unit: ingredients.unit,
        item: ingredients.item,
        note: ingredients.note,
      })
      .from(ingredients)
      .where(eq(ingredients.recipeId, recipe.id))
      .orderBy(ingredients.position),
    db
      .select({
        position: steps.position,
        section: steps.section,
        text: steps.text,
      })
      .from(steps)
      .where(eq(steps.recipeId, recipe.id))
      .orderBy(steps.position),
    db
      .select({ facet: recipeTags.facet, value: recipeTags.value })
      .from(recipeTags)
      .where(eq(recipeTags.recipeId, recipe.id))
      // Facet then value, so the tag row on the page is stable between
      // renders instead of following whatever order the tags were written in.
      .orderBy(recipeTags.facet, recipeTags.value),
    db
      .select({
        role: images.role,
        blobUrl: images.blobUrl,
        thumbUrl: images.thumbUrl,
        width: images.width,
        height: images.height,
      })
      .from(images)
      .where(eq(images.recipeId, recipe.id))
      .orderBy(images.createdAt),
  ])

  return {
    ...recipe,
    ingredients: ingredientRows,
    steps: stepRows,
    tags: tagRows,
    images: imageRows,
  }
}
