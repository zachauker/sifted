import { isValidTag, type Facet, type TagAssignment, FACETS } from '@/lib/taxonomy'
import { enrichmentSchema, type LlmClient } from './llm-types'
import type { PartialRecipe } from './types'

function isFacet(value: string): value is Facet {
  return (FACETS as readonly string[]).includes(value)
}

/**
 * Layers LLM-derived structure onto an already-extracted recipe. Enrichment is
 * strictly additive: it never overwrites data the source provided, and any
 * value outside the controlled vocabulary is dropped rather than persisted.
 * Failure of any kind leaves the recipe untouched — a recipe without parsed
 * quantities is still a usable recipe.
 */
export async function applyEnrichment(
  recipe: PartialRecipe,
  llm: LlmClient,
): Promise<PartialRecipe> {
  let raw: unknown
  try {
    raw = await llm.enrich({
      title: recipe.title,
      ingredientLines: recipe.ingredients.map((i) => i.rawText),
      rawTags: recipe.tags.map((t) => `${t.facet}:${t.value}`),
    })
  } catch {
    return recipe
  }

  const parsed = enrichmentSchema.safeParse(raw)
  if (!parsed.success) return recipe

  const { description, tags, ingredients } = parsed.data

  const validTags: TagAssignment[] = []
  const seen = new Set(recipe.tags.map((t) => `${t.facet}:${t.value}`))
  for (const tag of tags) {
    if (!isFacet(tag.facet)) continue
    const candidate: TagAssignment = { facet: tag.facet, value: tag.value }
    if (!isValidTag(candidate)) continue
    const id = `${candidate.facet}:${candidate.value}`
    if (seen.has(id)) continue
    seen.add(id)
    validTags.push(candidate)
  }

  const byPosition = new Map(ingredients.map((i) => [i.position, i]))

  return {
    ...recipe,
    description: recipe.description ?? description,
    tags: [...recipe.tags, ...validTags],
    ingredients: recipe.ingredients.map((ingredient) => {
      const parsedIngredient = byPosition.get(ingredient.position)
      if (!parsedIngredient) return ingredient
      return {
        ...ingredient,
        quantity: parsedIngredient.quantity,
        unit: parsedIngredient.unit,
        item: parsedIngredient.item,
        note: parsedIngredient.note,
      }
    }),
  }
}
