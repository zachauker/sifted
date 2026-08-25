export const FACETS = ['course', 'ingredient', 'method', 'cuisine', 'tag'] as const
export type Facet = (typeof FACETS)[number]

export type TagAssignment = { facet: Facet; value: string }

export const COURSE_VALUES = [
  'main', 'side', 'appetizer', 'dessert', 'breakfast', 'sauce', 'bread', 'drink',
] as const

export const INGREDIENT_VALUES = [
  'chicken', 'beef', 'pork', 'seafood', 'lamb', 'egg', 'vegetarian',
  'pasta', 'rice', 'grain', 'potato', 'beans', 'cheese', 'vegetable', 'fruit',
] as const

export const METHOD_VALUES = [
  'grill', 'oven', 'stovetop', 'slow-cooker', 'instant-pot',
  'air-fryer', 'no-cook', 'smoker', 'sous-vide',
] as const

export const CUISINE_VALUES = [
  'american', 'italian', 'mexican', 'chinese', 'japanese', 'korean', 'thai',
  'indian', 'french', 'mediterranean', 'middle-eastern', 'spanish',
  'vietnamese', 'greek', 'german', 'caribbean', 'african', 'asian', 'southern',
] as const

export const VOCABULARY: Record<Exclude<Facet, 'tag'>, readonly string[]> = {
  course: COURSE_VALUES,
  ingredient: INGREDIENT_VALUES,
  method: METHOD_VALUES,
  cuisine: CUISINE_VALUES,
}

export function isValidTag(tag: TagAssignment): boolean {
  if (!FACETS.includes(tag.facet)) return false
  if (tag.facet === 'tag') return tag.value.length > 0
  const vocab = VOCABULARY[tag.facet]
  return vocab ? vocab.includes(tag.value) : false
}

// Object.create(null) so lookups can never resolve to an inherited
// Object.prototype member (e.g. normalizeTag('constructor') or
// normalizeTag('toString')) instead of a real miss.
const ALIASES: Record<string, TagAssignment | null> = Object.create(null) as Record<
  string,
  TagAssignment | null
>

function alias(facet: Facet, value: string, ...raws: string[]) {
  // Frozen so callers can never mutate the shared object normalizeTag hands
  // back for every raw string that resolves to this facet/value pair.
  const target: TagAssignment = Object.freeze({ facet, value })
  if (!isValidTag(target)) {
    throw new Error(`taxonomy: alias target ${facet}:${value} is not in the vocabulary`)
  }
  for (const raw of raws) ALIASES[key(raw)] = target
}

function drop(...raws: string[]) {
  for (const raw of raws) ALIASES[key(raw)] = null
}

function key(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\s_/-]+/g, ' ')
    .trim()
}

/** True when `k` is a registered key in ALIASES, including keys explicitly dropped (mapped to null). */
function hasKey(k: string): boolean {
  return k in ALIASES
}

// --- course -----------------------------------------------------------------
alias(
  'course', 'main',
  'main', 'main course', 'main dish', 'entree', 'entrée', 'dinner recipes', 'dinner recipe',
)
alias('course', 'side', 'side', 'side dish', 'sides')
alias(
  'course', 'appetizer',
  'appetizer', 'appetizers', 'starter', 'snack', 'snacks', 'party food', 'hors doeuvre',
  'appetizers and snacks', 'appetizer and snack',
)
alias('course', 'dessert', 'dessert', 'desserts', 'sweets', 'cake', 'cookies')
alias('course', 'breakfast', 'breakfast', 'brunch', 'breakfast and brunch', 'breakfast brunch')
alias(
  'course', 'sauce',
  'sauce', 'sauces', 'condiment', 'condiments', 'dressing', 'marinade', 'dip', 'dips',
)
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
alias('ingredient', 'rice', 'rice')
alias('ingredient', 'grain', 'grain', 'grains')
alias('ingredient', 'potato', 'potato', 'potatoes')
alias('ingredient', 'beans', 'beans', 'legumes', 'lentils')
alias('ingredient', 'cheese', 'cheese')
alias('ingredient', 'vegetable', 'vegetable', 'greens', 'vegetables', 'veggies')
alias('ingredient', 'fruit', 'fruit', 'apples', 'berries')

// --- method -----------------------------------------------------------------
alias('method', 'grill', 'grill', 'grilling', 'grilled', 'barbecue', 'bbq')
alias('method', 'oven', 'oven', 'baked', 'bake', 'baking', 'roast', 'roasted', 'broil')
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
alias('cuisine', 'middle-eastern', 'lebanese', 'turkish')

// --- open tags (dish types with no dedicated facet) -------------------------
alias('tag', 'soup', 'soup', 'soup stew', 'stew', 'chili', 'soups and stews', 'soup and stew')
alias('tag', 'salad', 'salad', 'salads')
alias('tag', 'sandwich', 'sandwich', 'sandwhich', 'burger', 'wrap')
alias('tag', 'meal-prep', 'meal prep')
alias('tag', 'pizza', 'pizza')
alias('tag', 'holiday', 'thanksgiving', 'christmas', 'holiday')
alias('tag', 'quick', 'quick', '30 minute meals', 'weeknight')
alias('tag', 'casserole', 'casserole')
alias('tag', 'sheet-pan', 'sheet pan')
alias('tag', 'one-pot', 'one pot')

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

/**
 * Maps a raw source string (a JSON-LD recipeCategory, a Notion tag, an LLM
 * suggestion) onto a facet and canonical value. Returns null when the string
 * is not food-related or carries no filtering information.
 *
 * Beyond an exact lookup, two forms of fuzzy matching are tried, in order,
 * only when the previous attempt missed entirely (an explicit drop counts as
 * a hit, not a miss, so e.g. 'dinner recipes' — an alias in its own right —
 * is never reinterpreted by the fallbacks below):
 *  1. a trailing "recipe"/"recipes" suffix is stripped once
 *     ("Chicken Recipes" -> "chicken"), and
 *  2. a plural mismatch is corrected by stripping a trailing "es", then a
 *     trailing "s", then — for the reverse case, a singular input against a
 *     plural alias like "cookies" — by appending "s"
 *     ("Soups" -> "soup", "Entrees" -> "entree", "Cookie" -> "cookies").
 */
export function normalizeTag(raw: string | null | undefined): TagAssignment | null {
  if (typeof raw !== 'string' || !raw) return null
  const k = key(raw)
  if (hasKey(k)) return ALIASES[k]

  const withoutRecipesSuffix = k.replace(/\s+recipes?$/, '')
  if (withoutRecipesSuffix !== k && hasKey(withoutRecipesSuffix)) {
    return ALIASES[withoutRecipesSuffix]
  }

  // Safe only because no two registered keys `a` and `a + 'e'` currently
  // coexist — otherwise stripping "es" before "s" could match the wrong
  // one. A future alias() addition that creates such a pair would need to
  // account for this ordering; there is no test to catch it.
  if (k.endsWith('es') && hasKey(k.slice(0, -2))) return ALIASES[k.slice(0, -2)]
  if (k.endsWith('s') && hasKey(k.slice(0, -1))) return ALIASES[k.slice(0, -1)]
  if (hasKey(`${k}s`)) return ALIASES[`${k}s`]

  return null
}

/** Normalizes a list of raw strings, dropping unrecognized entries and duplicates. */
export function normalizeTags(raws: readonly string[] | null | undefined): TagAssignment[] {
  const seen = new Set<string>()
  const out: TagAssignment[] = []
  for (const raw of raws ?? []) {
    const tag = normalizeTag(raw)
    if (!tag) continue
    const id = `${tag.facet}:${tag.value}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(tag)
  }
  return out
}
