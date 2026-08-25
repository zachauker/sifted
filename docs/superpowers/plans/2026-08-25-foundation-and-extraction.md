# Recipe Manager: Foundation & Extraction Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested, pure extraction pipeline that turns a recipe URL into a validated `ExtractedRecipe` — structured data first, LLM fallback — provable from a CLI before any database or UI exists.

**Architecture:** `lib/extract` is a pure function of `{ url, html }` with no network, no database, and no clock. Everything hostile lives outside it: `lib/fetch` owns the network, and the LLM client is injected as an interface so tests never call Claude. `lib/taxonomy` is a pure module defining the controlled vocabulary, consumed by the extractor, the (later) UI, and the (later) Notion migration, so the vocabulary cannot drift.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind, Vitest, Zod, `@mozilla/readability` + `jsdom`, `@anthropic-ai/sdk`, `tsx`.

**Source spec:** `docs/superpowers/specs/2026-08-25-recipe-manager-design.md`

**Scope note:** This is plan 1 of 3 for Phase 1. It delivers extraction end-to-end. Plan 2 adds persistence, the import API, and the iOS Shortcut. Plan 3 adds the UI and the Notion migration.

---

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/app/*` (generated)
- Create: `vitest.config.ts`
- Create: `src/lib/smoke.test.ts`

- [ ] **Step 1: Generate the Next.js app into a subdirectory**

The repo root already contains `docs/` and `.superpowers/`, and `create-next-app` refuses to write into a directory containing files it does not recognize. Generate into a scratch subdirectory and move the result up.

```bash
cd /Users/zacharyauker/Development/recipe-manager
npx create-next-app@latest .scaffold \
  --typescript --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-npm --yes
```

- [ ] **Step 2: Move the scaffold into the repo root and clean up**

```bash
cd /Users/zacharyauker/Development/recipe-manager
rsync -a --exclude '.git' .scaffold/ ./
rm -rf .scaffold
ls package.json src/app/page.tsx
```

Expected: both paths listed, no error.

- [ ] **Step 3: Install the dependencies this plan needs**

```bash
npm install zod @mozilla/readability jsdom @anthropic-ai/sdk
npm install -D vitest @types/jsdom tsx
```

- [ ] **Step 4: Create the Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
```

- [ ] **Step 5: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Write a smoke test**

Create `src/lib/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 7: Run the test suite**

Run: `npm test`
Expected: PASS, 1 test passed.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Vitest"
```

---

### Task 2: The taxonomy module

This is the single source of truth for the controlled vocabulary. It constrains LLM output, drives the filter UI, and maps the legacy Notion tags.

**Files:**
- Create: `src/lib/taxonomy/index.ts`
- Test: `src/lib/taxonomy/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/taxonomy/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeTag, isValidTag, COURSE_VALUES } from './index'

describe('normalizeTag', () => {
  it('maps a course name to the course facet', () => {
    expect(normalizeTag('Main Course')).toEqual({ facet: 'course', value: 'main' })
  })

  it('is case- and separator-insensitive', () => {
    expect(normalizeTag('main-course')).toEqual({ facet: 'course', value: 'main' })
    expect(normalizeTag('  MAIN COURSE ')).toEqual({ facet: 'course', value: 'main' })
  })

  it('maps ingredients to the ingredient facet', () => {
    expect(normalizeTag('Seafood')).toEqual({ facet: 'ingredient', value: 'seafood' })
    expect(normalizeTag('Poultry')).toEqual({ facet: 'ingredient', value: 'chicken' })
  })

  it('maps cooking methods to the method facet', () => {
    expect(normalizeTag('Grill')).toEqual({ facet: 'method', value: 'grill' })
  })

  it('maps cuisines to the cuisine facet', () => {
    expect(normalizeTag('Mediterranean')).toEqual({ facet: 'cuisine', value: 'mediterranean' })
  })

  it('corrects the legacy Sandwhich typo', () => {
    expect(normalizeTag('Sandwhich')).toEqual({ facet: 'tag', value: 'sandwich' })
  })

  it('drops non-food tags from the legacy Notion vocabulary', () => {
    expect(normalizeTag('Docker')).toBeNull()
    expect(normalizeTag('MF DOOM')).toBeNull()
    expect(normalizeTag('ADHD')).toBeNull()
  })

  it('drops Dinner, which carries no information', () => {
    expect(normalizeTag('Dinner')).toBeNull()
  })

  it('returns null for anything unrecognized', () => {
    expect(normalizeTag('asdfqwer')).toBeNull()
  })
})

describe('isValidTag', () => {
  it('accepts a legal facet/value pair', () => {
    expect(isValidTag({ facet: 'course', value: 'main' })).toBe(true)
  })

  it('rejects a value that is not in the vocabulary', () => {
    expect(isValidTag({ facet: 'course', value: 'brunch' })).toBe(false)
  })

  it('accepts any value on the open tag facet', () => {
    expect(isValidTag({ facet: 'tag', value: 'thanksgiving' })).toBe(true)
  })

  it('exposes the course vocabulary', () => {
    expect(COURSE_VALUES).toContain('dessert')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/taxonomy`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Implement the taxonomy**

Create `src/lib/taxonomy/index.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/taxonomy`
Expected: PASS, 12 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/taxonomy
git commit -m "feat: add controlled taxonomy with legacy Notion tag mapping"
```

---

### Task 3: URL normalization and dedupe keys

**Files:**
- Create: `src/lib/url.ts`
- Test: `src/lib/url.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/url.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeSourceUrl } from './url'

describe('normalizeSourceUrl', () => {
  it('strips utm parameters', () => {
    const r = normalizeSourceUrl('https://www.bonappetit.com/recipe/egg-korma?utm_source=pocket&utm_medium=email')
    expect(r.url).toBe('https://bonappetit.com/recipe/egg-korma')
  })

  it('strips fragments and click ids', () => {
    const r = normalizeSourceUrl('https://example.com/r/x?fbclid=abc&gclid=def#jump-to-recipe')
    expect(r.url).toBe('https://example.com/r/x')
  })

  it('keeps meaningful query parameters', () => {
    const r = normalizeSourceUrl('https://example.com/r?id=42&utm_source=x')
    expect(r.url).toBe('https://example.com/r?id=42')
  })

  it('removes a trailing slash but preserves path case', () => {
    const r = normalizeSourceUrl('https://Example.com/Recipes/Flat-Bread/')
    expect(r.url).toBe('https://example.com/Recipes/Flat-Bread')
  })

  it('returns the bare domain without www', () => {
    const r = normalizeSourceUrl('https://www.easyweeknightrecipes.com/homemade-flatbread-recipe/')
    expect(r.domain).toBe('easyweeknightrecipes.com')
  })

  it('upgrades a bare host to https', () => {
    const r = normalizeSourceUrl('example.com/x')
    expect(r.url).toBe('https://example.com/x')
  })

  it('throws on input that is not a URL', () => {
    expect(() => normalizeSourceUrl('not a url at all')).toThrow(/invalid url/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/url`
Expected: FAIL — `Failed to resolve import "./url"`.

- [ ] **Step 3: Implement it**

Create `src/lib/url.ts`:

```ts
const STRIPPED_PARAM_PREFIXES = ['utm_']
const STRIPPED_PARAMS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', '_ga',
])

export type NormalizedUrl = { url: string; domain: string }

/**
 * Produces the canonical form of a source URL, used both for storage and as the
 * dedupe key. Tracking parameters and fragments are removed so the same recipe
 * clipped from two different links resolves to one row.
 */
export function normalizeSourceUrl(input: string): NormalizedUrl {
  const raw = input.trim()
  if (!raw) throw new Error('Invalid URL: empty input')

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`Invalid URL: ${input}`)
  }

  if (!parsed.hostname.includes('.')) throw new Error(`Invalid URL: ${input}`)

  parsed.hash = ''
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')

  for (const name of [...parsed.searchParams.keys()]) {
    const lower = name.toLowerCase()
    if (STRIPPED_PARAMS.has(lower) || STRIPPED_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
      parsed.searchParams.delete(name)
    }
  }

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  }

  const search = parsed.searchParams.toString()
  const url = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${search ? `?${search}` : ''}`

  return { url, domain: parsed.hostname }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/url`
Expected: PASS, 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/url.ts src/lib/url.test.ts
git commit -m "feat: add source URL normalization for storage and dedupe"
```

---

### Task 4: The `ExtractedRecipe` contract and duration parsing

**Files:**
- Create: `src/lib/extract/types.ts`
- Create: `src/lib/extract/duration.ts`
- Test: `src/lib/extract/duration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/extract/duration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseIsoDurationMinutes } from './duration'

describe('parseIsoDurationMinutes', () => {
  it('parses hours and minutes', () => {
    expect(parseIsoDurationMinutes('PT1H30M')).toBe(90)
  })

  it('parses minutes alone', () => {
    expect(parseIsoDurationMinutes('PT45M')).toBe(45)
  })

  it('parses hours alone', () => {
    expect(parseIsoDurationMinutes('PT2H')).toBe(120)
  })

  it('parses days', () => {
    expect(parseIsoDurationMinutes('P1DT2H')).toBe(1560)
  })

  it('rounds seconds up to the nearest minute', () => {
    expect(parseIsoDurationMinutes('PT90S')).toBe(2)
  })

  it('returns null for a zero duration', () => {
    expect(parseIsoDurationMinutes('PT0M')).toBeNull()
  })

  it('returns null for malformed or missing input', () => {
    expect(parseIsoDurationMinutes('45 minutes')).toBeNull()
    expect(parseIsoDurationMinutes('')).toBeNull()
    expect(parseIsoDurationMinutes(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/duration`
Expected: FAIL — `Failed to resolve import "./duration"`.

- [ ] **Step 3: Implement the duration parser**

Create `src/lib/extract/duration.ts`:

```ts
const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i

/**
 * Converts an ISO 8601 duration (schema.org's format for totalTime, prepTime,
 * cookTime) to whole minutes. Returns null for absent, malformed, or zero
 * durations so that "no data" and "zero minutes" are never confused.
 */
export function parseIsoDurationMinutes(value: string | undefined | null): number | null {
  if (!value) return null
  const match = ISO_DURATION.exec(value.trim())
  if (!match) return null

  const [, days, hours, minutes, seconds] = match
  if (!days && !hours && !minutes && !seconds) return null

  const total =
    Number(days ?? 0) * 24 * 60 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Number(seconds ?? 0) / 60

  const rounded = Math.ceil(total)
  return rounded > 0 ? rounded : null
}
```

- [ ] **Step 4: Define the extraction contract**

Create `src/lib/extract/types.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/duration`
Expected: PASS, 7 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/extract
git commit -m "feat: add ExtractedRecipe contract and ISO duration parsing"
```

---

### Task 5: Locate the JSON-LD Recipe node

Recipe plugins bury the Recipe node in different places — a bare object, an array, or inside `@graph`. This task finds it; Task 6 maps it.

**Files:**
- Create: `src/lib/extract/jsonld-find.ts`
- Test: `src/lib/extract/jsonld-find.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/extract/jsonld-find.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { findRecipeNode } from './jsonld-find'

function page(json: string): string {
  return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`
}

describe('findRecipeNode', () => {
  it('finds a bare Recipe object', () => {
    const node = findRecipeNode(page('{"@type":"Recipe","name":"Flatbread"}'))
    expect(node?.name).toBe('Flatbread')
  })

  it('finds a Recipe inside a top-level array', () => {
    const node = findRecipeNode(page('[{"@type":"WebSite"},{"@type":"Recipe","name":"Korma"}]'))
    expect(node?.name).toBe('Korma')
  })

  it('finds a Recipe inside @graph, where WP Recipe Maker puts it', () => {
    const node = findRecipeNode(
      page('{"@context":"https://schema.org","@graph":[{"@type":"Article"},{"@type":"Recipe","name":"Focaccia"}]}'),
    )
    expect(node?.name).toBe('Focaccia')
  })

  it('matches when @type is an array', () => {
    const node = findRecipeNode(page('{"@type":["Recipe","NewsArticle"],"name":"Katsu"}'))
    expect(node?.name).toBe('Katsu')
  })

  it('skips scripts containing invalid JSON and keeps looking', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ not json }</script>
      <script type="application/ld+json">{"@type":"Recipe","name":"Mahi Mahi"}</script>
    </head><body></body></html>`
    expect(findRecipeNode(html)?.name).toBe('Mahi Mahi')
  })

  it('returns null when there is no Recipe node', () => {
    expect(findRecipeNode(page('{"@type":"BlogPosting","name":"Story"}'))).toBeNull()
  })

  it('returns null when there is no JSON-LD at all', () => {
    expect(findRecipeNode('<html><body><h1>Hi</h1></body></html>')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/jsonld-find`
Expected: FAIL — `Failed to resolve import "./jsonld-find"`.

- [ ] **Step 3: Implement the finder**

Create `src/lib/extract/jsonld-find.ts`:

```ts
import { JSDOM } from 'jsdom'

export type JsonLdNode = Record<string, unknown> & { name?: string }

function typesOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return []
  const raw = (node as Record<string, unknown>)['@type']
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string')
  return []
}

/** Yields every object in a JSON-LD document, descending through arrays and @graph. */
function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item)
    return
  }
  if (!value || typeof value !== 'object') return

  const node = value as Record<string, unknown>
  yield node

  if (node['@graph']) yield* walk(node['@graph'])
}

/**
 * Returns the first schema.org Recipe node in the page's JSON-LD, or null.
 * Malformed script blocks are skipped rather than thrown, because a page with
 * one broken block and one good one is common.
 */
export function findRecipeNode(html: string): JsonLdNode | null {
  const { window } = new JSDOM(html)
  const scripts = window.document.querySelectorAll('script[type="application/ld+json"]')

  for (const script of scripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script.textContent ?? '')
    } catch {
      continue
    }

    for (const node of walk(parsed)) {
      if (typesOf(node).includes('Recipe')) return node as JsonLdNode
    }
  }

  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/jsonld-find`
Expected: PASS, 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract/jsonld-find.ts src/lib/extract/jsonld-find.test.ts
git commit -m "feat: locate schema.org Recipe nodes in page JSON-LD"
```

---

### Task 6: Map the JSON-LD node to `PartialRecipe`

**Files:**
- Create: `src/lib/extract/jsonld.ts`
- Test: `src/lib/extract/jsonld.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/extract/jsonld.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fromJsonLd } from './jsonld'
import type { JsonLdNode } from './jsonld-find'

const base: JsonLdNode = {
  '@type': 'Recipe',
  name: 'Homemade Flatbread with Yogurt',
  description: 'Soft, fluffy, tangy flatbread.',
  author: { '@type': 'Person', name: 'Katerina' },
  publisher: { '@type': 'Organization', name: 'Easy Weeknight Recipes' },
  totalTime: 'PT35M',
  recipeYield: '10 flatbreads',
  recipeCategory: 'Bread',
  recipeCuisine: ['Macedonian', 'Mediterranean'],
  keywords: 'flatbread recipe, stovetop',
  image: 'https://example.com/flatbread.jpg',
  recipeIngredient: ['1¼ cups lukewarm water', '¾ cups plain yogurt'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Whisk water, yeast, and sugar.' },
    { '@type': 'HowToStep', text: 'Knead for 4 minutes.' },
  ],
}

describe('fromJsonLd', () => {
  it('maps the core fields', () => {
    const r = fromJsonLd(base)
    expect(r.title).toBe('Homemade Flatbread with Yogurt')
    expect(r.description).toBe('Soft, fluffy, tangy flatbread.')
    expect(r.author).toBe('Katerina')
    expect(r.publisher).toBe('Easy Weeknight Recipes')
    expect(r.claimedTimeMinutes).toBe(35)
    expect(r.extractionMethod).toBe('jsonld')
  })

  it('extracts servings from a yield string and keeps the original text', () => {
    const r = fromJsonLd(base)
    expect(r.servings).toBe(10)
    expect(r.yieldText).toBe('10 flatbreads')
  })

  it('preserves ingredient lines verbatim and numbers them', () => {
    const r = fromJsonLd(base)
    expect(r.ingredients).toHaveLength(2)
    expect(r.ingredients[0]).toEqual({
      position: 0, section: null, rawText: '1¼ cups lukewarm water',
      quantity: null, unit: null, item: null, note: null,
    })
  })

  it('maps HowToStep instructions to steps', () => {
    const r = fromJsonLd(base)
    expect(r.steps.map((s) => s.text)).toEqual([
      'Whisk water, yeast, and sugar.',
      'Knead for 4 minutes.',
    ])
  })

  it('flattens HowToSection instructions and records the section name', () => {
    const r = fromJsonLd({
      ...base,
      recipeInstructions: [
        {
          '@type': 'HowToSection',
          name: 'For the dough',
          itemListElement: [{ '@type': 'HowToStep', text: 'Mix the flour.' }],
        },
        {
          '@type': 'HowToSection',
          name: 'To cook',
          itemListElement: [{ '@type': 'HowToStep', text: 'Fry each round.' }],
        },
      ],
    })
    expect(r.steps).toEqual([
      { position: 0, section: 'For the dough', text: 'Mix the flour.' },
      { position: 1, section: 'To cook', text: 'Fry each round.' },
    ])
  })

  it('splits a plain-string instruction blob into steps', () => {
    const r = fromJsonLd({ ...base, recipeInstructions: 'Mix it all.\nCook it well.' })
    expect(r.steps.map((s) => s.text)).toEqual(['Mix it all.', 'Cook it well.'])
  })

  it('normalizes category, cuisine, and keywords into facet tags', () => {
    const r = fromJsonLd(base)
    expect(r.tags).toContainEqual({ facet: 'course', value: 'bread' })
    expect(r.tags).toContainEqual({ facet: 'cuisine', value: 'mediterranean' })
    expect(r.tags).toContainEqual({ facet: 'method', value: 'stovetop' })
  })

  it('takes the first image from an array and unwraps ImageObject', () => {
    expect(fromJsonLd({ ...base, image: ['https://a.jpg', 'https://b.jpg'] }).heroImageUrl)
      .toBe('https://a.jpg')
    expect(fromJsonLd({ ...base, image: { '@type': 'ImageObject', url: 'https://c.jpg' } }).heroImageUrl)
      .toBe('https://c.jpg')
  })

  it('decodes HTML entities and strips tags from step text', () => {
    const r = fromJsonLd({
      ...base,
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Add <b>flour</b> &amp; salt.' }],
    })
    expect(r.steps[0].text).toBe('Add flour & salt.')
  })

  it('tolerates a node missing everything except a name', () => {
    const r = fromJsonLd({ '@type': 'Recipe', name: 'Bare' })
    expect(r.title).toBe('Bare')
    expect(r.ingredients).toEqual([])
    expect(r.steps).toEqual([])
    expect(r.claimedTimeMinutes).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/jsonld.test`
Expected: FAIL — `Failed to resolve import "./jsonld"`.

- [ ] **Step 3: Implement the mapper**

Create `src/lib/extract/jsonld.ts`:

```ts
import { JSDOM } from 'jsdom'
import { normalizeTags } from '@/lib/taxonomy'
import { parseIsoDurationMinutes } from './duration'
import type { JsonLdNode } from './jsonld-find'
import type { ExtractedIngredient, ExtractedStep, PartialRecipe } from './types'

/** Strips markup and decodes entities from a schema.org text field. */
function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const { window } = new JSDOM(`<div>${value}</div>`)
  return (window.document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return plainText(value) || null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return firstString(obj.name ?? obj.url ?? null)
  }
  return null
}

function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return firstUrl(obj.url ?? obj.contentUrl ?? null)
  }
  return null
}

function toStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (Array.isArray(value)) return value.flatMap(toStringList)
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name
    return typeof name === 'string' ? [name] : []
  }
  return []
}

function parseServings(yieldValue: unknown): number | null {
  const text = Array.isArray(yieldValue) ? String(yieldValue[0] ?? '') : String(yieldValue ?? '')
  const match = /\d+/.exec(text)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

function collectSteps(value: unknown, section: string | null, out: ExtractedStep[]): void {
  if (!value) return

  if (typeof value === 'string') {
    for (const line of plainText(value).split(/\n+|(?<=\.)\s{2,}/)) {
      const text = line.trim()
      if (text) out.push({ position: out.length, section, text })
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectSteps(item, section, out)
    return
  }

  if (typeof value !== 'object') return
  const node = value as Record<string, unknown>
  const type = String(node['@type'] ?? '')

  if (type === 'HowToSection') {
    const name = typeof node.name === 'string' ? plainText(node.name) : null
    collectSteps(node.itemListElement, name || section, out)
    return
  }

  const text = plainText(node.text ?? node.name ?? '')
  if (text) out.push({ position: out.length, section, text })
}

function collectIngredients(value: unknown): ExtractedIngredient[] {
  const lines = Array.isArray(value) ? value : value ? [value] : []
  return lines
    .map((line) => plainText(line))
    .filter(Boolean)
    .map((rawText, position) => ({
      position,
      section: null,
      rawText,
      quantity: null,
      unit: null,
      item: null,
      note: null,
    }))
}

/**
 * Maps a schema.org Recipe node onto our contract. Ingredient lines are stored
 * verbatim; structured quantity/unit/item fields are filled in later by the
 * enrichment pass, never here.
 */
export function fromJsonLd(node: JsonLdNode): PartialRecipe {
  const steps: ExtractedStep[] = []
  collectSteps(node.recipeInstructions, null, steps)

  const rawTags = [
    ...toStringList(node.recipeCategory),
    ...toStringList(node.recipeCuisine),
    ...toStringList(node.keywords),
  ]

  return {
    title: plainText(node.name) || 'Untitled recipe',
    description: firstString(node.description),
    author: firstString(node.author),
    publisher: firstString(node.publisher),
    claimedTimeMinutes:
      parseIsoDurationMinutes(node.totalTime as string | undefined) ??
      sumTimes(node.prepTime, node.cookTime),
    servings: parseServings(node.recipeYield),
    yieldText: firstString(node.recipeYield),
    ingredients: collectIngredients(node.recipeIngredient),
    steps,
    tags: normalizeTags(rawTags),
    heroImageUrl: firstUrl(node.image),
    extractionMethod: 'jsonld',
  }
}

function sumTimes(prep: unknown, cook: unknown): number | null {
  const p = parseIsoDurationMinutes(prep as string | undefined)
  const c = parseIsoDurationMinutes(cook as string | undefined)
  if (p === null && c === null) return null
  return (p ?? 0) + (c ?? 0)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/jsonld.test`
Expected: PASS, 10 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract/jsonld.ts src/lib/extract/jsonld.test.ts
git commit -m "feat: map schema.org Recipe JSON-LD to ExtractedRecipe"
```

---

### Task 7: Separate the narrative from the recipe

**Files:**
- Create: `src/lib/extract/narrative.ts`
- Test: `src/lib/extract/narrative.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/extract/narrative.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractNarrative } from './narrative'

const article = `
  <html><head><title>Flatbread</title></head><body>
    <nav>Home About Contact</nav>
    <article>
      <h1>Homemade Flatbread</h1>
      <p>Flatbread is some serious comfort food for this Macedonian girl. Carbs, carbs, carbs!
         They make everything better, right? Your go-to carb might be a big crusty loaf of French
         bread, but for me, flatbread is where it is at, every single time I get the chance.</p>
      <p>I love to make my own flatbread because it is quick and easy, and it is easier than most
         breads because you do not need to let it rise for very long at all before cooking.</p>
      <div class="wprm-recipe-container">
        <h2>Easy Homemade Flatbread Recipe</h2>
        <ul><li>1 cup water</li><li>3 cups flour</li></ul>
      </div>
    </article>
    <footer>Copyright 2022</footer>
  </body></html>
`

describe('extractNarrative', () => {
  it('returns the article prose', () => {
    const html = extractNarrative(article)
    expect(html).toContain('Macedonian girl')
  })

  it('removes the recipe card so the story is not duplicated', () => {
    const html = extractNarrative(article)
    expect(html).not.toContain('3 cups flour')
  })

  it('drops navigation and footer chrome', () => {
    const html = extractNarrative(article)
    expect(html).not.toContain('Home About Contact')
    expect(html).not.toContain('Copyright 2022')
  })

  it('returns null when there is no meaningful prose', () => {
    expect(extractNarrative('<html><body><div>Hi</div></body></html>')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/narrative`
Expected: FAIL — `Failed to resolve import "./narrative"`.

- [ ] **Step 3: Implement it**

Create `src/lib/extract/narrative.ts`:

```ts
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

/** Selectors used by the common recipe-card plugins. */
const RECIPE_CARD_SELECTORS = [
  '.wprm-recipe-container',
  '.tasty-recipes',
  '.mv-create-wrapper',
  '.easyrecipe',
  '[itemtype*="schema.org/Recipe"]',
  '.recipe-card',
  '#recipe',
]

const MIN_NARRATIVE_LENGTH = 200

/**
 * Returns the article prose with the recipe card removed, or null when the page
 * has no narrative worth keeping. The recipe itself is extracted separately, so
 * leaving the card in would duplicate it.
 */
export function extractNarrative(html: string): string | null {
  const dom = new JSDOM(html, { url: 'https://example.com/' })
  const { document } = dom.window

  for (const selector of RECIPE_CARD_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) el.remove()
  }

  const article = new Readability(document).parse()
  const content = article?.content?.trim()
  if (!content) return null

  const textLength = (article?.textContent ?? '').replace(/\s+/g, ' ').trim().length
  return textLength >= MIN_NARRATIVE_LENGTH ? content : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/narrative`
Expected: PASS, 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract/narrative.ts src/lib/extract/narrative.test.ts
git commit -m "feat: separate article narrative from the recipe card"
```

---

### Task 8: The LLM client interface and enrichment

The client is an interface so `extract()` stays pure and no test ever calls Claude.

**Files:**
- Create: `src/lib/extract/llm-types.ts`
- Create: `src/lib/extract/enrich.ts`
- Test: `src/lib/extract/enrich.test.ts`

- [ ] **Step 1: Define the interface and response schema**

Create `src/lib/extract/llm-types.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/extract/enrich.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { applyEnrichment } from './enrich'
import type { LlmClient } from './llm-types'
import type { PartialRecipe } from './types'

const recipe: PartialRecipe = {
  title: 'Flatbread',
  description: null,
  author: null,
  publisher: null,
  claimedTimeMinutes: 35,
  servings: 10,
  yieldText: '10 flatbreads',
  ingredients: [
    { position: 0, section: null, rawText: '1 1/2 cups all-purpose flour, sifted', quantity: null, unit: null, item: null, note: null },
  ],
  steps: [{ position: 0, section: null, text: 'Mix.' }],
  tags: [],
  heroImageUrl: null,
  extractionMethod: 'jsonld',
}

function client(response: unknown): LlmClient {
  return {
    enrich: vi.fn().mockResolvedValue(response),
    extractRecipe: vi.fn(),
  }
}

describe('applyEnrichment', () => {
  it('fills in structured ingredient fields while preserving rawText', async () => {
    const result = await applyEnrichment(recipe, client({
      description: 'Soft stovetop flatbread.',
      tags: [{ facet: 'course', value: 'bread' }],
      ingredients: [{ position: 0, quantity: 1.5, unit: 'cup', item: 'all-purpose flour', note: 'sifted' }],
    }))

    expect(result.ingredients[0].rawText).toBe('1 1/2 cups all-purpose flour, sifted')
    expect(result.ingredients[0].quantity).toBe(1.5)
    expect(result.ingredients[0].unit).toBe('cup')
    expect(result.ingredients[0].item).toBe('all-purpose flour')
    expect(result.ingredients[0].note).toBe('sifted')
  })

  it('adds a description only when one is missing', async () => {
    const withDescription = { ...recipe, description: 'Original.' }
    const result = await applyEnrichment(withDescription, client({
      description: 'Replacement.', tags: [], ingredients: [],
    }))
    expect(result.description).toBe('Original.')
  })

  it('drops tags that are not in the vocabulary', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null,
      tags: [
        { facet: 'course', value: 'bread' },
        { facet: 'course', value: 'brunch-thing' },
        { facet: 'nonsense', value: 'x' },
      ],
      ingredients: [],
    }))
    expect(result.tags).toEqual([{ facet: 'course', value: 'bread' }])
  })

  it('does not duplicate tags already present', async () => {
    const tagged = { ...recipe, tags: [{ facet: 'course' as const, value: 'bread' }] }
    const result = await applyEnrichment(tagged, client({
      description: null, tags: [{ facet: 'course', value: 'bread' }], ingredients: [],
    }))
    expect(result.tags).toHaveLength(1)
  })

  it('returns the recipe unchanged when the response fails validation', async () => {
    const result = await applyEnrichment(recipe, client({ garbage: true }))
    expect(result).toEqual(recipe)
  })

  it('returns the recipe unchanged when the call throws', async () => {
    const failing: LlmClient = {
      enrich: vi.fn().mockRejectedValue(new Error('rate limited')),
      extractRecipe: vi.fn(),
    }
    const result = await applyEnrichment(recipe, failing)
    expect(result).toEqual(recipe)
  })

  it('ignores ingredient entries pointing at positions that do not exist', async () => {
    const result = await applyEnrichment(recipe, client({
      description: null, tags: [],
      ingredients: [{ position: 99, quantity: 2, unit: 'cup', item: 'flour', note: null }],
    }))
    expect(result.ingredients[0].quantity).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/enrich`
Expected: FAIL — `Failed to resolve import "./enrich"`.

- [ ] **Step 4: Implement enrichment**

Create `src/lib/extract/enrich.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/enrich`
Expected: PASS, 7 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/extract/llm-types.ts src/lib/extract/enrich.ts src/lib/extract/enrich.test.ts
git commit -m "feat: add LLM enrichment with strict vocabulary validation"
```

---

### Task 9: The real Anthropic client

**Files:**
- Create: `src/lib/extract/anthropic-client.ts`
- Create: `.env.example`

- [ ] **Step 1: Implement the client**

Create `src/lib/extract/anthropic-client.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { COURSE_VALUES, CUISINE_VALUES, INGREDIENT_VALUES, METHOD_VALUES } from '@/lib/taxonomy'
import type { LlmClient } from './llm-types'

const MODEL = 'claude-sonnet-5'

const ENRICH_TOOL: Anthropic.Tool = {
  name: 'emit_enrichment',
  description: 'Return normalized tags, parsed ingredients, and a one-line description.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: ['string', 'null'],
        description: 'One sentence, max 140 characters, describing the dish.',
      },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            facet: { type: 'string', enum: ['course', 'ingredient', 'method', 'cuisine', 'tag'] },
            value: { type: 'string' },
          },
          required: ['facet', 'value'],
        },
      },
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            position: { type: 'integer' },
            quantity: { type: ['number', 'null'] },
            unit: { type: ['string', 'null'] },
            item: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
          },
          required: ['position', 'quantity', 'unit', 'item', 'note'],
        },
      },
    },
    required: ['description', 'tags', 'ingredients'],
  },
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'emit_recipe',
  description: 'Return the recipe found in the page text.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      author: { type: ['string', 'null'] },
      claimedTimeMinutes: { type: ['integer', 'null'] },
      servings: { type: ['integer', 'null'] },
      yieldText: { type: ['string', 'null'] },
      ingredients: { type: 'array', items: { type: 'string' } },
      steps: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'title', 'description', 'author', 'claimedTimeMinutes',
      'servings', 'yieldText', 'ingredients', 'steps',
    ],
  },
}

function vocabularyPrompt(): string {
  return [
    `course: ${COURSE_VALUES.join(', ')}`,
    `ingredient: ${INGREDIENT_VALUES.join(', ')}`,
    `method: ${METHOD_VALUES.join(', ')}`,
    `cuisine: ${CUISINE_VALUES.join(', ')}`,
    'tag: any short lowercase slug for dish types or occasions',
  ].join('\n')
}

async function callTool(
  client: Anthropic,
  tool: Anthropic.Tool,
  prompt: string,
): Promise<unknown> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: prompt }],
  })

  const block = response.content.find((b) => b.type === 'tool_use')
  return block && block.type === 'tool_use' ? block.input : null
}

export function createAnthropicClient(apiKey = process.env.ANTHROPIC_API_KEY): LlmClient {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  const client = new Anthropic({ apiKey })

  return {
    async enrich({ title, ingredientLines, rawTags }) {
      const prompt = [
        `Recipe: ${title}`,
        '',
        'Ingredient lines (use the given index as "position"):',
        ...ingredientLines.map((line, i) => `${i}: ${line}`),
        '',
        `Tags already assigned: ${rawTags.join(', ') || '(none)'}`,
        '',
        'Assign tags using ONLY these facet values:',
        vocabularyPrompt(),
        '',
        'Rules:',
        '- Assign at most one course.',
        '- Omit a facet entirely rather than guessing.',
        '- Parse each ingredient line into quantity (decimal, e.g. 1.5), unit',
        '  (singular: cup, tablespoon, gram, ounce, clove), item, and note',
        '  (preparation such as "sifted" or "finely chopped").',
        '- Use null for any field the line does not specify.',
      ].join('\n')

      return callTool(client, ENRICH_TOOL, prompt)
    },

    async extractRecipe({ url, text }) {
      const prompt = [
        `Extract the recipe from this page. Source: ${url}`,
        '',
        'Return ingredient lines and steps verbatim as written. Do not rewrite,',
        'summarize, renumber, or merge them. Exclude narrative prose, ads, and',
        'commentary. If the page contains no recipe, return an empty title.',
        '',
        '--- PAGE TEXT ---',
        text.slice(0, 60_000),
      ].join('\n')

      return callTool(client, EXTRACT_TOOL, prompt)
    },
  }
}
```

- [ ] **Step 2: Document the environment variable**

Create `.env.example`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 3: Verify the project still typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/extract/anthropic-client.ts .env.example
git commit -m "feat: add Anthropic client for extraction and enrichment"
```

---

### Task 10: Orchestrate `extract()`

**Files:**
- Create: `src/lib/extract/index.ts`
- Test: `src/lib/extract/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/extract/index.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { extract } from './index'
import type { LlmClient } from './llm-types'

const noopLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

const jsonLdPage = `<html><head><script type="application/ld+json">
  {"@type":"Recipe","name":"Egg Korma","recipeIngredient":["2 eggs"],
   "recipeInstructions":[{"@type":"HowToStep","text":"Boil the eggs."}],
   "totalTime":"PT50M","recipeCategory":"Main Course"}
</script></head><body>
  <article><p>${'A long story about eggs that goes on for a while. '.repeat(12)}</p></article>
</body></html>`

describe('extract', () => {
  it('uses JSON-LD when present', async () => {
    const result = await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm: noopLlm })
    expect(result.title).toBe('Egg Korma')
    expect(result.extractionMethod).toBe('jsonld')
    expect(result.claimedTimeMinutes).toBe(50)
  })

  it('attaches the narrative separately from the recipe', async () => {
    const result = await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm: noopLlm })
    expect(result.narrativeHtml).toContain('A long story about eggs')
    expect(result.steps[0].text).toBe('Boil the eggs.')
  })

  it('falls back to the LLM when there is no structured data', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue(null),
      extractRecipe: vi.fn().mockResolvedValue({
        title: 'Grandma Peanut Dip',
        description: null,
        author: null,
        claimedTimeMinutes: 10,
        servings: 4,
        yieldText: '4 servings',
        ingredients: ['1 cup peanuts'],
        steps: ['Blend everything.'],
      }),
    }

    const result = await extract({
      url: 'https://example.com/dip',
      html: '<html><body><article><p>No structured data here at all.</p></article></body></html>',
      llm,
    })

    expect(result.title).toBe('Grandma Peanut Dip')
    expect(result.extractionMethod).toBe('llm')
    expect(result.ingredients[0].rawText).toBe('1 cup peanuts')
    expect(llm.extractRecipe).toHaveBeenCalledOnce()
  })

  it('throws a NoRecipeFoundError when neither path finds a recipe', async () => {
    await expect(
      extract({ url: 'https://example.com/x', html: '<html><body>nothing</body></html>', llm: noopLlm }),
    ).rejects.toThrow(/no recipe found/i)
  })

  it('never calls the LLM extractor when JSON-LD succeeds', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue(null),
      extractRecipe: vi.fn(),
    }
    await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm })
    expect(llm.extractRecipe).not.toHaveBeenCalled()
  })

  it('runs enrichment on the JSON-LD path', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue({
        description: 'A rich egg curry.',
        tags: [{ facet: 'cuisine', value: 'indian' }],
        ingredients: [{ position: 0, quantity: 2, unit: null, item: 'eggs', note: null }],
      }),
      extractRecipe: vi.fn(),
    }

    const result = await extract({ url: 'https://example.com/korma', html: jsonLdPage, llm })
    expect(result.description).toBe('A rich egg curry.')
    expect(result.tags).toContainEqual({ facet: 'cuisine', value: 'indian' })
    expect(result.ingredients[0].quantity).toBe(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/index.test`
Expected: FAIL — `extract is not a function` or an unresolved import.

- [ ] **Step 3: Implement the orchestrator**

Create `src/lib/extract/index.ts`:

```ts
import { JSDOM } from 'jsdom'
import { applyEnrichment } from './enrich'
import { fromJsonLd } from './jsonld'
import { findRecipeNode } from './jsonld-find'
import { llmRecipeSchema, type LlmClient } from './llm-types'
import { extractNarrative } from './narrative'
import type { ExtractedRecipe, PartialRecipe } from './types'

export class NoRecipeFoundError extends Error {
  constructor(url: string) {
    super(`No recipe found at ${url}`)
    this.name = 'NoRecipeFoundError'
  }
}

export type ExtractInput = {
  url: string
  html: string
  llm: LlmClient
}

function pageText(html: string): string {
  const { window } = new JSDOM(html)
  for (const el of window.document.querySelectorAll('script, style, nav, footer')) el.remove()
  return (window.document.body?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function fromLlm(url: string, html: string, llm: LlmClient): Promise<PartialRecipe | null> {
  let raw: unknown
  try {
    raw = await llm.extractRecipe({ url, text: pageText(html) })
  } catch {
    return null
  }

  const parsed = llmRecipeSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.title.trim()) return null

  const data = parsed.data
  return {
    title: data.title.trim(),
    description: data.description,
    author: data.author,
    publisher: null,
    claimedTimeMinutes: data.claimedTimeMinutes,
    servings: data.servings,
    yieldText: data.yieldText,
    ingredients: data.ingredients.map((rawText, position) => ({
      position, section: null, rawText, quantity: null, unit: null, item: null, note: null,
    })),
    steps: data.steps.map((text, position) => ({ position, section: null, text })),
    tags: [],
    heroImageUrl: null,
    extractionMethod: 'llm',
  }
}

/**
 * Turns a fetched page into a validated recipe. Pure: no network, no database,
 * no clock. The LLM is injected, so tests drive every path without a live call.
 *
 * Order matters — structured data is authoritative and free, so the LLM is only
 * asked to extract when JSON-LD is absent.
 */
export async function extract({ url, html, llm }: ExtractInput): Promise<ExtractedRecipe> {
  const node = findRecipeNode(html)
  const base = node ? fromJsonLd(node) : await fromLlm(url, html, llm)

  if (!base) throw new NoRecipeFoundError(url)

  const enriched = await applyEnrichment(base, llm)

  return { ...enriched, narrativeHtml: extractNarrative(html) }
}

export type { ExtractedRecipe } from './types'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/index.test`
Expected: PASS, 6 tests passed.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/extract/index.ts src/lib/extract/index.test.ts
git commit -m "feat: orchestrate extraction with structured-first, LLM fallback"
```

---

### Task 11: The fetch module

**Files:**
- Create: `src/lib/fetch/index.ts`
- Test: `src/lib/fetch/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/fetch/index.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchPage, BlockedError, FetchFailedError } from './index'

afterEach(() => { vi.unstubAllGlobals() })

function stub(response: Partial<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, url: 'https://example.com/r',
    text: async () => '<html></html>',
    ...response,
  }))
}

describe('fetchPage', () => {
  it('returns the html and the final url after redirects', async () => {
    stub({ url: 'https://example.com/final', text: async () => '<html>hi</html>' })
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html>hi</html>')
    expect(result.finalUrl).toBe('https://example.com/final')
  })

  it('sends a browser user agent so blogs do not serve a bot page', async () => {
    stub({})
    await fetchPage('https://example.com/r')
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.headers['User-Agent']).toMatch(/Mozilla/)
  })

  it('throws BlockedError on 403', async () => {
    stub({ ok: false, status: 403 })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(BlockedError)
  })

  it('throws BlockedError on 401 and 429', async () => {
    stub({ ok: false, status: 429 })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(BlockedError)
  })

  it('throws FetchFailedError on other error statuses', async () => {
    stub({ ok: false, status: 500 })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('throws FetchFailedError when the network call rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/fetch`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Implement it**

Create `src/lib/fetch/index.ts`:

```ts
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const TIMEOUT_MS = 20_000

/** The site refused us — typically a datacenter-IP block. Retry from the phone. */
export class BlockedError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`Blocked by ${url} (HTTP ${status})`)
    this.name = 'BlockedError'
  }
}

export class FetchFailedError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`Failed to fetch ${url}: ${reason}`)
    this.name = 'FetchFailedError'
  }
}

export type FetchedPage = { html: string; finalUrl: string; status: number }

const BLOCKED_STATUSES = new Set([401, 403, 429, 451])

/**
 * The only place in the codebase that talks to the open internet. Distinguishes
 * "they blocked us" from "it broke", because the two have different fixes: a
 * block routes the import to the phone-supplied fallback, a failure retries.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
  } catch (error) {
    throw new FetchFailedError(url, error instanceof Error ? error.message : 'unknown error')
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    if (BLOCKED_STATUSES.has(response.status)) throw new BlockedError(url, response.status)
    throw new FetchFailedError(url, `HTTP ${response.status}`)
  }

  return {
    html: await response.text(),
    finalUrl: response.url || url,
    status: response.status,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/fetch`
Expected: PASS, 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fetch
git commit -m "feat: add fetch module distinguishing blocks from failures"
```

---

### Task 12: The CLI harness and real-world verification

This proves the pipeline against live sites and produces the first real fixtures.

**Files:**
- Create: `scripts/extract-url.ts`
- Create: `src/lib/extract/fixtures/.gitkeep`
- Modify: `package.json` (add the `extract` script)

- [ ] **Step 1: Write the CLI**

Create `scripts/extract-url.ts`:

```ts
#!/usr/bin/env tsx
import { writeFileSync } from 'node:fs'
import { createAnthropicClient } from '../src/lib/extract/anthropic-client'
import { extract } from '../src/lib/extract'
import { fetchPage } from '../src/lib/fetch'
import { normalizeSourceUrl } from '../src/lib/url'

async function main() {
  const input = process.argv[2]
  const saveTo = process.argv[3]

  if (!input) {
    console.error('Usage: npm run extract -- <url> [save-html-path]')
    process.exit(1)
  }

  const { url, domain } = normalizeSourceUrl(input)
  console.error(`Fetching ${url} (${domain})…`)

  const page = await fetchPage(url)
  if (saveTo) {
    writeFileSync(saveTo, page.html)
    console.error(`Saved HTML to ${saveTo}`)
  }

  const recipe = await extract({ url, html: page.html, llm: createAnthropicClient() })

  console.log(JSON.stringify({
    ...recipe,
    narrativeHtml: recipe.narrativeHtml ? `<${recipe.narrativeHtml.length} chars>` : null,
  }, null, 2))
}

main().catch((error) => {
  console.error(`\n${error.name}: ${error.message}`)
  process.exit(1)
})
```

- [ ] **Step 2: Add the script and the fixtures directory**

In `package.json`, add to `"scripts"`:

```json
"extract": "tsx scripts/extract-url.ts"
```

```bash
mkdir -p src/lib/extract/fixtures && touch src/lib/extract/fixtures/.gitkeep
```

- [ ] **Step 3: Set the API key**

```bash
cp .env.example .env.local
```

Edit `.env.local` and set a real `ANTHROPIC_API_KEY`. Then export it for the CLI:

```bash
export ANTHROPIC_API_KEY="$(grep ANTHROPIC_API_KEY .env.local | cut -d= -f2-)"
```

- [ ] **Step 4: Verify against a site with clean JSON-LD**

```bash
npm run extract -- "https://www.easyweeknightrecipes.com/homemade-flatbread-recipe/" src/lib/extract/fixtures/easyweeknight-flatbread.html
```

Expected: JSON with `"extractionMethod": "jsonld"`, a non-empty `ingredients` array where each `rawText` matches the site, `claimedTimeMinutes` as a number, and `narrativeHtml` reported as a character count rather than null.

- [ ] **Step 5: Verify against Bon Appétit — the known risk**

```bash
npm run extract -- "https://www.bonappetit.com/recipe/egg-korma" src/lib/extract/fixtures/bonappetit-egg-korma.html
```

Two acceptable outcomes, both of which are information:

- **Success** — record it. The datacenter-block concern from the spec is smaller than feared.
- **`BlockedError: Blocked by … (HTTP 403)`** — this confirms the spec's central risk. Record the status code; plan 2's import API needs the phone-supplied HTML path, and it is the highest-priority item there.

Write the result into the plan-2 notes either way. Do not attempt to work around a block.

- [ ] **Step 6: Turn any captured page into a regression test**

For each HTML file saved above, create a test named after it. Using the flatbread fixture as the example, create `src/lib/extract/fixtures.test.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { extract } from './index'
import type { LlmClient } from './llm-types'

const noopLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

const here = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name: string) => join(here, 'fixtures', name)

describe('real-world fixtures', () => {
  const flatbread = fixture('easyweeknight-flatbread.html')

  it.runIf(existsSync(flatbread))('extracts the flatbread recipe from saved HTML', async () => {
    const html = readFileSync(flatbread, 'utf8')
    const recipe = await extract({
      url: 'https://easyweeknightrecipes.com/homemade-flatbread-recipe',
      html,
      llm: noopLlm,
    })

    expect(recipe.extractionMethod).toBe('jsonld')
    expect(recipe.title).toMatch(/flatbread/i)
    expect(recipe.ingredients.length).toBeGreaterThan(3)
    expect(recipe.steps.length).toBeGreaterThan(2)
    expect(recipe.claimedTimeMinutes).toBeGreaterThan(0)
    expect(recipe.narrativeHtml).not.toBeNull()
  })
})
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, all tests green including the fixture test.

- [ ] **Step 8: Commit**

```bash
git add scripts/extract-url.ts package.json src/lib/extract/fixtures src/lib/extract/fixtures.test.ts
git commit -m "feat: add extraction CLI and real-world fixture tests"
```

---

### Task 13: Microdata fallback

The spec's extraction chain is JSON-LD → microdata/RDFa → LLM. Older blogs and
some legacy recipe plugins still mark recipes up with `itemprop` attributes
instead of JSON-LD. This slots between the two paths already built.

**Files:**
- Create: `src/lib/extract/microdata.ts`
- Test: `src/lib/extract/microdata.test.ts`
- Modify: `src/lib/extract/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/extract/microdata.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fromMicrodata } from './microdata'

const page = `<html><body>
  <div itemscope itemtype="http://schema.org/Recipe">
    <h1 itemprop="name">Kansas City Barbecue Sauce</h1>
    <span itemprop="author">Elise Bauer</span>
    <meta itemprop="totalTime" content="PT40M">
    <span itemprop="recipeYield">2 cups</span>
    <span itemprop="recipeCategory">Sauce</span>
    <img itemprop="image" src="https://example.com/sauce.jpg">
    <li itemprop="recipeIngredient">2 cups ketchup</li>
    <li itemprop="recipeIngredient">1/4 cup brown sugar</li>
    <li itemprop="recipeInstructions">Simmer everything for 30 minutes.</li>
  </div>
</body></html>`

describe('fromMicrodata', () => {
  it('maps the core fields', () => {
    const r = fromMicrodata(page)
    expect(r?.title).toBe('Kansas City Barbecue Sauce')
    expect(r?.author).toBe('Elise Bauer')
    expect(r?.claimedTimeMinutes).toBe(40)
    expect(r?.yieldText).toBe('2 cups')
    expect(r?.extractionMethod).toBe('microdata')
  })

  it('reads meta content attributes rather than their empty text', () => {
    expect(fromMicrodata(page)?.claimedTimeMinutes).toBe(40)
  })

  it('reads the src attribute for images', () => {
    expect(fromMicrodata(page)?.heroImageUrl).toBe('https://example.com/sauce.jpg')
  })

  it('collects ingredients and steps in document order', () => {
    const r = fromMicrodata(page)
    expect(r?.ingredients.map((i) => i.rawText)).toEqual(['2 cups ketchup', '1/4 cup brown sugar'])
    expect(r?.steps.map((s) => s.text)).toEqual(['Simmer everything for 30 minutes.'])
  })

  it('normalizes the category into a facet tag', () => {
    expect(fromMicrodata(page)?.tags).toContainEqual({ facet: 'course', value: 'sauce' })
  })

  it('returns null when there is no Recipe itemscope', () => {
    expect(fromMicrodata('<html><body><p>nothing</p></body></html>')).toBeNull()
  })

  it('returns null when the itemscope has no name', () => {
    const nameless = '<div itemscope itemtype="http://schema.org/Recipe"><p>x</p></div>'
    expect(fromMicrodata(nameless)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/extract/microdata`
Expected: FAIL — `Failed to resolve import "./microdata"`.

- [ ] **Step 3: Implement it**

Create `src/lib/extract/microdata.ts`:

```ts
import { JSDOM } from 'jsdom'
import { normalizeTags } from '@/lib/taxonomy'
import { parseIsoDurationMinutes } from './duration'
import type { PartialRecipe } from './types'

/** Microdata puts values in content/src/href attributes as often as in text. */
function valueOf(el: Element): string {
  const attr =
    el.getAttribute('content') ??
    el.getAttribute('src') ??
    el.getAttribute('datetime') ??
    (el.tagName === 'A' ? el.getAttribute('href') : null)
  if (attr) return attr.trim()
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function all(scope: Element, prop: string): string[] {
  return [...scope.querySelectorAll(`[itemprop="${prop}"]`)].map(valueOf).filter(Boolean)
}

function one(scope: Element, prop: string): string | null {
  return all(scope, prop)[0] ?? null
}

/**
 * Extracts a recipe marked up with schema.org microdata. Returns null when the
 * page has no Recipe itemscope or the itemscope carries no name, so the caller
 * can fall through to the LLM path.
 */
export function fromMicrodata(html: string): PartialRecipe | null {
  const { window } = new JSDOM(html)
  const scope = window.document.querySelector('[itemscope][itemtype*="schema.org/Recipe"]')
  if (!scope) return null

  const title = one(scope, 'name')
  if (!title) return null

  const yieldText = one(scope, 'recipeYield')
  const servingsMatch = yieldText ? /\d+/.exec(yieldText) : null

  return {
    title,
    description: one(scope, 'description'),
    author: one(scope, 'author'),
    publisher: one(scope, 'publisher'),
    claimedTimeMinutes: parseIsoDurationMinutes(one(scope, 'totalTime')),
    servings: servingsMatch ? Number(servingsMatch[0]) : null,
    yieldText,
    ingredients: all(scope, 'recipeIngredient').map((rawText, position) => ({
      position, section: null, rawText, quantity: null, unit: null, item: null, note: null,
    })),
    steps: all(scope, 'recipeInstructions').map((text, position) => ({
      position, section: null, text,
    })),
    tags: normalizeTags([
      ...all(scope, 'recipeCategory'),
      ...all(scope, 'recipeCuisine'),
      ...all(scope, 'keywords'),
    ]),
    heroImageUrl: one(scope, 'image'),
    extractionMethod: 'microdata',
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/extract/microdata`
Expected: PASS, 7 tests passed.

- [ ] **Step 5: Wire microdata into the chain**

In `src/lib/extract/index.ts`, add the import alongside the others:

```ts
import { fromMicrodata } from './microdata'
```

Then replace the `base` assignment inside `extract()`:

```ts
  const node = findRecipeNode(html)
  const base =
    (node ? fromJsonLd(node) : null) ??
    fromMicrodata(html) ??
    (await fromLlm(url, html, llm))
```

- [ ] **Step 6: Add a chain-order test**

Append to `src/lib/extract/index.test.ts`, inside the existing `describe('extract')` block:

```ts
  it('uses microdata when JSON-LD is absent, without calling the LLM', async () => {
    const llm: LlmClient = {
      enrich: vi.fn().mockResolvedValue(null),
      extractRecipe: vi.fn(),
    }
    const html = `<html><body>
      <div itemscope itemtype="http://schema.org/Recipe">
        <h1 itemprop="name">KC Barbecue Sauce</h1>
        <li itemprop="recipeIngredient">2 cups ketchup</li>
      </div></body></html>`

    const result = await extract({ url: 'https://example.com/sauce', html, llm })
    expect(result.extractionMethod).toBe('microdata')
    expect(llm.extractRecipe).not.toHaveBeenCalled()
  })
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/extract/microdata.ts src/lib/extract/microdata.test.ts src/lib/extract/index.ts src/lib/extract/index.test.ts
git commit -m "feat: add microdata fallback to the extraction chain"
```

---

## Definition of done

- `npm test` passes with all suites green.
- `npx tsc --noEmit` reports no errors.
- `npm run extract -- <url>` prints a valid `ExtractedRecipe` for a JSON-LD site.
- The extraction chain runs JSON-LD → microdata → LLM, and each earlier path
  short-circuits the later ones.
- The Bon Appétit result is recorded — success or a specific HTTP status.
- No module in `src/lib/extract` imports from `src/lib/fetch`, and no test makes a
  live Anthropic call.

## Handoff to plan 2

Plan 2 (persistence and the import API) needs from this work:

- The `ExtractedRecipe` contract, which the Drizzle schema mirrors.
- The `BlockedError` / `FetchFailedError` distinction, which determines whether a
  failed import goes to the needs-attention tray or is retried.
- **The blocking picture, measured 2026-08-25 against real library URLs.** The
  spec's central assumption was wrong in both directions:

  | Publisher | Result | Library share |
  | --- | --- | --- |
  | Bon Appétit (3 URLs) | **200, clean JSON-LD** | 44 recipes (28%) |
  | Café Delites | 200, clean JSON-LD | 8 |
  | Easy Weeknight Recipes | 200, clean JSON-LD | 1 |
  | Allrecipes (2 URLs) | **403 → `BlockedError`** | 4 |
  | Simply Recipes | **403 → `BlockedError`** | 2 |

  Bon Appétit — the publisher the spec called the biggest risk — fetches and
  parses fine. Allrecipes and Simply Recipes block instead, and they block a
  *residential* IP with a browser user agent, so they are fingerprinting more
  than datacenter ranges; the phone-supplied-HTML fallback may not rescue them
  either, and a headless browser may be required.

  **This was measured from the user's home machine, not from Vercel.** Condé
  Nast blocks datacenter IPs specifically, so the Bon Appétit result does not
  prove a deployed function can fetch it. Settle that with one request from a
  deployed function early in plan 2 — it is cheap and it decides whether the
  phone-supplied-HTML path is a first-class feature or a rarely-used fallback.

- **Notion `Link` values are not all bare URLs.** At least two rows store the
  link as markdown (`[https://…](https://…)`). The migration must unwrap that
  before calling `normalizeSourceUrl`, or those recipes fail to import.

- **`narrativeHtml` requires attribute-level sanitization at the render layer.**
  Measured during Task 7: Readability strips `<script>` and `<style>` tags, but
  inline event handlers survive intact — `<p onclick="...">` and
  `<img onerror="...">` both pass through unchanged. Since this HTML is stored
  and later rendered into the recipe page, tag-stripping alone is not sufficient.
  Sanitize on render, not on extract: doing it in both places would invite the
  render layer to trust input it should not.

- **Ingredient `rawText` and step text are untrusted third-party strings.** A
  `<script>` element's text content survives into them as plain text. Render as
  text, never via `dangerouslySetInnerHTML`.

- **Serverless memory sizing.** JSDOM amplifies HTML roughly 300× in memory
  (1 MB HTML → ~559 MB RSS). The fetch cap is set to 3 MB accordingly. If plan 2
  processes imports in a background function, give it headroom and do not run
  extractions concurrently in one instance.

- **`narrativeHtml` requires attribute-level sanitization at the render layer.**
  Measured during Task 7: Readability strips `<script>` and `<style>` tags, but
  inline event handlers survive intact — `<p onclick="...">` and
  `<img onerror="...">` both pass through unchanged. Since this HTML is stored
  and later rendered into the recipe page, tag-stripping alone is not sufficient.
  Sanitize on render, not on extract: doing it in both places would invite the
  render layer to trust input it should not.
