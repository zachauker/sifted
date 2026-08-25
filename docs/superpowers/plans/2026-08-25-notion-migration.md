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

**Fixtures are already committed**, captured from the live database while this
plan was written, so Tasks 2 and 3 can be built and tested before a token
exists:

- `tests/notion/fixtures/rows.json` — a markdown-wrapped link, a no-link row
  (Ham Pot Pie), a fully populated row, and the one **titleless** row in the
  library (a blank page created by accident, which must not crash the run).
- `tests/notion/fixtures/body-structured.json` — Tamale Pie: headings,
  sub-sections, and a source URL in the body despite an empty `Link` property.
- `tests/notion/fixtures/body-unstructured.json` — Ham Pot Pie: a hand-typed
  family recipe with no headings, no instructions, and no copy anywhere else.

This step re-captures them from the live database to confirm the client agrees
with what is committed. If a fixture differs materially, prefer the fresh
capture and update the tests — but say so, because the committed ones were taken
from the real database and the tests were written against them.

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

### Task 3: Recover a recipe from a Notion page body

This is the recovery path for dead links, blocked publishers, and the rows with no
URL. It is not a rare fallback: `getpocket.com` is already confirmed dead, and
seven years of saved links guarantees more.

**Two real bodies are committed as fixtures, and they are nothing alike.** The
design follows from that, so read both before writing code.

`tests/notion/fixtures/body-structured.json` (Cast-Iron Green Chile Tamale Pie)
is cleanly structured — `## Ingredients` with `### For the filling` and
`### For the cornbread topping` sub-headings, then `## Preparation` with its own
sub-headings. Those sub-headings map directly onto the `section` field on
ingredients and steps. **It also carries its source URL as a markdown link in the
first line of the body, even though the row's `Link` property is empty.**

`tests/notion/fixtures/body-unstructured.json` (Ham Pot Pie) has no headings at
all. It is a hand-typed family recipe: bare lines, a bolded `**Dough**` acting as
a section break, several lines with no quantity ("Ham", "Garlic"), and **no
instructions whatsoever**. It is rated 5 and Made It, and its Notion body is the
only copy of it that exists anywhere.

A heading-driven parser handles the first and returns null for the second —
silently dropping a five-star family recipe. So this module mirrors the
extraction chain's own philosophy: **deterministic parse first, LLM second.**

**Files:** Create `src/lib/notion/body.ts`. Test: `tests/notion/body.test.ts`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notion/body.test.ts`. Use the two committed fixtures as the
primary cases — they are real data, and inline samples are a supplement, not a
substitute.

```ts
import { describe, it, expect, vi } from 'vitest'
import { findSourceUrlInBody, fromNotionBody } from '@/lib/notion/body'
import type { NotionRecipeRow, NotionRecipeBody } from '@/lib/notion/types'
import type { LlmClient } from '@/lib/extract/llm-types'
import structured from './fixtures/body-structured.json'
import unstructured from './fixtures/body-unstructured.json'

const row = (over: Partial<NotionRecipeRow> = {}): NotionRecipeRow => ({
  pageId: 'p1', title: 'Ham Pot Pie', link: null, publisher: 'Homemade',
  author: null, rating: 5, cookingStatus: 'Made It', tags: ['Dinner'],
  createdTime: '2022-01-30 00:02:00Z', ...over,
})

const noLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

describe('findSourceUrlInBody', () => {
  it('finds a source url that the Link property was missing', () => {
    expect(findSourceUrlInBody(structured as NotionRecipeBody))
      .toBe('https://www.finecooking.com/recipe/cast-iron-green-chile-tamale-pie')
  })

  it('returns null when the body has no link', () => {
    expect(findSourceUrlInBody(unstructured as NotionRecipeBody)).toBeNull()
  })

  it('ignores links that appear inside an ingredient line', () => {
    const body = { pageId: 'p', markdown: '## Ingredients\n- 1 cup [salsa](https://x.com/salsa)\n' }
    expect(findSourceUrlInBody(body)).toBeNull()
  })
})

describe('fromNotionBody — structured body', () => {
  it('parses headings without needing the model', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm))!
    expect(r.extractionMethod).toBe('notion')
    expect(noLlm.extractRecipe).not.toHaveBeenCalled()
    expect(r.ingredients).toHaveLength(21)
    expect(r.ingredients[0].rawText).toBe('1 lb. 85% lean ground beef')
    expect(r.steps).toHaveLength(5)
  })

  it('carries sub-headings through as ingredient and step sections', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm))!
    expect(r.ingredients[0].section).toBe('For the filling')
    expect(r.ingredients.at(-1)!.section).toBe('For the cornbread topping')
    expect(r.steps[0].section).toBe('Make the filling')
  })

  it('keeps the prose above the recipe as the narrative', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm))!
    expect(r.narrativeHtml).toContain('Tamale pie owes its name')
    expect(r.narrativeHtml).not.toContain('lean ground beef')
  })

  it('takes the hero image from the body', async () => {
    const r = (await fromNotionBody(row({ title: 'Tamale Pie' }), structured as NotionRecipeBody, noLlm))!
    expect(r.heroImageUrl).toContain('tamale-beef-pie')
  })
})

describe('fromNotionBody — unstructured body', () => {
  it('falls back to the model when there are no headings', async () => {
    const llm: LlmClient = {
      enrich: vi.fn(),
      extractRecipe: vi.fn().mockResolvedValue({
        title: 'Ham Pot Pie', description: null, author: null,
        claimedTimeMinutes: null, servings: null, yieldText: null,
        ingredients: ['Ham', '1 lb potatoes', '4 cups flour'],
        steps: [],
      }),
    }
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, llm))!

    expect(llm.extractRecipe).toHaveBeenCalledOnce()
    expect(r.ingredients.map((i) => i.rawText)).toEqual(['Ham', '1 lb potatoes', '4 cups flour'])
    expect(r.extractionMethod).toBe('notion')
  })

  it('salvages the lines as ingredients when the model is unavailable', async () => {
    // A five-star family recipe that exists nowhere else must not be lost
    // because the model was down. Bare lines become verbatim ingredients.
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm))!
    expect(r.ingredients.map((i) => i.rawText)).toContain('1 lb potatoes')
    expect(r.ingredients.map((i) => i.rawText)).toContain('4 cups flour')
    expect(r.steps).toEqual([])
  })

  it('treats a bolded line as a section break', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm))!
    const flour = r.ingredients.find((i) => i.rawText === '4 cups flour')!
    expect(flour.section).toBe('Dough')
  })
})

describe('fromNotionBody — shared behavior', () => {
  it('never parses quantities; that is enrichment\'s job', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm))!
    for (const i of r.ingredients) {
      expect(i.quantity).toBeNull()
      expect(i.unit).toBeNull()
      expect(i.item).toBeNull()
    }
  })

  it('takes the title and publisher from the row, not from the body', async () => {
    const r = (await fromNotionBody(row(), unstructured as NotionRecipeBody, noLlm))!
    expect(r.title).toBe('Ham Pot Pie')
    expect(r.publisher).toBe('Homemade')
  })

  it('returns null for an empty body', async () => {
    expect(await fromNotionBody(row(), { pageId: 'p', markdown: '' }, noLlm)).toBeNull()
  })

  it('returns null for a body with only prose and no recipe', async () => {
    const body = { pageId: 'p', markdown: 'We should try making this sometime.\n' }
    expect(await fromNotionBody(row(), body, noLlm)).toBeNull()
  })

  it('returns null for a titleless row with an empty body', async () => {
    // The library contains exactly one of these — a blank page created by
    // accident. It must be reported as unrecoverable, not crash the migration.
    const r = await fromNotionBody(row({ title: null as never }), { pageId: 'p', markdown: '' }, noLlm)
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run tests/notion/body`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

Create `src/lib/notion/body.ts`:

```ts
export function findSourceUrlInBody(body: NotionRecipeBody): string | null

export async function fromNotionBody(
  row: NotionRecipeRow,
  body: NotionRecipeBody,
  llm: LlmClient,
): Promise<ExtractedRecipe | null>
```

Order of strategies, mirroring `src/lib/extract/index.ts`:

1. **Headings.** If the body has an ingredients heading (`ingredients`, `what you
   need`, `you'll need`) or an instructions heading (`instructions`,
   `preparation`, `directions`, `method`, `steps`, `how to make`), parse
   structurally. Sub-headings beneath them become `section`. List items and plain
   lines under a section both count.
2. **The model.** Otherwise hand the body markdown to `llm.extractRecipe` and
   validate with `llmRecipeSchema`, exactly as `extract()` does.
3. **Salvage.** If the model is unavailable or returns nothing usable, take every
   non-image, non-narrative line as a verbatim ingredient, with bolded lines
   (`**Dough**`) as section breaks. This is the floor, and it exists because
   losing a hand-typed family recipe to a model outage is unacceptable.

Return null only when all three yield no ingredients **and** no steps.

`findSourceUrlInBody` looks for a standalone markdown link on its own line near
the top — not one embedded in an ingredient. That is worth having because the
Tamale Pie row has an empty `Link` property while its body carries the URL, so a
row that looks unrecoverable may be importable after all.

**Never parse quantities here.** The Notion body is already a lossy copy; the
verbatim line is the last thing between a bad parse and lost data.

- [ ] **Step 4: Run and commit**

```bash
git add src/lib/notion/body.ts tests/notion/body.test.ts
git commit -m "feat: recover recipes from Notion page bodies, structured or not"
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
