import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { getRecipeBySlug } from '@/lib/db/queries/recipe-detail'
import { RecipeEditForm } from '@/components/recipe/recipe-edit-form'
import { saveRecipeEdits } from './actions'

/**
 * `/recipes/<slug>/edit` — fixing what a recipe says.
 *
 * Thin like the recipe page it sits beside: fetch, 404, render. The action is
 * bound to the recipe here rather than carried in a hidden input, so the form
 * has no say in which recipe it writes to.
 */
export default async function EditRecipePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const recipe = await getRecipeBySlug(db, slug)

  if (!recipe) notFound()

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold sm:text-2xl">Edit “{recipe.title}”</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500 dark:text-neutral-400">
        Your rating, notes, and how long it really took are edited on the recipe itself and are not
        touched here.
      </p>
      <RecipeEditForm
        recipe={recipe}
        action={saveRecipeEdits.bind(null, { id: recipe.id, slug: recipe.slug })}
      />
    </main>
  )
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const recipe = await getRecipeBySlug(db, slug)
  return { title: recipe ? `Edit ${recipe.title}` : 'Recipe not found' }
}
