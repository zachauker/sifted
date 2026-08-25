import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { getRecipeBySlug } from '@/lib/db/queries/recipe-detail'
import { RecipeView } from '@/components/recipe/recipe-view'

/**
 * Both `generateMetadata` and the page itself need the recipe, and Next calls
 * them separately for the same request. `cache` collapses that back into one
 * fetch per request — without it every recipe view would cost ten SQL
 * statements to render five statements' worth of page. (React's `cache` only
 * memoizes within a single request, which is exactly the scope wanted here: a
 * rating edited in one tab must not be served stale to another.)
 */
const loadRecipe = cache((slug: string) => getRecipeBySlug(db, slug))

/**
 * `/recipes/<slug>` — the recipe.
 *
 * Thin on purpose: fetch, 404, render. Everything the page actually *is*
 * lives in `RecipeView`, which is a plain synchronous component and can
 * therefore be rendered directly in a test without a database, a request, or
 * a Next runtime. A page that both queried and laid out would be testable
 * only through the whole framework.
 *
 * `notFound()` rather than a hand-rolled "we couldn't find that" panel: a
 * missing recipe is a genuine 404, and Next's boundary sets the status code
 * and the `noindex` tag that go with one. A bookmark to a deleted recipe, or
 * a hand-edited URL, should look like every other dead link on the web.
 */
export default async function RecipePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const recipe = await loadRecipe(slug)

  if (!recipe) notFound()

  return <RecipeView recipe={recipe} />
}

/**
 * The browser tab, and what a shared link previews as. "Recipe Manager" on
 * every tab is useless when three recipes are open at once mid-cook, and the
 * tab strip is all a phone shows.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const recipe = await loadRecipe(slug)

  if (!recipe) return { title: 'Recipe not found' }

  return { title: recipe.title, description: recipe.description ?? undefined }
}
