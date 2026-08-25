import type { TagAssignment } from '@/lib/taxonomy'

export type ExtractionMethod = 'jsonld' | 'microdata' | 'llm' | 'notion' | 'manual'

export type ExtractedIngredient = {
  position: number
  section: string | null
  rawText: string
  quantity: number | null
  unit: string | null
  item: string | null
  note: string | null
}

export type ExtractedStep = {
  position: number
  section: string | null
  text: string
}

export type ExtractedRecipe = {
  title: string
  description: string | null
  author: string | null
  publisher: string | null
  claimedTimeMinutes: number | null
  servings: number | null
  yieldText: string | null
  ingredients: ExtractedIngredient[]
  steps: ExtractedStep[]
  tags: TagAssignment[]
  heroImageUrl: string | null
  narrativeHtml: string | null
  extractionMethod: ExtractionMethod
}

/** A recipe body with no narrative or enrichment applied yet. */
export type PartialRecipe = Omit<ExtractedRecipe, 'narrativeHtml'>
