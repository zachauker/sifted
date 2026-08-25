export const FACETS = ['course', 'ingredient', 'method', 'cuisine', 'tag'] as const
export type Facet = (typeof FACETS)[number]

export type TagAssignment = { facet: Facet; value: string }

export const COURSE_VALUES = [
  'main', 'side', 'appetizer', 'dessert', 'breakfast', 'sauce', 'bread', 'drink',
] as const

export const INGREDIENT_VALUES = [
  'chicken', 'beef', 'pork', 'seafood', 'lamb', 'egg', 'vegetarian',
  'pasta', 'rice', 'potato', 'beans', 'cheese', 'greens', 'fruit',
] as const

export const METHOD_VALUES = [
  'grill', 'oven', 'stovetop', 'slow-cooker', 'instant-pot',
  'air-fryer', 'no-cook', 'smoker', 'sous-vide',
] as const

export const CUISINE_VALUES = [
  'american', 'italian', 'mexican', 'chinese', 'japanese', 'korean', 'thai',
  'indian', 'french', 'mediterranean', 'middle-eastern', 'spanish',
  'vietnamese', 'greek', 'german', 'caribbean', 'african',
] as const

export const VOCABULARY: Record<Exclude<Facet, 'tag'>, readonly string[]> = {
  course: COURSE_VALUES,
  ingredient: INGREDIENT_VALUES,
  method: METHOD_VALUES,
  cuisine: CUISINE_VALUES,
}

/**
 * Maps a raw source string (a JSON-LD recipeCategory, a Notion tag, an LLM
 * suggestion) onto a facet and canonical value. Returns null when the string
 * is not food-related or carries no filtering information.
 */
const ALIASES: Record<string, TagAssignment | null> = {}

function alias(facet: Facet, value: string, ...raws: string[]) {
  for (const raw of raws) ALIASES[key(raw)] = { facet, value }
}

function drop(...raws: string[]) {
  for (const raw of raws) ALIASES[key(raw)] = null
}

function key(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_/-]+/g, ' ')
}

// --- course -----------------------------------------------------------------
alias('course', 'main', 'main', 'main course', 'main dish', 'entree', 'entrée', 'dinner recipes')
alias('course', 'side', 'side', 'side dish', 'sides')
alias('course', 'appetizer', 'appetizer', 'appetizers', 'starter', 'snack', 'party food', 'hors doeuvre')
alias('course', 'dessert', 'dessert', 'desserts', 'sweets', 'baking', 'cake', 'cookies')
alias('course', 'breakfast', 'breakfast', 'brunch', 'breakfast and brunch')
alias('course', 'sauce', 'sauce', 'sauces', 'condiment', 'condiments', 'dressing', 'marinade', 'dip')
alias('course', 'bread', 'bread', 'breads', 'baked goods')
alias('course', 'drink', 'drink', 'drinks', 'beverage', 'beverages', 'cocktail', 'cocktails')

// --- ingredient -------------------------------------------------------------
alias('ingredient', 'chicken', 'chicken', 'poultry', 'turkey')
alias('ingredient', 'beef', 'beef', 'steak', 'ground beef')
alias('ingredient', 'pork', 'pork', 'bacon', 'ham', 'sausage')
alias('ingredient', 'seafood', 'seafood', 'fish', 'shrimp', 'salmon', 'shellfish')
alias('ingredient', 'lamb', 'lamb')
alias('ingredient', 'egg', 'egg', 'eggs')
alias('ingredient', 'vegetarian', 'vegetarian', 'vegan', 'meatless', 'plant based')
alias('ingredient', 'pasta', 'pasta', 'noodles', 'spaghetti')
alias('ingredient', 'rice', 'rice', 'grain', 'grains')
alias('ingredient', 'potato', 'potato', 'potatoes')
alias('ingredient', 'beans', 'beans', 'legumes', 'lentils')
alias('ingredient', 'cheese', 'cheese')
alias('ingredient', 'greens', 'greens', 'vegetables', 'veggies')
alias('ingredient', 'fruit', 'fruit', 'apples', 'berries')

// --- method -----------------------------------------------------------------
alias('method', 'grill', 'grill', 'grilling', 'grilled', 'barbecue', 'bbq')
alias('method', 'oven', 'oven', 'baked', 'bake', 'roast', 'roasted', 'broil')
alias('method', 'stovetop', 'stovetop', 'skillet', 'pan fry', 'saute', 'sauté', 'fried', 'deep fry')
alias('method', 'slow-cooker', 'slow cooker', 'crockpot', 'crock pot')
alias('method', 'instant-pot', 'instant pot', 'pressure cooker')
alias('method', 'air-fryer', 'air fryer')
alias('method', 'no-cook', 'no cook', 'raw')
alias('method', 'smoker', 'smoker', 'smoked')
alias('method', 'sous-vide', 'sous vide')

// --- cuisine ----------------------------------------------------------------
for (const c of CUISINE_VALUES) alias('cuisine', c, c.replace(/-/g, ' '))
alias('cuisine', 'italian', 'italian american')
alias('cuisine', 'mexican', 'tex mex')
alias('cuisine', 'mediterranean', 'macedonian')
alias('cuisine', 'middle-eastern', 'middle eastern', 'lebanese', 'turkish')

// --- open tags (dish types with no dedicated facet) -------------------------
alias('tag', 'soup', 'soup', 'soup stew', 'stew', 'chili')
alias('tag', 'salad', 'salad', 'salads')
alias('tag', 'sandwich', 'sandwich', 'sandwhich', 'burger', 'wrap')
alias('tag', 'meal-prep', 'meal prep')
alias('tag', 'pizza', 'pizza')
alias('tag', 'holiday', 'thanksgiving', 'christmas', 'holiday')
alias('tag', 'quick', 'quick', '30 minute meals', 'weeknight')

// --- explicitly dropped -----------------------------------------------------
// "Meal" tags duplicate course and are applied reflexively; see the spec.
drop('dinner', 'lunch', 'supper', 'recipe', 'recipes', 'food')
// Non-food tags inherited from the shared Notion Library database.
drop(
  'technology', 'education', 'health', 'back pain', 'music', 'mf doom', 'hip hop',
  'gaming', 'game development', 'covid 19', 'religion', 'cults', 'pelvic pain',
  'lifestyle', 'sports', 'interview', 'lpn', 'remote work', 'programming',
  'software', 'politics', 'government', 'travel', 'grifters', 'true crime',
  'science', 'drugs', 'self help', 'anxiety', 'adhd', 'relationships', 'economy',
  'python', 'discord', 'raspberry pi', '3d printing', 'project', 'security',
  'testing', 'source control', 'docker', 'laravel', 'javascript',
)

export function normalizeTag(raw: string): TagAssignment | null {
  if (!raw) return null
  return ALIASES[key(raw)] ?? null
}

export function isValidTag(tag: TagAssignment): boolean {
  if (tag.facet === 'tag') return tag.value.length > 0
  const vocab = VOCABULARY[tag.facet]
  return vocab ? vocab.includes(tag.value) : false
}

/** Normalizes a list of raw strings, dropping unrecognized entries and duplicates. */
export function normalizeTags(raws: string[]): TagAssignment[] {
  const seen = new Set<string>()
  const out: TagAssignment[] = []
  for (const raw of raws) {
    const tag = normalizeTag(raw)
    if (!tag) continue
    const id = `${tag.facet}:${tag.value}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(tag)
  }
  return out
}
