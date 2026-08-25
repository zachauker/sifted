import { z } from 'zod'

export const enrichmentSchema = z.object({
  description: z.string().nullable(),
  tags: z.array(z.object({ facet: z.string(), value: z.string() })),
  ingredients: z.array(
    z.object({
      position: z.number().int().nonnegative(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      item: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
})

export type Enrichment = z.infer<typeof enrichmentSchema>

export const llmRecipeSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  claimedTimeMinutes: z.number().int().positive().nullable(),
  servings: z.number().int().positive().nullable(),
  yieldText: z.string().nullable(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
})

export type LlmRecipe = z.infer<typeof llmRecipeSchema>

/** The only surface `extract()` sees. Implemented for real in Task 9. */
export type LlmClient = {
  enrich(input: { title: string; ingredientLines: string[]; rawTags: string[] }): Promise<unknown>
  extractRecipe(input: { url: string; text: string }): Promise<unknown>
}
