# Recipe Manager: Notion Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 156 recipes out of the shared Notion database and into the app, losing nothing — including the ones whose source URLs have died.

**Architecture:** The migration reuses the existing import pipeline rather than reimplementing it: each Notion row becomes a job, runs through `runImport`, and then has its Notion-only metadata (rating, cooking status, original date, tags) applied on top. Where the source URL is dead or blocked, the Notion page body becomes the recipe instead. A dry run answers "what will happen" without writing anything or spending a cent.

**Tech Stack:** `@notionhq/client`, the existing `src/lib/import` / `src/lib/extract` / `src/lib/db`, Vitest.

**Source spec:** `docs/superpowers/specs/2026-08-25-recipe-manager-design.md`
**Predecessors:** `docs/superpowers/plans/2026-08-25-foundation-and-extraction.md` and `docs/superpowers/plans/2026-08-25-persistence-and-import.md`. Read the "Findings during execution", "Decisions made during execution", and "Handoff" sections of both before starting — several tasks here exist because of them.

**Scope note:** Plan 3 of 4. This plan was split from the UI work and deliberately sequenced first: building a filter rail against an empty database is guesswork, and 156 real recipes reveal the actual facet distribution, the real image coverage, and which publishers fail. Plan 4 builds the library grid, recipe page, and needs-attention screens against migrated data.

---

## Measured facts about the source data

All confirmed against the live database on 2026-08-25. These drive the design; do not assume the older numbers in earlier plans.

| Fact | Value |
| --- | --- |
| Recipes (`Type = Recipe`) | 156 |
| Date range | 2019-11-09 → 2026-08-23 |
| **Links stored as markdown** `[url](url)` | **59 (38%)** |
| Recipes with no link at all | 4 |
| **Recipes with `Added By` set** | **0 — the property is empty on every row** |
| Rated | 74 |
| Untagged | 20 |
| Cooking Status | 76 Made It, 69 Want to Make, 11 blank |
| Bon Appétit | 44 (28%) |

Known-dead and known-blocking sources found by spot check:

- `getpocket.com/explore/item/...` → **403**. Pocket shut down; the Notion page body is the only surviving copy of that recipe.
- `allrecipes.com`, `simplyrecipes.com` → **403** even from a residential IP with a browser user agent.
- `bonappetit.com`, `food.com`, `cafedelites.com`, `butterwithasideofbread.com` → 200 with clean JSON-LD.

**Implication:** over seven years of saving, some fraction of these URLs are dead. The Notion body fallback is a primary path, not an edge case for four rows. The dry run in Task 6 measures exactly how large that fraction is.

### One deliberate deviation from the spec

The spec says the migration "pulls every recipe's Notion page body too, not just
the URL, and stashes it as fallback content." **This plan fetches bodies lazily,
only for rows whose import fails.**

The spec's reasoning was that nothing should be lost even in the worst case. That
still holds, by a cheaper route: the Notion database is not being deleted — it
stays as the backup of record (Task 9) — so eagerly copying 156 page bodies into
our database duplicates a backup that already exists, at the cost of roughly 156
extra API calls and a second lossy copy of every recipe. Where extraction
succeeds we also archive the original source HTML, which is a better artifact
than Notion's clipped rendering.

If the dry run shows an unexpectedly large unreachable class, revisit this: at
that point eager fetching stops being redundant and starts being the main path.

---

## File structure

```
src/lib/notion/
  client.ts        Notion API access — the only file that talks to Notion
  types.ts         NotionRecipeRow, the shape everything else consumes
  map.ts           NotionRecipeRow -> migration input.  PURE.
  body.ts          Notion blocks -> ExtractedRecipe.     PURE.
src/lib/db/queries/
  recipes.ts       (modify) accept createdAt; add applyNotionMetadata
scripts/
  migrate-notion.ts   dry-run and execute
docs/
  migration-report.md written by the dry run, committed for the record
tests/notion/
  fixtures/*.json  real rows and bodies, committed
```

**Boundary rule:** `src/lib/notion/map.ts` and `body.ts` are pure and take plain data. Only `client.ts` touches the network. That is what lets the mapping be tested against committed fixtures with no token and no network.

---

### Task 1: Notion access

**Files:** Create `src/lib/notion/client.ts`, `src/lib/notion/types.ts`. Modify `.env.example`, `package.json`.

- [ ] **Step 1: Install and document the token**

```bash
npm install @notionhq/client
```

Add to `.env.example`:

```
# One-time migration only. Create an internal integration at
# https://www.notion.so/my-integrations, then share the "Library" database
# with it (Share -> the integration name). Delete this once migrated.
NOTION_TOKEN=
NOTION_DATA_SOURCE_ID=a4ac088b-6fea-4de2-bde5-594f328bce9d
```

- [ ] **Step 2: Define the row shape**

Create `src/lib/notion/types.ts`:

```ts
/**
 * One row of the Notion "Library" database, reduced to the fields the
 * migration cares about. Everything downstream consumes this rather than
 * Notion's API shape, so the mapping and body conversion stay testable
 * against committed fixtures with no token and no network.
 */
export type NotionRecipeRow = {
  pageId: string
  title: string
  /** Raw, exactly as stored. 38% are markdown `[url](url)` — see map.ts. */
  link: string | null
  publisher: string | null
  author: string | null
  rating: number | null
  cookingStatus: 'Made It' | 'Want to Make' | null
  tags: string[]
  createdTime: string
}

/** The page body, used when the source URL is dead, blocked, or absent. */
export type NotionRecipeBody = {
  pageId: string
  /** Notion-flavoured markdown of the page content. */
  markdown: string
}
```

- [ ] **Step 3: Implement the client**

Create `src/lib/notion/client.ts` exporting:

- `createNotionClient(token = process.env.NOTION_TOKEN)` — throws a clear error naming the env var when unset, at call time not import time (match the pattern in `src/lib/llm/anthropic-client.ts`).
- `fetchRecipeRows(client, dataSourceId): Promise<NotionRecipeRow[]>` — queries the data source, filters to `Type = Recipe`, paginates until exhausted, and maps each page's properties onto `NotionRecipeRow`. Notion's property shapes are awkward (`title` is an array of rich text, `select` is an object, `multi_select` an array of objects) — do the unwrapping here so nothing downstream sees them.
- `fetchPageBody(client, pageId): Promise<NotionRecipeBody>` — reads the page's blocks, recursing into children, and renders them as markdown. Handle at minimum: headings, paragraphs, bulleted and numbered list items, images, and quotes. Ignore anything else rather than throwing.

**No unit tests for this file** — it is I/O against someone else's API, and the value is in the pure modules it feeds. Do not write a test that mocks the Notion SDK to assert request shapes.

- [ ] **Step 4: Verify against the real database and capture fixtures**

Write `scripts/notion-capture.ts` (a throwaway, deleted in step 5):

```ts
#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { createNotionClient, fetchRecipeRows, fetchPageBody } from '../src/lib/notion/client'

async function main() {
  const client = createNotionClient()
  const rows = await fetchRecipeRows(client, process.env.NOTION_DATA_SOURCE_ID!)
  console.log(`rows: ${rows.length}`)
  console.log(`markdown links: ${rows.filter((r) => r.link?.startsWith('[')).length}`)
  console.log(`no link: ${rows.filter((r) => !r.link).length}`)

  const markdownLink = rows.find((r) => r.link?.startsWith('['))!
  const noLink = rows.find((r) => !r.link)!
  const populated = rows.find((r) => r.rating !== null && r.tags.length > 1)!

  mkdirSync('tests/notion/fixtures', { recursive: true })
  writeFileSync('tests/notion/fixtures/rows.json',
    JSON.stringify([markdownLink, noLink, populated], null, 2))
  writeFileSync('tests/notion/fixtures/body.json',
    JSON.stringify(await fetchPageBody(client, noLink.pageId), null, 2))

  console.log(`captured: ${markdownLink.title} | ${noLink.title} | ${populated.title}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

Run it:

```bash
npx tsx --env-file-if-exists=.env.local scripts/notion-capture.ts
```

Expected: `rows: 156`, `markdown links: 59`, `no link: 4`. **If the row count is not 156, stop and report rather than proceeding** — either the filter is wrong or the source data changed since this plan was written.

Capturing the body of a **no-link** recipe is deliberate: that is one of the four rows whose Notion body is the only copy that exists, so it is the exact input Task 3 must handle.

These fixtures are the test inputs for Tasks 2 and 3. Commit them. Report the row count you observed — if it is not 156, stop and say so rather than proceeding.

- [ ] **Step 5: Commit**

```bash
rm scripts/notion-capture.ts
git add src/lib/notion package.json package-lock.json .env.example tests/notion/fixtures
git commit -m "feat: add Notion client for the one-time migration"
```

---

### Task 2: Map a Notion row to a migration input

**Files:** Create `src/lib/notion/map.ts`. Test: `tests/notion/map.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/notion/map.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { unwrapLink, mapNotionRow } from '@/lib/notion/map'
import type { NotionRecipeRow } from '@/lib/notion/types'

const base: NotionRecipeRow = {
  pageId: 'page-1',
  title: 'HOMEMADE WHITE BREAD',
  link: 'https://butterwithasideofbread.com/homemade-bread/',
  publisher: 'Butter with a Side of Bread',
  author: null,
  rating: 5,
  cookingStatus: 'Made It',
  tags: ['Bread', 'Appetizer', 'Side Dish'],
  createdTime: '2020-12-20 00:59:34Z',
}

describe('unwrapLink', () => {
  it('unwraps a markdown link, which 38% of the library uses', () => {
    expect(unwrapLink('[https://food.com/r/1](https://food.com/r/1)'))
      .toBe('https://food.com/r/1')
  })

  it('unwraps when the label and target differ, preferring the target', () => {
    expect(unwrapLink('[Oatmeal Cookies](https://food.com/r/1)'))
      .toBe('https://food.com/r/1')
  })

  it('leaves a bare url alone', () => {
    expect(unwrapLink('https://food.com/r/1')).toBe('https://food.com/r/1')
  })

  it('trims surrounding whitespace', () => {
    expect(unwrapLink('  https://food.com/r/1  ')).toBe('https://food.com/r/1')
  })

  it('returns null for null, empty, or whitespace', () => {
    expect(unwrapLink(null)).toBeNull()
    expect(unwrapLink('')).toBeNull()
    expect(unwrapLink('   ')).toBeNull()
  })

  it('returns null for a markdown link with an empty target', () => {
    expect(unwrapLink('[label]()')).toBeNull()
  })
})

describe('mapNotionRow', () => {
  it('carries the rating, status, and original creation date', () => {
    const m = mapNotionRow(base)
    expect(m.rating).toBe(5)
    expect(m.status).toBe('made_it')
    expect(m.createdAt.toISOString()).toBe('2020-12-20T00:59:34.000Z')
  })

  it('maps Want to Make and a blank status', () => {
    expect(mapNotionRow({ ...base, cookingStatus: 'Want to Make' }).status).toBe('want_to_make')
    expect(mapNotionRow({ ...base, cookingStatus: null }).status).toBeNull()
  })

  it('normalizes tags through the taxonomy and drops the rest', () => {
    const m = mapNotionRow({ ...base, tags: ['Bread', 'Dinner', 'Docker', 'Seafood'] })
    expect(m.tags).toContainEqual({ facet: 'course', value: 'bread' })
    expect(m.tags).toContainEqual({ facet: 'ingredient', value: 'seafood' })
    // Dinner is deliberately dropped; Docker is not food.
    expect(m.tags.map((t) => t.value)).not.toContain('dinner')
    expect(m.tags.map((t) => t.value)).not.toContain('docker')
  })

  it('yields no tags for an untagged row rather than throwing', () => {
    expect(mapNotionRow({ ...base, tags: [] }).tags).toEqual([])
  })

  it('canonicalizes the url and extracts the domain', () => {
    const m = mapNotionRow({ ...base, link: '[https://www.food.com/r/1?utm_source=x](https://www.food.com/r/1?utm_source=x)' })
    expect(m.sourceUrl).toBe('https://food.com/r/1')
    expect(m.sourceDomain).toBe('food.com')
  })

  it('yields a null source url for a row with no link, without throwing', () => {
    const m = mapNotionRow({ ...base, link: null })
    expect(m.sourceUrl).toBeNull()
    expect(m.sourceDomain).toBeNull()
  })

  it('yields a null source url for a link that is not a url', () => {
    expect(mapNotionRow({ ...base, link: 'see the cookbook' }).sourceUrl).toBeNull()
  })

  it('keeps the Notion title and publisher for use when extraction fails', () => {
    const m = mapNotionRow(base)
    expect(m.notionTitle).toBe('HOMEMADE WHITE BREAD')
    expect(m.publisher).toBe('Butter with a Side of Bread')
  })

  it('maps every committed fixture row without throwing', async () => {
    const rows = (await import('./fixtures/rows.json')).default as NotionRecipeRow[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(() => mapNotionRow(row)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run tests/notion/map`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

Create `src/lib/notion/map.ts` exporting `unwrapLink` and `mapNotionRow`.

```ts
export type MigrationInput = {
  pageId: string
  notionTitle: string
  publisher: string | null
  author: string | null
  sourceUrl: string | null
  sourceDomain: string | null
  rating: number | null
  status: 'made_it' | 'want_to_make' | null
  tags: TagAssignment[]
  createdAt: Date
}
```

`unwrapLink` handles the markdown form `[label](target)` — **38% of the library stores links this way**, and passing one to `normalizeSourceUrl` would fail every one of them. Prefer the target over the label; return null when the target is empty. Then trim, and return null for anything blank.

`mapNotionRow` runs the unwrapped link through `normalizeSourceUrl` inside a try/catch — a link that is not a URL yields nulls rather than throwing, because the row is still migratable from its Notion body. Tags go through `normalizeTags` from `@/lib/taxonomy`, which already drops `Dinner` and the non-food vocabulary. `createdTime` parses to a `Date`.

**Do not map `addedBy`.** The `Added By` property is empty on all 156 rows — there is nothing to carry over, and inventing a default would fabricate a fact.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/notion/map`
Expected: PASS.

```bash
git add src/lib/notion/map.ts tests/notion/map.test.ts
git commit -m "feat: map Notion rows to migration inputs, unwrapping markdown links"
```

---

### Task 3: Turn a Notion page body into a recipe

This is the recovery path for dead links, blocked publishers, and the four rows with no URL. It is not a rare fallback: `getpocket.com` is already confirmed dead, and seven years of saved links guarantees more.

**Files:** Create `src/lib/notion/body.ts`. Test: `tests/notion/body.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/notion/body.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fromNotionBody } from '@/lib/notion/body'
import type { NotionRecipeRow, NotionRecipeBody } from '@/lib/notion/types'

const row: NotionRecipeRow = {
  pageId: 'p1', title: 'Homemade Flatbread', link: null,
  publisher: 'Easy Weeknight Recipes', author: 'Katerina',
  rating: 5, cookingStatus: 'Made It', tags: ['Bread'],
  createdTime: '2022-03-02 22:09:26Z',
}

const body = (markdown: string): NotionRecipeBody => ({ pageId: 'p1', markdown })

const FULL = body(`![](https://example.com/flatbread.jpg)

Flatbread is serious comfort food for this Macedonian girl. Carbs, carbs, carbs.
I make my own because it is quick, and easier than most breads.

## Ingredients

- 1¼ cups lukewarm water
- ¾ cups plain yogurt
- 3¾ cups all-purpose flour

## Instructions

1. Whisk together the water, yeast, and sugar. Rest 8 to 10 minutes.
2. Add the flour and parsley. Stir until the dough comes together.
3. Knead for 4 minutes on a floured surface.
`)

describe('fromNotionBody', () => {
  it('extracts ingredients and steps in document order', () => {
    const r = fromNotionBody(row, FULL)!
    expect(r.ingredients.map((i) => i.rawText)).toEqual([
      '1¼ cups lukewarm water', '¾ cups plain yogurt', '3¾ cups all-purpose flour',
    ])
    expect(r.steps.map((s) => s.text)).toEqual([
      'Whisk together the water, yeast, and sugar. Rest 8 to 10 minutes.',
      'Add the flour and parsley. Stir until the dough comes together.',
      'Knead for 4 minutes on a floured surface.',
    ])
  })

  it('never parses quantities — that is enrichment\'s job', () => {
    const [first] = fromNotionBody(row, FULL)!.ingredients
    expect(first).toEqual({
      position: 0, section: null, rawText: '1¼ cups lukewarm water',
      quantity: null, unit: null, item: null, note: null,
    })
  })

  it('marks the extraction method as notion', () => {
    expect(fromNotionBody(row, FULL)!.extractionMethod).toBe('notion')
  })

  it('takes the title and publisher from the row, not from guessing at the body', () => {
    const r = fromNotionBody(row, FULL)!
    expect(r.title).toBe('Homemade Flatbread')
    expect(r.publisher).toBe('Easy Weeknight Recipes')
    expect(r.author).toBe('Katerina')
  })

  it('takes the first image as the hero', () => {
    expect(fromNotionBody(row, FULL)!.heroImageUrl).toBe('https://example.com/flatbread.jpg')
  })

  it('keeps prose that is neither ingredients nor steps as the narrative', () => {
    const r = fromNotionBody(row, FULL)!
    expect(r.narrativeHtml).toContain('Macedonian girl')
    expect(r.narrativeHtml).not.toContain('3¾ cups all-purpose flour')
  })

  it('recognizes alternate heading wording', () => {
    const r = fromNotionBody(row, body(`### What You Need\n\n- 2 eggs\n\n### Directions\n\n1. Boil them.\n`))!
    expect(r.ingredients).toHaveLength(1)
    expect(r.steps).toHaveLength(1)
  })

  it('returns null when there is no recipe in the body', () => {
    expect(fromNotionBody(row, body('Just a story about bread, with no recipe.\n'))).toBeNull()
  })

  it('returns null for an empty body', () => {
    expect(fromNotionBody(row, body(''))).toBeNull()
  })

  it('accepts a body with ingredients but no steps', () => {
    const r = fromNotionBody(row, body('## Ingredients\n\n- 1 tsp salt\n- 1 tsp pepper\n'))
    expect(r).not.toBeNull()
    expect(r!.ingredients).toHaveLength(2)
    expect(r!.steps).toEqual([])
  })

  it('converts the committed real fixture', async () => {
    const fixture = (await import('./fixtures/body.json')).default as NotionRecipeBody
    const r = fromNotionBody(row, fixture)
    // Assert against what the real page actually contains — fill these in from
    // the fixture captured in Task 1 rather than guessing.
    expect(r).not.toBeNull()
    expect(r!.ingredients.length).toBeGreaterThan(2)
  })
})
```

**On the last test:** the fixture is captured in Task 1, so its exact contents are unknown while this plan is written. Tighten that assertion to the real ingredient count and first ingredient text once you have the file — a `toBeGreaterThan(2)` is a placeholder for a real number, and leaving it loose wastes the only test that proves this works on genuine Notion output.

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Implement**

Create `src/lib/notion/body.ts`:

```ts
export function fromNotionBody(
  row: NotionRecipeRow,
  body: NotionRecipeBody,
): ExtractedRecipe | null
```

Section detection is heading-driven: walk the markdown, track the current section, and classify list items by which section they fall under. Recognize ingredient headings (`ingredients`, `what you need`, `you'll need`) and instruction headings (`instructions`, `directions`, `method`, `steps`, `how to make`) case-insensitively.

Return null when there are no ingredients **and** no steps — matching `upsertRecipe`'s notion of a usable recipe, and the same OR rule the extraction chain uses.

**Never parse quantities here.** The Notion body is a lossy copy already; the verbatim line is the last thing standing between a bad parse and lost data.

- [ ] **Step 4: Run and commit**

```bash
git add src/lib/notion/body.ts tests/notion/body.test.ts
git commit -m "feat: recover recipes from Notion page bodies when the source is gone"
```

---

### Task 4: Let the database accept a historical creation date

`upsertRecipe` sets `createdAt` from a default and never accepts one. A recipe saved in 2019 must still read as 2019 after migrating, or the library's whole sense of history is flattened to the migration date.

**Files:** Modify `src/lib/db/queries/recipes.ts`. Test: `tests/db/upsert-recipe.test.ts`.

- [ ] **Step 1: Write the failing test**

Add to `tests/db/upsert-recipe.test.ts`:

```ts
  it('accepts a historical creation date for migrated recipes', async () => {
    const createdAt = new Date('2019-11-09T15:04:05.000Z')
    const id = await upsertRecipe(db, {
      extracted, sourceUrl: 'https://x.com/old', sourceDomain: 'x.com', createdAt,
    })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.createdAt.toISOString()).toBe(createdAt.toISOString())
  })

  it('does not move createdAt on a later re-import', async () => {
    const createdAt = new Date('2019-11-09T15:04:05.000Z')
    const url = 'https://x.com/old2'
    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com', createdAt })
    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const [row] = await db.select().from(recipes).where(eq(recipes.sourceUrl, url))
    expect(row.createdAt.toISOString()).toBe(createdAt.toISOString())
  })
```

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Implement**

Add an optional `createdAt?: Date` to `UpsertInput`, applied **only on insert**. `createdAt` is already excluded from the update path — keep it that way, and make sure the new field does not accidentally reintroduce it there. The existing test asserting a 2019 date survives re-import must keep passing.

- [ ] **Step 4: Run and commit**

```bash
git add src/lib/db/queries/recipes.ts tests/db/upsert-recipe.test.ts
git commit -m "feat: preserve a historical creation date through upsertRecipe"
```

---

### Task 5: Apply Notion-only metadata

Rating, cooking status, and the original tags exist only in Notion — extraction cannot produce them. They are applied after the import writes the recipe.

**Files:** Modify `src/lib/db/queries/recipes.ts`. Test: `tests/db/notion-metadata.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/notion-metadata.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe, applyNotionMetadata } from '@/lib/db/queries/recipes'
import { recipes, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
let recipeId: string

const extracted: ExtractedRecipe = {
  title: 'Homemade Flatbread', description: null, author: null, publisher: null,
  claimedTimeMinutes: null, servings: null, yieldText: null,
  ingredients: [{ position: 0, section: null, rawText: '3 cups flour', quantity: null, unit: null, item: null, note: null }],
  steps: [{ position: 0, section: null, text: 'Knead.' }],
  tags: [{ facet: 'course', value: 'bread' }],
  heroImageUrl: null, narrativeHtml: null, extractionMethod: 'jsonld',
}

beforeEach(async () => {
  db = await createTestDb()
  recipeId = await upsertRecipe(db, {
    extracted, sourceUrl: 'https://example.com/flatbread', sourceDomain: 'example.com',
  })
})

const tagsOf = async () =>
  (await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)))
    .map((t) => `${t.facet}:${t.value}`).sort()

describe('applyNotionMetadata', () => {
  it('sets the rating and status', async () => {
    await applyNotionMetadata(db, recipeId, { rating: 5, status: 'made_it', tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(5)
    expect(row.status).toBe('made_it')
  })

  it('adds Notion tags to what extraction already found rather than replacing them', async () => {
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'ingredient', value: 'chicken' }],
    })
    expect(await tagsOf()).toEqual(['course:bread', 'ingredient:chicken'])
  })

  it('does not duplicate a tag extraction already produced', async () => {
    await applyNotionMetadata(db, recipeId, {
      rating: null, status: null, tags: [{ facet: 'course', value: 'bread' }],
    })
    expect(await tagsOf()).toEqual(['course:bread'])
  })

  it('leaves a null rating and status as null rather than writing zeros', async () => {
    await applyNotionMetadata(db, recipeId, { rating: null, status: null, tags: [] })
    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBeNull()
    expect(row.status).toBeNull()
  })

  it('is idempotent, because a resumed migration will run it twice', async () => {
    const input = { rating: 4, status: 'want_to_make' as const, tags: [{ facet: 'method' as const, value: 'oven' }] }
    await applyNotionMetadata(db, recipeId, input)
    await expect(applyNotionMetadata(db, recipeId, input)).resolves.not.toThrow()

    const [row] = await db.select().from(recipes).where(eq(recipes.id, recipeId))
    expect(row.rating).toBe(4)
    expect(await tagsOf()).toEqual(['course:bread', 'method:oven'])
  })
})
```

**A decision to make and record:** the tags changed, so the FTS row is now stale with respect to them — except the FTS row does not index tags at all (it holds title, ingredients, steps, notes, narrative). Confirm that by reading `upsertRecipe`, and if it holds, add a comment saying no re-index is needed and why. If it does not hold, re-index and add a test.

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Implement**

```ts
export async function applyNotionMetadata(
  db: Db,
  recipeId: string,
  input: { rating: number | null; status: 'made_it' | 'want_to_make' | null; tags: TagAssignment[] },
): Promise<void>
```

Insert tags with conflict-ignore semantics, or read-then-diff — either is fine, but it must be safe to run twice, because a resumed migration will.

- [ ] **Step 4: Run and commit**

```bash
git add src/lib/db/queries/recipes.ts tests/db/notion-metadata.test.ts
git commit -m "feat: apply Notion rating, status, and tags after import"
```

---

### Task 6: The dry run

This is the spec's promise: *"It runs dry first, producing a report: what extracted cleanly, what fell back, what needs your eyes. You read that before anything is written."*

**Files:** Create `scripts/migrate-notion.ts`. Modify `package.json`.

- [ ] **Step 1: Implement dry-run mode**

`npm run migrate -- --dry-run` must:

- Fetch all 156 rows and map them.
- For each, attempt `fetchPage` + `extract` **with a no-op LLM client** and **write nothing** — no database, no blob storage.
- Classify each row into one of: `structured` (JSON-LD or microdata found), `needs-llm` (reachable, but no structured data — the real run will spend a model call), `blocked`, `dead` (fetch failed), `no-link`, `notion-body-only` (unreachable but a Notion body exists), `unrecoverable` (unreachable and no usable body).
- Emit a report to `docs/migration-report.md` **and** stdout: totals per class, a per-publisher breakdown, the full list of anything not in `structured`, and an estimate of how many model calls the real run will make.

**Why the no-op LLM matters:** the dry run must be free and repeatable. Using a real client would spend the same money as the migration itself and make "run it again after a fix" a costly decision.

Concurrency: at most 3 in flight. These are 156 requests to other people's servers; be a good citizen and stay well under anything that looks like abuse.

- [ ] **Step 2: Run it for real**

```bash
npm run migrate -- --dry-run
```

Read the report. Record in this plan, under a "Dry run results" heading:

- the count in each class
- how many URLs are dead, and which publishers
- how many will need a model call
- anything surprising

**This is a checkpoint. Do not proceed to Task 7 without reading the report** — it may reveal that a class is far larger than expected and that the plan needs adjusting.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-notion.ts package.json docs/migration-report.md
git commit -m "feat: add the migration dry run"
```

---

### Task 7: The migration runner

**Files:** Modify `scripts/migrate-notion.ts`. Test: `tests/notion/migrate.test.ts` for the pure decision logic.

- [ ] **Step 1: Extract the decision logic and test it**

The runner's branching — given a mapped row and an import outcome, what happens next — should be a pure function so it can be tested without a network or a database:

```ts
export type MigrationAction =
  | { kind: 'import' }
  | { kind: 'notion-body' }
  | { kind: 'skip'; reason: string }

export function decideAction(
  input: MigrationInput,
  outcome: { status: string; failureKind: string | null } | null,
): MigrationAction
```

Test: a row with no link goes straight to `notion-body`; a `blocked` outcome goes to `notion-body`; a `fetch_failed` outcome goes to `notion-body`; a `no_recipe` outcome goes to `notion-body`; an `llm_failed` outcome is a `skip` marked retryable rather than a fallback, because the page is fine and the model was not; a `done` outcome needs no further action.

- [ ] **Step 2: Implement the runner**

`npm run migrate` must:

1. Process rows sequentially or with concurrency ≤ 2. **The bottleneck is the model's rate limit, not the network** — plan 2's review identified a rate-limited burst as the single most likely failure, producing recipes with zero tags that still report success.
2. For each row: create a job, run `runImport` with the real dependencies, then apply Notion metadata, then set the historical `createdAt`.
3. On a failure the decision function routes to `notion-body`, fetch the page body, convert it, and `upsertRecipe` directly with `extractionMethod: 'notion'` — then apply metadata and date as usual.
4. **Retry on model rate limits with exponential backoff**, and treat exhaustion as a hard stop rather than continuing to import recipes that will silently lack tags.
5. **Write a resume file** after every row. A run that stops halfway must be resumable without re-importing what already succeeded, and without spending model calls twice.
6. Print a running progress line, and a summary at the end.

- [ ] **Step 3: Run the migration**

```bash
npm run migrate
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-notion.ts tests/notion/migrate.test.ts
git commit -m "feat: add the resumable migration runner"
```

---

### Task 8: Verify the migration, and repair what the model missed

**Files:** Create `scripts/migration-verify.ts`. Modify `package.json`.

- [ ] **Step 1: Write the verification script**

`npm run migrate:verify` reports, from the database:

- total recipes, versus 156
- how many have a source URL, an image, a narrative, an archived source blob
- how many have zero tags, and how many have `enrichment_applied = false` — **this is the failure plan 2's review predicted**, and the whole reason `npm run unenriched` exists
- the facet distribution: how many recipes per course, per ingredient, per method, per cuisine
- rating and status counts, to reconcile against Notion's 74 rated / 76 made / 69 want
- the oldest and newest `created_at`, to prove dates were preserved rather than flattened to today
- any recipe with no ingredients or no steps

- [ ] **Step 2: Run it and reconcile**

Compare against the measured facts at the top of this plan. **Any discrepancy is a finding, not a rounding error** — 156 in means 156 accounted for, whether imported, recovered from a body, or explicitly listed as unrecoverable.

- [ ] **Step 3: Repair unenriched recipes**

For every recipe with `enrichment_applied = false` and a source URL, re-run the import. This is exactly the repair path plan 2 built `allowExistingUpdate` and `EnrichmentRegressionError` for: re-importing an unenriched recipe can only improve it, and the regression guard prevents an outage from making things worse.

Re-run the verification afterward and record the before and after counts.

- [ ] **Step 4: Record the results and commit**

Write the final numbers into this plan under "Migration results". Commit the scripts and the updated plan.

---

### Task 9: Retire the Notion dependency

**Files:** Modify `.env.example`, `docs/`.

- [ ] **Step 1: Confirm nothing in the running app imports `src/lib/notion`**

Only `scripts/migrate-notion.ts` may. Add an assertion to `src/lib/extract/purity.test.ts`'s style — a test that fails if anything under `src/app` or `src/lib` (other than `src/lib/notion` itself) imports it.

- [ ] **Step 2: Document the wind-down**

Note in `.env.example` that `NOTION_TOKEN` can be deleted after migration, and that the Notion integration can be revoked. **Do not delete the Notion database** — it stays as the backup of record until the app has been used happily for a while. Say that explicitly in the docs; the temptation to clean up early is exactly how a bad migration becomes an unrecoverable one.

- [ ] **Step 3: Commit**

---

## Definition of done

- All 156 Notion recipes are accounted for: imported, recovered from a Notion body, or explicitly listed as unrecoverable with a reason.
- `created_at` spans 2019 to 2026, not a single migration day.
- Ratings and statuses reconcile with the source: 74 rated, 76 made it, 69 want to make.
- No recipe has `enrichment_applied = false` with a live source URL — or the remainder is listed with a reason.
- The 59 markdown-wrapped links all resolved; none failed for being markdown.
- `npm test` passes; `tsc --noEmit` and `eslint` clean.
- `docs/migration-report.md` and the results in this plan are committed.
- The Notion database is untouched.

## Handoff to plan 4 (the UI)

- **The facet distribution from Task 8 is the input to the filter rail's design.** A facet with three recipes in it is not worth a row in the rail; one with sixty may need sub-grouping.
- **Image coverage decides the grid.** If a large fraction of recipes have no hero image, the photo-wall layout needs a designed empty state rather than grey rectangles.
- **`narrativeHtml` needs attribute-level sanitization on render.** Readability strips `<script>` and `<style>`, but inline `onclick`/`onerror` survive. Ingredient `rawText` and step text are untrusted third-party strings too — render as text, never `dangerouslySetInnerHTML`.
- **FTS re-indexing on notes edits** is still unimplemented: `upsertRecipe` writes an empty notes column to the FTS row, so the edit path that sets notes must re-index.
- **`GET /api/library-index`** — the ~30KB payload the client filters in memory — is plan 4's, and its shape follows from what the rail renders.
- Still open from earlier plans: a redirected failed job's archive is not findable from the job row; no reaper for stale `running` jobs; RDFa is specified but unimplemented.
