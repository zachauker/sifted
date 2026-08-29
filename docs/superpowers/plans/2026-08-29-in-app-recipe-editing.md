# In-App Recipe Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user fix a recipe's own words — title, attribution, times, ingredient and step lists, and tags — from a page in the app instead of a terminal.

**Architecture:** A dedicated `/recipes/[slug]/edit` route posting to a Server Action, which calls a new `updateRecipeContent` transaction alongside the existing `upsertRecipe`. The FTS insert is lifted out of `upsertRecipe` into a shared `syncFtsRow` so exactly one function still knows how `recipes_fts` is written. Ingredient/step text is parsed and rendered by a new pure module so the editor and the manual-entry route cannot drift.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, Drizzle ORM over libsql/SQLite, Zod 4, Tailwind 4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-29-in-app-recipe-editing-design.md`

## Global Constraints

- **Never write `rating`, `status`, `notes`, or `actualTimeMinutes` from this feature.** They are the four columns nothing can regenerate.
- **Never write `slug`, `createdAt`, `archivedHtmlKey`, `sourceEncoding`, `extractionMethod`, or `enrichmentApplied` from this feature.**
- **`narrativeHtml` is not editable.** Do not add a field for it. There is a test that fails the build on a second `dangerouslySetInnerHTML`.
- **No new `dangerouslySetInnerHTML`, anywhere.**
- Time ceiling is `MAX_REASONABLE_MINUTES`, imported from `@/lib/extract/duration` — never redeclared.
- Inputs and textareas use `text-base` below the `sm` breakpoint (`className="... text-base sm:text-sm ..."`). iOS Safari zooms on focus under 16px and never zooms back.
- Interactive controls get a 44px tap target (`min-h-11`).
- This repo's test files live under `tests/`, mirroring `src/`. Component tests opt into jsdom with a `// @vitest-environment jsdom` first line.
- Full gate, run before any task is called done: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
- Commit after every task. Never use bare `git stash`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/recipe-text.ts` | **Create.** Pure parse/render of the one-per-line, colon-section text format. |
| `src/app/api/recipes/manual/route.ts` | **Modify.** Drop its private `parseLines`, import the shared one. |
| `src/lib/db/schema.ts` | **Modify.** Add `recipes.handEdited`. |
| `drizzle/migrations/0004_*.sql` | **Create** (generated). |
| `src/lib/db/queries/recipe-detail.ts` | **Modify.** Return `handEdited`. |
| `src/lib/db/queries/recipes.ts` | **Modify.** Extract `syncFtsRow` + primitive text helpers; add `updateRecipeContent`. |
| `src/app/(app)/recipes/[slug]/edit/actions.ts` | **Create.** `'use server'` save action: validation, tag assembly, redirect. |
| `src/app/(app)/recipes/[slug]/edit/page.tsx` | **Create.** Server Component: load, 404, render the form. |
| `src/components/recipe/recipe-edit-form.tsx` | **Create.** The client form (`useActionState` + unload guard). |
| `src/components/recipe/recipe-view.tsx` | **Modify.** "Edit" link and the "edited by hand" marker. |

---

### Task 1: The shared line format

**Files:**
- Create: `src/lib/recipe-text.ts`
- Modify: `src/app/api/recipes/manual/route.ts`
- Test: `tests/lib/recipe-text.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SectionedLine = { section: string | null; text: string }`
  - `parseLines(raw: string | null | undefined): string[]`
  - `parseSectionedLines(raw: string | null | undefined): SectionedLine[]`
  - `renderSectionedLines(rows: readonly SectionedLine[]): string`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/recipe-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseLines,
  parseSectionedLines,
  renderSectionedLines,
  type SectionedLine,
} from '@/lib/recipe-text'

describe('parseLines', () => {
  it('returns one trimmed entry per non-blank line', () => {
    expect(parseLines('  1 cup flour  \n2 eggs\n')).toEqual(['1 cup flour', '2 eggs'])
  })

  it('drops blank and whitespace-only lines rather than storing empty rows', () => {
    expect(parseLines('a\n\n   \nb')).toEqual(['a', 'b'])
  })

  it('splits a Windows paste on CRLF without leaving a stray carriage return', () => {
    expect(parseLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
  })

  it('treats null and undefined as no lines at all', () => {
    expect(parseLines(null)).toEqual([])
    expect(parseLines(undefined)).toEqual([])
  })
})

describe('parseSectionedLines', () => {
  it('leaves lines before any header unsectioned', () => {
    expect(parseSectionedLines('2 eggs\n1 cup flour')).toEqual([
      { section: null, text: '2 eggs' },
      { section: null, text: '1 cup flour' },
    ])
  })

  it('applies a colon-terminated header to every line beneath it', () => {
    expect(parseSectionedLines('For the sauce:\n2 Tbsp. gochujang\n1 tsp. honey')).toEqual([
      { section: 'For the sauce', text: '2 Tbsp. gochujang' },
      { section: 'For the sauce', text: '1 tsp. honey' },
    ])
  })

  it('switches sections at the next header and never stores the header itself', () => {
    const lines = parseSectionedLines('For the sauce:\ngochujang\n\nFor the chicken:\n1 chicken')
    expect(lines).toEqual([
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the chicken', text: '1 chicken' },
    ])
    expect(lines.some((line) => line.text.endsWith(':'))).toBe(false)
  })

  it('treats a bare colon as an ordinary line, not an empty section', () => {
    expect(parseSectionedLines(':')).toEqual([{ section: null, text: ':' }])
  })
})

describe('renderSectionedLines', () => {
  it('emits a header wherever the section changes, blank-line separated', () => {
    const rows: SectionedLine[] = [
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the chicken', text: '1 chicken' },
    ]
    expect(renderSectionedLines(rows)).toBe('For the sauce:\ngochujang\n\nFor the chicken:\n1 chicken')
  })

  it('emits no header at all for wholly unsectioned rows', () => {
    expect(
      renderSectionedLines([
        { section: null, text: '2 eggs' },
        { section: null, text: '1 cup flour' },
      ]),
    ).toBe('2 eggs\n1 cup flour')
  })

  it('round-trips: parse(render(rows)) returns the rows unchanged', () => {
    const rows: SectionedLine[] = [
      { section: null, text: 'flaky salt' },
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the sauce', text: 'honey' },
      { section: 'For the chicken', text: '1 chicken' },
    ]
    expect(parseSectionedLines(renderSectionedLines(rows))).toEqual(rows)
  })

  it('absorbs a trailing unsectioned row into the section above it, which is lossy on purpose', () => {
    // A return to "no section" cannot be spelled in this format — there is no
    // closing marker. Extraction produces unsectioned-then-sectioned, never the
    // reverse, so this is documented rather than defended against.
    const rows: SectionedLine[] = [
      { section: 'For the sauce', text: 'gochujang' },
      { section: null, text: 'flaky salt' },
    ]
    expect(parseSectionedLines(renderSectionedLines(rows))).toEqual([
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the sauce', text: 'flaky salt' },
    ])
  })

  it('renders nothing for no rows', () => {
    expect(renderSectionedLines([])).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/recipe-text.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/recipe-text"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/recipe-text.ts`:

```ts
/**
 * The line format the recipe editor and the manual-entry route both speak: one
 * ingredient or step per line, with a line ending in a colon acting as a
 * section header for everything beneath it.
 *
 * Pure — no I/O, no database, no React — so the rules live in one testable
 * place. `parseLines` moved here from `src/app/api/recipes/manual/route.ts`
 * for exactly that reason: two write paths quietly disagreeing about what a
 * blank line means is the drift its own comment warned about.
 */

export type SectionedLine = { section: string | null; text: string }

/**
 * One entry per non-blank line, trimmed.
 *
 * A blank line — including one that is only whitespace — is dropped rather
 * than stored as an empty ingredient or step row; a stray blank line from
 * pasting a recipe out of Notes or an email must not become a phantom row
 * with nothing in it.
 *
 * Splits on `\r\n`, `\r`, and `\n` so a textarea's value survives a paste
 * from Windows (`\r\n`) as cleanly as from anywhere else — a lone `\r` left
 * in would otherwise ride along inside the last "line" of a `\r\n`-joined
 * paste, or turn a single logical line into two.
 */
export function parseLines(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * The section label a line declares, or null if it is an ordinary line.
 *
 * A bare `:` is not a header: it declares an empty label, which would render
 * as a nameless heading on the recipe page.
 */
function headerLabel(line: string): string | null {
  if (!line.endsWith(':')) return null
  const label = line.slice(0, -1).trim()
  return label.length > 0 ? label : null
}

/**
 * Lines with the section each one belongs to. Header lines are consumed, never
 * stored — a header is the `section` value on the rows beneath it.
 *
 * A real ingredient ending in a colon would be misread as a header. That
 * string does not occur in practice, and an escape syntax is one more thing to
 * remember for a case that never happens.
 */
export function parseSectionedLines(raw: string | null | undefined): SectionedLine[] {
  const out: SectionedLine[] = []
  let section: string | null = null

  for (const line of parseLines(raw)) {
    const label = headerLabel(line)
    if (label !== null) {
      section = label
      continue
    }
    out.push({ section, text: line })
  }

  return out
}

/**
 * Stored rows back into textarea text, emitting a header wherever the section
 * changes and a blank line before each one for readability (blank lines are
 * dropped on the way back in, so they cost nothing).
 *
 * Lossy in one direction, on purpose: a row with no section that follows a
 * sectioned row cannot be expressed — this format has no closing marker — so
 * it is absorbed into the section above. Extraction produces
 * unsectioned-then-sectioned, never the reverse.
 */
export function renderSectionedLines(rows: readonly SectionedLine[]): string {
  const out: string[] = []
  let section: string | null = null

  for (const row of rows) {
    if (row.section !== null && row.section !== section) {
      if (out.length > 0) out.push('')
      out.push(`${row.section}:`)
      section = row.section
    }
    out.push(row.text)
  }

  return out.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/recipe-text.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Point the manual-entry route at the shared module**

In `src/app/api/recipes/manual/route.ts`, delete the entire local `parseLines` function *and its docblock*, and add the import beside the other `@/lib` imports:

```ts
import { parseLines } from '@/lib/recipe-text'
```

Leave every other line of that file alone — the call sites already read `parseLines(...)`.

- [ ] **Step 6: Verify the manual route still behaves identically**

Run: `npx vitest run tests/api/manual-route.test.ts`
Expected: PASS, unchanged. This test is the regression guard on the move.

- [ ] **Step 7: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass.

```bash
git add src/lib/recipe-text.ts tests/lib/recipe-text.test.ts src/app/api/recipes/manual/route.ts
git commit -m "One place that knows what a recipe line is"
```

---

### Task 2: The `hand_edited` column

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/migrations/0004_*.sql` (generated — the suffix is random)
- Modify: `src/lib/db/queries/recipe-detail.ts`
- Test: `tests/db/recipe-detail.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `recipes.handEdited` (drizzle boolean column), and `RecipeDetail.handEdited: boolean`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('getRecipeBySlug', ...)` block in `tests/db/recipe-detail.test.ts` (the file already has an `insertRecipe` helper and a `db` set up in `beforeEach`):

```ts
  it('reports a machine-written recipe as not hand-edited', async () => {
    await insertRecipe({ slug: 'untouched' })

    const detail = await getRecipeBySlug(db, 'untouched')

    expect(detail?.handEdited).toBe(false)
  })

  it('reports a hand-edited recipe as hand-edited', async () => {
    await insertRecipe({ slug: 'corrected', handEdited: true })

    const detail = await getRecipeBySlug(db, 'corrected')

    expect(detail?.handEdited).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/recipe-detail.test.ts`
Expected: FAIL — TypeScript/runtime error on the unknown `handEdited` key, and `detail?.handEdited` is `undefined`.

- [ ] **Step 3: Add the column to the schema**

In `src/lib/db/schema.ts`, in the `recipes` table, immediately after the `enrichmentApplied` line:

```ts
  // True once a person has edited this recipe's own words through the editor.
  // Re-import still replaces content wholesale (see `upsertRecipe`); this is
  // what lets the UI warn before that happens, and what the recipe page reads
  // to show its "edited by hand" marker.
  handEdited: integer('hand_edited', { mode: 'boolean' }).notNull().default(false),
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/migrations/0004_<random-name>.sql` containing
`ALTER TABLE \`recipes\` ADD \`hand_edited\` integer DEFAULT false NOT NULL;`, plus an updated `drizzle/migrations/meta/` snapshot.

Read the generated SQL and confirm it contains **only** that `ALTER TABLE`. If it contains anything else, stop and report — the schema has drifted from the migrations and that is not this task's problem to silently absorb.

- [ ] **Step 5: Return it from the detail query**

In `src/lib/db/queries/recipe-detail.ts`, add to the `RecipeDetail` type, after `extractionMethod`:

```ts
  handEdited: boolean
```

and to the `db.select({ ... })` object in `getRecipeBySlug`, beside the other recipe columns:

```ts
      handEdited: recipes.handEdited,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/db/recipe-detail.test.ts`
Expected: PASS.

- [ ] **Step 7: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass. (`npm run db:migrate` is not run here — tests migrate their own throwaway database. Applying it to the real one is a deploy step.)

```bash
git add src/lib/db/schema.ts drizzle/migrations src/lib/db/queries/recipe-detail.ts tests/db/recipe-detail.test.ts
git commit -m "Record that a person has been in here"
```

---

### Task 3: Extract `syncFtsRow`

Pure refactor. No behavior changes. `tests/db/upsert-recipe.test.ts` and `tests/db/fts.test.ts` are the guard and must pass untouched.

**Files:**
- Modify: `src/lib/db/queries/recipes.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all module-private except where noted:
  - `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`
  - `syncFtsRow(tx: Tx, recipeId: string, row: { title: string; ingredients: string; steps: string; notes: string; narrative: string }): Promise<void>`
  - `ingredientLinesText(rows: readonly { section: string | null; rawText: string; item: string | null; note: string | null }[]): string`
  - `stepLinesText(rows: readonly { section: string | null; text: string }[]): string`
  - `narrativeIndexText(description: string | null, narrativeHtml: string | null): string`

- [ ] **Step 1: Confirm the guard tests pass before you touch anything**

Run: `npx vitest run tests/db/upsert-recipe.test.ts tests/db/fts.test.ts tests/db/search.test.ts`
Expected: PASS. Record the test count — it must be identical at the end.

- [ ] **Step 2: Add the helpers**

In `src/lib/db/queries/recipes.ts`, replace the three existing private functions `ingredientsText`, `stepsText`, and `narrativeText` with the following. Keep them in the same place in the file.

```ts
/**
 * The transaction handle drizzle hands to a `db.transaction` callback. Derived
 * rather than imported so it cannot drift from the driver in use.
 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

function ingredientLinesText(
  rows: readonly { section: string | null; rawText: string; item: string | null; note: string | null }[],
): string {
  return rows.map((i) => [i.section, i.rawText, i.item, i.note].filter(Boolean).join(' ')).join('\n')
}

function stepLinesText(rows: readonly { section: string | null; text: string }[]): string {
  return rows.map((s) => [s.section, s.text].filter(Boolean).join(' ')).join('\n')
}

function narrativeIndexText(description: string | null, narrativeHtml: string | null): string {
  // Tags would otherwise be indexed as terms: a search for "strong" should not
  // match every recipe whose narrative uses bold text.
  const narrative = (narrativeHtml ?? '').replace(/<[^>]*>/g, ' ')
  return [description ?? '', narrative].join(' ').replace(/\s+/g, ' ').trim()
}

function ingredientsText(extracted: ExtractedRecipe): string {
  return ingredientLinesText(extracted.ingredients)
}

function stepsText(extracted: ExtractedRecipe): string {
  return stepLinesText(extracted.steps)
}

function narrativeText(extracted: ExtractedRecipe): string {
  return narrativeIndexText(extracted.description, extracted.narrativeHtml)
}

/**
 * The one place that knows how a `recipes_fts` row is written.
 *
 * Delete-then-insert, never a bare insert: a re-import that only replaced the
 * base row would leave the previous extraction's terms searchable forever, and
 * a search hit that opens a recipe not containing the term is the kind of bug
 * nobody reports and everybody distrusts.
 *
 * Shared by `upsertRecipe` and `updateRecipeContent`. There are deliberately
 * no SQL triggers keeping this table in step — one function means one
 * explicit, testable sync point, and a trigger that silently stops firing is
 * far harder to notice than a function that fails a test. Two write paths do
 * not get to mean two copies of this.
 */
async function syncFtsRow(
  tx: Tx,
  recipeId: string,
  row: { title: string; ingredients: string; steps: string; notes: string; narrative: string },
): Promise<void> {
  await tx.run(sql`DELETE FROM recipes_fts WHERE recipe_id = ${recipeId}`)
  await tx.run(sql`
    INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
    VALUES (${recipeId}, ${row.title}, ${row.ingredients}, ${row.steps}, ${row.notes}, ${row.narrative})
  `)
}
```

- [ ] **Step 3: Call it from `upsertRecipe`**

In `upsertRecipe`, replace the two `await tx.run(sql\`...\`)` statements at the end (the `DELETE FROM recipes_fts` and the `INSERT INTO recipes_fts`) with a single call. Leave the `existingNote` lookup and its comment above it exactly as they are:

```ts
    await syncFtsRow(tx, recipeId, {
      title: extracted.title,
      ingredients: ingredientsText(extracted),
      steps: stepsText(extracted),
      notes: existingNote?.notes ?? '',
      narrative: narrativeText(extracted),
    })
```

- [ ] **Step 4: Run the guard tests**

Run: `npx vitest run tests/db/upsert-recipe.test.ts tests/db/fts.test.ts tests/db/search.test.ts`
Expected: PASS, with exactly the same test count as Step 1.

- [ ] **Step 5: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass.

```bash
git add src/lib/db/queries/recipes.ts
git commit -m "One function that knows how the search index is written"
```

---

### Task 4: `updateRecipeContent`

The heart of the feature.

**Files:**
- Modify: `src/lib/db/queries/recipes.ts`
- Test: `tests/db/update-recipe-content.test.ts`

**Interfaces:**
- Consumes: `syncFtsRow`, `ingredientLinesText`, `stepLinesText`, `narrativeIndexText`, `Tx` (Task 3); `SectionedLine` (Task 1); `TagAssignment` from `@/lib/taxonomy`.
- Produces:
  ```ts
  export type RecipeContentInput = {
    title: string
    description: string | null
    publisher: string | null
    author: string | null
    sourceUrl: string | null
    sourceDomain: string | null
    claimedTimeMinutes: number | null
    servings: number | null
    yieldText: string | null
    ingredients: readonly SectionedLine[]
    steps: readonly SectionedLine[]
    tags: readonly TagAssignment[]
  }

  export type UpdateContentResult =
    | { ok: true }
    | { ok: false; reason: 'not_found' | 'source_url_taken' }

  export async function updateRecipeContent(
    db: Db,
    recipeId: string,
    input: RecipeContentInput,
  ): Promise<UpdateContentResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/db/update-recipe-content.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import {
  upsertRecipe,
  updateUserFields,
  updateRecipeContent,
  searchRecipes,
  enrichStoredRecipe,
  type RecipeContentInput,
} from '@/lib/db/queries/recipes'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
let recipeId: string

function extracted(over: Partial<ExtractedRecipe> = {}): ExtractedRecipe {
  return {
    title: 'Slow-Roast Gochujang Chicken',
    description: 'A whole chicken, slow-roasted.',
    author: 'Molly Baz',
    publisher: 'Bon Appétit',
    claimedTimeMinutes: 180,
    servings: 4,
    yieldText: '4 servings',
    ingredients: [
      { position: 0, section: null, rawText: '2 Tbsp. gochujang', quantity: null, unit: null, item: null, note: null },
      { position: 1, section: null, rawText: '1 whole chicken', quantity: null, unit: null, item: null, note: null },
    ],
    steps: [{ position: 0, section: null, text: 'Roast low for three hours.' }],
    tags: [],
    heroImageUrl: null,
    narrativeHtml: '<p>It started with a chicken.</p>',
    extractionMethod: 'jsonld',
    ...over,
  }
}

/** A complete, valid edit; override just the part under test. */
function input(over: Partial<RecipeContentInput> = {}): RecipeContentInput {
  return {
    title: 'Slow-Roast Gochujang Chicken',
    description: 'A whole chicken, slow-roasted.',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    sourceUrl: 'https://example.com/gochujang',
    sourceDomain: 'example.com',
    claimedTimeMinutes: 180,
    servings: 4,
    yieldText: '4 servings',
    ingredients: [
      { section: null, text: '2 Tbsp. gochujang' },
      { section: null, text: '1 whole chicken' },
    ],
    steps: [{ section: null, text: 'Roast low for three hours.' }],
    tags: [],
    ...over,
  }
}

async function row(id: string) {
  return db.select().from(recipes).where(eq(recipes.id, id)).get()
}

async function ingredientRows(id: string) {
  return db.select().from(ingredients).where(eq(ingredients.recipeId, id)).all()
}

beforeEach(async () => {
  db = await createTestDb()
  recipeId = await upsertRecipe(db, {
    extracted: extracted(),
    sourceUrl: 'https://example.com/gochujang',
    sourceDomain: 'example.com',
  })
})

describe('updateRecipeContent', () => {
  it('reports a missing recipe rather than throwing', async () => {
    expect(await updateRecipeContent(db, 'no-such-id', input())).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('writes the recipe-level fields', async () => {
    const result = await updateRecipeContent(db, recipeId, input({
      title: 'Slow-Roast Gochujang Chicken, Corrected',
      description: 'Corrected.',
      publisher: 'Bon Appétit Magazine',
      author: 'M. Baz',
      claimedTimeMinutes: 200,
      servings: 6,
      yieldText: '6 servings',
    }))

    expect(result).toEqual({ ok: true })
    expect(await row(recipeId)).toMatchObject({
      title: 'Slow-Roast Gochujang Chicken, Corrected',
      description: 'Corrected.',
      publisher: 'Bon Appétit Magazine',
      author: 'M. Baz',
      claimedTimeMinutes: 200,
      servings: 6,
      yieldText: '6 servings',
    })
  })

  it('marks the recipe hand-edited', async () => {
    await updateRecipeContent(db, recipeId, input())
    expect((await row(recipeId))?.handEdited).toBe(true)
  })

  it('never touches the four fields nothing else can write', async () => {
    await updateUserFields(db, recipeId, {
      rating: 5,
      status: 'made_it',
      notes: 'Halve the gochujang.',
      actualTimeMinutes: 210,
    })

    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))

    expect(await row(recipeId)).toMatchObject({
      rating: 5,
      status: 'made_it',
      notes: 'Halve the gochujang.',
      actualTimeMinutes: 210,
    })
  })

  it('never moves the slug, however the title changes', async () => {
    const before = (await row(recipeId))?.slug
    await updateRecipeContent(db, recipeId, input({ title: 'A Completely Different Name' }))
    expect((await row(recipeId))?.slug).toBe(before)
  })

  it('never moves createdAt or the re-extraction plumbing', async () => {
    const before = await row(recipeId)
    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))
    const after = await row(recipeId)

    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.extractionMethod).toBe(before?.extractionMethod)
    expect(after?.enrichmentApplied).toBe(before?.enrichmentApplied)
    expect(after?.narrativeHtml).toBe(before?.narrativeHtml)
  })

  it('replaces the ingredient and step lists in order', async () => {
    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: null, text: '3 Tbsp. gochujang' },
        { section: null, text: '1 whole chicken' },
        { section: null, text: 'flaky salt' },
      ],
      steps: [
        { section: null, text: 'Salt the bird a day ahead.' },
        { section: null, text: 'Roast low for three hours.' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored.map((i) => [i.position, i.rawText])).toEqual([
      [0, '3 Tbsp. gochujang'],
      [1, '1 whole chicken'],
      [2, 'flaky salt'],
    ])

    const storedSteps = await db.select().from(steps).where(eq(steps.recipeId, recipeId)).all()
    expect(storedSteps.map((s) => [s.position, s.text])).toEqual([
      [0, 'Salt the bird a day ahead.'],
      [1, 'Roast low for three hours.'],
    ])
  })

  it('stores the section each line belongs to', async () => {
    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: 'For the sauce', text: '2 Tbsp. gochujang' },
        { section: 'For the chicken', text: '1 whole chicken' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored.map((i) => i.section)).toEqual(['For the sauce', 'For the chicken'])
  })

  it('carries parsed columns forward for lines whose text is unchanged', async () => {
    await enrichStoredRecipe(db, recipeId, {
      tags: [],
      ingredients: [
        { position: 0, quantity: 2, unit: 'Tbsp.', item: 'gochujang', note: null },
        { position: 1, quantity: 1, unit: null, item: 'chicken', note: 'whole' },
      ],
    })

    await updateRecipeContent(db, recipeId, input())

    const stored = await ingredientRows(recipeId)
    expect(stored[0]).toMatchObject({ rawText: '2 Tbsp. gochujang', quantity: 2, unit: 'Tbsp.', item: 'gochujang' })
    expect(stored[1]).toMatchObject({ rawText: '1 whole chicken', quantity: 1, item: 'chicken', note: 'whole' })
  })

  it('nulls the parsed columns on a line whose text was edited', async () => {
    await enrichStoredRecipe(db, recipeId, {
      tags: [],
      ingredients: [{ position: 0, quantity: 2, unit: 'Tbsp.', item: 'gochujang', note: null }],
    })

    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: null, text: '3 Tbsp. gochujang' },
        { section: null, text: '1 whole chicken' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored[0]).toMatchObject({
      rawText: '3 Tbsp. gochujang',
      quantity: null,
      unit: null,
      item: null,
      note: null,
    })
  })

  it('does not shift parsed quantities onto the wrong line when one is inserted at the top', async () => {
    // The trap: `enrichStoredRecipe` keys parsed columns on (recipe_id,
    // position). Without carry-forward by text, inserting a line above would
    // silently reattach "2 Tbsp." to the chicken.
    await enrichStoredRecipe(db, recipeId, {
      tags: [],
      ingredients: [
        { position: 0, quantity: 2, unit: 'Tbsp.', item: 'gochujang', note: null },
        { position: 1, quantity: 1, unit: null, item: 'chicken', note: null },
      ],
    })

    await updateRecipeContent(db, recipeId, input({
      ingredients: [
        { section: null, text: 'flaky salt' },
        { section: null, text: '2 Tbsp. gochujang' },
        { section: null, text: '1 whole chicken' },
      ],
    }))

    const stored = await ingredientRows(recipeId)
    expect(stored.map((i) => [i.rawText, i.quantity, i.item])).toEqual([
      ['flaky salt', null, null],
      ['2 Tbsp. gochujang', 2, 'gochujang'],
      ['1 whole chicken', 1, 'chicken'],
    ])
  })

  it('accepts a recipe with no ingredients and no steps', async () => {
    const result = await updateRecipeContent(db, recipeId, input({ ingredients: [], steps: [] }))

    expect(result).toEqual({ ok: true })
    expect(await ingredientRows(recipeId)).toEqual([])
  })

  it('replaces the whole tag set and stores it as the user’s', async () => {
    await db.insert(recipeTags).values([
      { recipeId, facet: 'course', value: 'main', source: 'extracted' },
      { recipeId, facet: 'cuisine', value: 'italian', source: 'notion' },
    ])

    await updateRecipeContent(db, recipeId, input({
      tags: [
        { facet: 'course', value: 'main' },
        { facet: 'cuisine', value: 'korean' },
      ],
    }))

    const stored = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)).all()
    expect(stored.map((t) => `${t.facet}:${t.value}`).sort()).toEqual(['course:main', 'cuisine:korean'])
    expect(stored.every((t) => t.source === 'user')).toBe(true)
  })

  it('removes every tag when none are submitted', async () => {
    await db.insert(recipeTags).values([{ recipeId, facet: 'course', value: 'main', source: 'extracted' }])

    await updateRecipeContent(db, recipeId, input({ tags: [] }))

    expect(await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipeId)).all()).toEqual([])
  })

  it('re-indexes for search: old terms stop matching, new ones start', async () => {
    expect(await searchRecipes(db, 'gochujang')).toContain(recipeId)

    await updateRecipeContent(db, recipeId, input({
      title: 'Slow-Roast Harissa Chicken',
      ingredients: [{ section: null, text: '2 Tbsp. harissa' }],
      steps: [{ section: null, text: 'Roast low for three hours.' }],
    }))

    expect(await searchRecipes(db, 'harissa')).toContain(recipeId)
    expect(await searchRecipes(db, 'gochujang')).not.toContain(recipeId)
  })

  it('keeps the household note searchable across a content edit', async () => {
    await updateUserFields(db, recipeId, { notes: 'Halve the gochujang.' })

    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))

    expect(await searchRecipes(db, 'halve')).toContain(recipeId)
  })

  it('keeps the narrative searchable across a content edit', async () => {
    expect(await searchRecipes(db, 'started')).toContain(recipeId)
    await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))
    expect(await searchRecipes(db, 'started')).toContain(recipeId)
  })

  it('refuses a source URL another recipe already owns, and changes nothing', async () => {
    await upsertRecipe(db, {
      extracted: extracted({ title: 'Cabbage Gratin' }),
      sourceUrl: 'https://example.com/gratin',
      sourceDomain: 'example.com',
    })

    const result = await updateRecipeContent(db, recipeId, input({
      title: 'Should Not Be Written',
      sourceUrl: 'https://example.com/gratin',
      sourceDomain: 'example.com',
    }))

    expect(result).toEqual({ ok: false, reason: 'source_url_taken' })
    expect((await row(recipeId))?.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('allows a recipe to keep the source URL it already has', async () => {
    const result = await updateRecipeContent(db, recipeId, input({ title: 'Renamed' }))
    expect(result).toEqual({ ok: true })
  })

  it('allows clearing the source URL', async () => {
    await updateRecipeContent(db, recipeId, input({ sourceUrl: null, sourceDomain: null }))
    expect(await row(recipeId)).toMatchObject({ sourceUrl: null, sourceDomain: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/update-recipe-content.test.ts`
Expected: FAIL — `updateRecipeContent` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/queries/recipes.ts`: add `ne` to the existing `drizzle-orm` import (it becomes `import { and, eq, ne, sql } from 'drizzle-orm'`), and add `import type { SectionedLine } from '@/lib/recipe-text'` beside the other type imports. Then append after `updateUserFields`:

```ts
/**
 * A recipe's own words, as a person typed them.
 *
 * `ingredients` and `steps` are the complete replacement lists, already parsed
 * out of the editor's textareas by `@/lib/recipe-text` — this function does no
 * text parsing of its own. `tags` is likewise the complete intended set.
 */
export type RecipeContentInput = {
  title: string
  description: string | null
  publisher: string | null
  author: string | null
  sourceUrl: string | null
  sourceDomain: string | null
  claimedTimeMinutes: number | null
  servings: number | null
  yieldText: string | null
  ingredients: readonly SectionedLine[]
  steps: readonly SectionedLine[]
  tags: readonly TagAssignment[]
}

export type UpdateContentResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'source_url_taken' }

/**
 * The second recipe write path: a hand-edit, as opposed to `upsertRecipe`'s
 * machine extraction.
 *
 * Deliberately not an edit mode on `upsertRecipe`. That function takes an
 * `ExtractedRecipe` and is keyed on source-URL dedupe, and its `sourceFields`
 * comment — "everything here is by definition a better read of the same
 * source" — stops being true the moment a human types into it. What the two
 * genuinely share is the search index, and that is shared as code
 * (`syncFtsRow`), not by pretending an edit is an extraction.
 *
 * Never writes `rating`, `status`, `notes` or `actualTimeMinutes` (the four
 * columns nothing can regenerate), nor `slug`, `createdAt`, `archivedHtmlKey`,
 * `sourceEncoding`, `extractionMethod` or `enrichmentApplied`. Retitling in
 * particular must not move the slug: it is a URL that may already be
 * bookmarked, and in a two-person app has very likely been texted to the other
 * person.
 *
 * Returns a result rather than throwing for the two failures a person can
 * cause — a recipe deleted in another tab, and a source URL another recipe
 * already owns — because both are messages the form has to render beside a
 * field, not stack traces.
 */
export async function updateRecipeContent(
  db: Db,
  recipeId: string,
  input: RecipeContentInput,
): Promise<UpdateContentResult> {
  return db.transaction(async (tx): Promise<UpdateContentResult> => {
    const existing = await tx
      .select({
        id: recipes.id,
        notes: recipes.notes,
        narrativeHtml: recipes.narrativeHtml,
      })
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .get()
    if (!existing) return { ok: false, reason: 'not_found' }

    // Checked rather than left to the UNIQUE constraint, so the caller gets a
    // message that names the problem instead of a driver error. The constraint
    // stays as the backstop for the race between this read and the write.
    if (input.sourceUrl !== null) {
      const clash = await tx
        .select({ id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.sourceUrl, input.sourceUrl), ne(recipes.id, recipeId)))
        .get()
      if (clash) return { ok: false, reason: 'source_url_taken' }
    }

    // Read before the delete below: these are the parsed columns being carried
    // across. First occurrence wins, so two identical lines cannot swap
    // parses.
    const previous = await tx
      .select({
        rawText: ingredients.rawText,
        quantity: ingredients.quantity,
        unit: ingredients.unit,
        item: ingredients.item,
        note: ingredients.note,
      })
      .from(ingredients)
      .where(eq(ingredients.recipeId, recipeId))
      .all()

    const parsedByText = new Map<string, (typeof previous)[number]>()
    for (const line of previous) {
      if (!parsedByText.has(line.rawText)) parsedByText.set(line.rawText, line)
    }

    await tx
      .update(recipes)
      .set({
        title: input.title,
        description: input.description,
        publisher: input.publisher,
        author: input.author,
        sourceUrl: input.sourceUrl,
        sourceDomain: input.sourceDomain,
        claimedTimeMinutes: input.claimedTimeMinutes,
        servings: input.servings,
        yieldText: input.yieldText,
        handEdited: true,
        updatedAt: new Date(),
      })
      .where(eq(recipes.id, recipeId))

    await tx.delete(ingredients).where(eq(ingredients.recipeId, recipeId))
    await tx.delete(steps).where(eq(steps.recipeId, recipeId))

    // Every tag, not just the extracted ones — unlike `upsertRecipe`, which
    // deletes only what it wrote. The editor displays the recipe's whole tag
    // set and submits the whole intended set, so what comes back *is* the
    // answer, and the rows are rewritten as `user` to put them at the top of
    // the extracted < notion < user ladder.
    await tx.delete(recipeTags).where(eq(recipeTags.recipeId, recipeId))

    // Carried by text, never by position. `enrichStoredRecipe` keys parsed
    // columns on (recipe_id, position), so a line inserted anywhere above
    // would otherwise reattach every quantity to the wrong ingredient —
    // silently, with the page still rendering perfectly. A changed line gets
    // nulls: the old parse no longer describes the new text.
    const ingredientRows = input.ingredients.map((line, position) => {
      const carried = parsedByText.get(line.text)
      return {
        recipeId,
        position,
        section: line.section,
        rawText: line.text,
        quantity: carried?.quantity ?? null,
        unit: carried?.unit ?? null,
        item: carried?.item ?? null,
        note: carried?.note ?? null,
      }
    })
    if (ingredientRows.length > 0) await tx.insert(ingredients).values(ingredientRows)

    const stepRows = input.steps.map((line, position) => ({
      recipeId,
      position,
      section: line.section,
      text: line.text,
    }))
    if (stepRows.length > 0) await tx.insert(steps).values(stepRows)

    if (input.tags.length > 0) {
      await tx.insert(recipeTags).values(
        input.tags.map((tag) => ({
          recipeId,
          facet: tag.facet,
          value: tag.value,
          source: 'user' as const,
        })),
      )
    }

    // `notes` carried from the stored row and `narrative` recomputed from the
    // *new* description plus the untouched narrative HTML. Dropping either
    // would leave text that is still stored and still displayed but no longer
    // findable.
    await syncFtsRow(tx, recipeId, {
      title: input.title,
      ingredients: ingredientLinesText(ingredientRows),
      steps: stepLinesText(stepRows),
      notes: existing.notes ?? '',
      narrative: narrativeIndexText(input.description, existing.narrativeHtml),
    })

    return { ok: true }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/update-recipe-content.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass.

```bash
git add src/lib/db/queries/recipes.ts tests/db/update-recipe-content.test.ts
git commit -m "A second way a recipe can change: because we said so"
```

---

### Task 5: The save action

**Files:**
- Create: `src/app/(app)/recipes/[slug]/edit/actions.ts`
- Test: `tests/app/recipe-edit-action.test.ts`

**Interfaces:**
- Consumes: `updateRecipeContent`, `RecipeContentInput` (Task 4); `parseSectionedLines` (Task 1); `normalizeSourceUrl` from `@/lib/url`; `normalizeTag`, `isValidTag`, `FACETS`, type `Facet`, `TagAssignment` from `@/lib/taxonomy`; `MAX_REASONABLE_MINUTES` from `@/lib/extract/duration`; `auth` from `@/lib/auth`.
- Produces:
  ```ts
  export type EditFormValues = {
    title: string; description: string; publisher: string; author: string
    sourceUrl: string; claimedTimeMinutes: string; servings: string; yieldText: string
    ingredients: string; steps: string
    vocabularyTags: string[]   // "facet:value"
    freeTags: string
  }

  export type EditFormState = {
    message: string
    fieldErrors: Partial<Record<keyof EditFormValues, string>>
    values: EditFormValues
  } | null

  // NOTE: `saveRecipeEdits` is the ONLY function this module may export. A
  // `'use server'` file is restricted to async function exports; a sync helper
  // like `readEditFormValues` must stay module-private or the build fails.
  // Type exports are erased and therefore fine.
  export async function saveRecipeEdits(
    target: { id: string; slug: string },
    _prev: EditFormState,
    formData: FormData,
  ): Promise<EditFormState>
  ```
  On success `saveRecipeEdits` never returns — it calls `redirect()`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/recipe-edit-action.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateRecipeContent: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/recipes')>()
  return { ...actual, updateRecipeContent: mocks.updateRecipeContent }
})
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

const { saveRecipeEdits } = await import('@/app/(app)/recipes/[slug]/edit/actions')

const TARGET = { id: 'r1', slug: 'gochujang-chicken' }

/** A complete, valid submission; override just the part under test. */
function form(over: Record<string, string | string[]> = {}): FormData {
  const base: Record<string, string | string[]> = {
    title: 'Slow-Roast Gochujang Chicken',
    description: 'A whole chicken.',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    sourceUrl: 'https://www.bonappetit.com/recipe/gochujang-chicken',
    claimedTimeMinutes: '180',
    servings: '4',
    yieldText: '4 servings',
    ingredients: '2 Tbsp. gochujang\n1 whole chicken',
    steps: 'Roast low for three hours.',
    tag: [],
    freeTags: '',
    ...over,
  }

  const data = new FormData()
  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) for (const v of value) data.append(key, v)
    else data.set(key, value)
  }
  return data
}

/** Runs the action, turning the redirect throw back into a value. */
async function run(data: FormData) {
  try {
    return { state: await saveRecipeEdits(TARGET, null, data), redirected: null as string | null }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('NEXT_REDIRECT:')) {
      return { state: null, redirected: message.slice('NEXT_REDIRECT:'.length) }
    }
    throw error
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.updateRecipeContent.mockResolvedValue({ ok: true })
})

describe('saveRecipeEdits', () => {
  it('refuses an unauthenticated save and writes nothing', async () => {
    mocks.auth.mockResolvedValue(null)

    const { state } = await run(form())

    expect(state?.message).toMatch(/signed in/i)
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('passes the parsed recipe through to the query layer', async () => {
    await run(form())

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        title: 'Slow-Roast Gochujang Chicken',
        claimedTimeMinutes: 180,
        servings: 4,
        ingredients: [
          { section: null, text: '2 Tbsp. gochujang' },
          { section: null, text: '1 whole chicken' },
        ],
        steps: [{ section: null, text: 'Roast low for three hours.' }],
      }),
    )
  })

  it('redirects to the recipe on success', async () => {
    const { redirected } = await run(form())
    expect(redirected).toBe('/recipes/gochujang-chicken')
  })

  it('applies colon section headers to the lines beneath them', async () => {
    await run(form({ ingredients: 'For the sauce:\n2 Tbsp. gochujang' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        ingredients: [{ section: 'For the sauce', text: '2 Tbsp. gochujang' }],
      }),
    )
  })

  it('rejects an empty title and hands back everything that was typed', async () => {
    const { state } = await run(form({ title: '   ', steps: 'Do not lose me.' }))

    expect(state?.fieldErrors.title).toMatch(/title/i)
    expect(state?.values.steps).toBe('Do not lose me.')
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('normalizes the source URL and derives the domain from it', async () => {
    await run(form({ sourceUrl: 'https://www.bonappetit.com/recipe/x?utm_source=news' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        sourceUrl: 'https://bonappetit.com/recipe/x',
        sourceDomain: 'bonappetit.com',
      }),
    )
  })

  it('stores an empty source URL as no source at all', async () => {
    await run(form({ sourceUrl: '  ' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ sourceUrl: null, sourceDomain: null }),
    )
  })

  it('rejects a source URL that is not one', async () => {
    const { state } = await run(form({ sourceUrl: 'not a url' }))

    expect(state?.fieldErrors.sourceUrl).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('names the collision when another recipe owns that source URL', async () => {
    mocks.updateRecipeContent.mockResolvedValue({ ok: false, reason: 'source_url_taken' })

    const { state } = await run(form())

    expect(state?.fieldErrors.sourceUrl).toMatch(/another recipe/i)
    expect(state?.values.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('rejects a non-numeric time without losing the rest of the form', async () => {
    const { state } = await run(form({ claimedTimeMinutes: 'about an hour' }))

    expect(state?.fieldErrors.claimedTimeMinutes).toBeTruthy()
    expect(state?.values.ingredients).toBe('2 Tbsp. gochujang\n1 whole chicken')
  })

  it('rejects a time beyond the ceiling the extractor uses', async () => {
    const { state } = await run(form({ claimedTimeMinutes: '99999999' }))
    expect(state?.fieldErrors.claimedTimeMinutes).toBeTruthy()
  })

  it('rejects zero servings, which is a typo rather than a quantity', async () => {
    const { state } = await run(form({ servings: '0' }))
    expect(state?.fieldErrors.servings).toBeTruthy()
  })

  it('treats blank numbers as absent rather than zero', async () => {
    await run(form({ claimedTimeMinutes: '', servings: '' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ claimedTimeMinutes: null, servings: null }),
    )
  })

  it('accepts checked vocabulary tags', async () => {
    await run(form({ tag: ['course:main', 'cuisine:korean'] }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        tags: [
          { facet: 'course', value: 'main' },
          { facet: 'cuisine', value: 'korean' },
        ],
      }),
    )
  })

  it('rejects a tag outside the vocabulary rather than dropping it silently', async () => {
    const { state } = await run(form({ tag: ['course:brunchy'] }))

    expect(state?.fieldErrors.vocabularyTags).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('routes a free-form entry into its proper facet when the taxonomy knows it', async () => {
    await run(form({ freeTags: 'Thanksgiving' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'tag', value: 'holiday' }] }),
    )
  })

  it('keeps an unrecognized free-form entry as a kebab-cased open tag', async () => {
    await run(form({ freeTags: 'Kid Approved, ' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'tag', value: 'kid-approved' }] }),
    )
  })

  it('does not store the same tag twice when a chip and a typed tag agree', async () => {
    await run(form({ tag: ['course:dessert'], freeTags: 'dessert' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'course', value: 'dessert' }] }),
    )
  })

  it('reports a recipe that vanished while the form was open', async () => {
    mocks.updateRecipeContent.mockResolvedValue({ ok: false, reason: 'not_found' })

    const { state } = await run(form())

    expect(state?.message).toMatch(/no longer/i)
  })

  it('rejects more lines than a recipe could plausibly have', async () => {
    const { state } = await run(form({ ingredients: Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n') }))
    expect(state?.fieldErrors.ingredients).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/recipe-edit-action.test.ts`
Expected: FAIL — cannot resolve `@/app/(app)/recipes/[slug]/edit/actions`.

- [ ] **Step 3: Write the implementation**

Create `src/app/(app)/recipes/[slug]/edit/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { updateRecipeContent, type RecipeContentInput } from '@/lib/db/queries/recipes'
import { MAX_REASONABLE_MINUTES } from '@/lib/extract/duration'
import { parseSectionedLines } from '@/lib/recipe-text'
import { FACETS, isValidTag, normalizeTag, type Facet, type TagAssignment } from '@/lib/taxonomy'
import { normalizeSourceUrl } from '@/lib/url'

/**
 * Saving a hand-edited recipe.
 *
 * A Server Action rather than a JSON route, and the choice is about failure,
 * not style: this form can hold a recipe someone typed out of a family
 * cookbook, and a native form post plus `useActionState` keeps every character
 * on screen when a save is rejected. Every rejection below therefore returns
 * the submitted values verbatim — the form re-renders from `values`, not from
 * the database.
 *
 * `values` are raw strings throughout, exactly as they left the inputs. They
 * are the user's text, not a parse of it; converting them for echo would mean
 * a rejected "about an hour" came back as an empty box.
 */

const MAX_LINES = 500
const MAX_LINE_LENGTH = 1_000
const MAX_FREE_TAGS = 20
const MAX_FREE_TAG_LENGTH = 40

export type EditFormValues = {
  title: string
  description: string
  publisher: string
  author: string
  sourceUrl: string
  claimedTimeMinutes: string
  servings: string
  yieldText: string
  ingredients: string
  steps: string
  /** Checked chips, each `"facet:value"`. */
  vocabularyTags: string[]
  /** The open `tag` facet, comma-separated. */
  freeTags: string
}

export type EditFormState = {
  /** A whole-form problem. Empty when every problem is field-specific. */
  message: string
  fieldErrors: Partial<Record<keyof EditFormValues, string>>
  values: EditFormValues
} | null

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The submission as typed.
 *
 * Module-private, and it has to be: a `'use server'` file may export only
 * async functions, so a sync helper exported from here fails the build. The
 * form and this function agree on field names by convention, and the action
 * tests are what hold them together.
 */
function readEditFormValues(formData: FormData): EditFormValues {
  return {
    title: text(formData.get('title')),
    description: text(formData.get('description')),
    publisher: text(formData.get('publisher')),
    author: text(formData.get('author')),
    sourceUrl: text(formData.get('sourceUrl')),
    claimedTimeMinutes: text(formData.get('claimedTimeMinutes')),
    servings: text(formData.get('servings')),
    yieldText: text(formData.get('yieldText')),
    ingredients: text(formData.get('ingredients')),
    steps: text(formData.get('steps')),
    vocabularyTags: formData.getAll('tag').map(text),
    freeTags: text(formData.get('freeTags')),
  }
}

/** Trimmed, or null for empty — the schema spells "absent" as NULL, never `''`. */
function optional(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

type NumberResult = { ok: true; value: number | null } | { ok: false; error: string }

/**
 * Whole non-negative minutes or count, or null for blank. Parsed by regex
 * rather than `Number()`, which cheerfully accepts `"1e3"`, `" 12 "`, and
 * `"0x10"` — none of which a person means when they type a cook time.
 */
function wholeNumber(raw: string, max: number, label: string): NumberResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `Give the ${label} as a whole number, or leave it blank.` }
  }
  const value = Number(trimmed)
  if (value > max) return { ok: false, error: `That ${label} is implausibly large.` }
  return { ok: true, value }
}

/** `"course:main"` back into a tag, or null if it is not that shape. */
function parseChip(raw: string): TagAssignment | null {
  const separator = raw.indexOf(':')
  if (separator <= 0) return null
  const facet = raw.slice(0, separator)
  const value = raw.slice(separator + 1)
  if (!FACETS.includes(facet as Facet)) return null
  const tag = { facet: facet as Facet, value }
  return isValidTag(tag) ? tag : null
}

/**
 * A typed entry into a tag. `normalizeTag` gets first refusal, so "Thanksgiving"
 * lands as `tag:holiday` and "Soups" as `tag:soup` rather than as two new
 * free-form values meaning what an existing one already means. Anything it
 * does not recognize becomes a kebab-cased open tag, matching the shape of the
 * `tag`-facet values already in the library (`meal-prep`, `sheet-pan`).
 */
function parseFreeTag(raw: string): TagAssignment | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const known = normalizeTag(trimmed)
  if (known) return known

  const value = trimmed.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  return value.length > 0 ? { facet: 'tag', value } : null
}

export async function saveRecipeEdits(
  target: { id: string; slug: string },
  _prev: EditFormState,
  formData: FormData,
): Promise<EditFormState> {
  const values = readEditFormValues(formData)
  const fail = (
    fieldErrors: Partial<Record<keyof EditFormValues, string>>,
    message = '',
  ): EditFormState => ({ message, fieldErrors, values })

  // The route is already behind `proxy.ts`, but a Server Action is a POST
  // endpoint of its own and every other write path in this app checks for
  // itself.
  const session = await auth()
  if (!session?.user) {
    return fail({}, 'You need to be signed in to save. Nothing was lost — try signing in again.')
  }

  const fieldErrors: Partial<Record<keyof EditFormValues, string>> = {}

  const title = values.title.trim()
  if (title.length === 0) fieldErrors.title = 'A title is required.'
  else if (title.length > 300) fieldErrors.title = 'That title is too long.'

  if (values.description.length > 5_000) fieldErrors.description = 'That description is too long.'
  if (values.publisher.trim().length > 200) fieldErrors.publisher = 'That publisher name is too long.'
  if (values.author.trim().length > 200) fieldErrors.author = 'That author name is too long.'
  if (values.yieldText.trim().length > 200) fieldErrors.yieldText = 'That yield is too long.'

  let sourceUrl: string | null = null
  let sourceDomain: string | null = null
  if (values.sourceUrl.trim() !== '') {
    try {
      const normalized = normalizeSourceUrl(values.sourceUrl)
      sourceUrl = normalized.url
      sourceDomain = normalized.domain
    } catch {
      fieldErrors.sourceUrl = "That doesn't look like a web address."
    }
  }

  const time = wholeNumber(values.claimedTimeMinutes, MAX_REASONABLE_MINUTES, 'time')
  if (!time.ok) fieldErrors.claimedTimeMinutes = time.error

  const servings = wholeNumber(values.servings, 1_000, 'servings')
  if (!servings.ok) fieldErrors.servings = servings.error
  // Zero servings is not a smaller number of servings, it is a typo. `null` is
  // how "we don't know" is spelled, and the recipe page's `servingsLabel`
  // renders a stored 0 as the nonsense "0 servings".
  else if (servings.value === 0) fieldErrors.servings = 'Give a number of servings, or leave it blank.'

  const ingredientLines = parseSectionedLines(values.ingredients)
  if (ingredientLines.length > MAX_LINES) {
    fieldErrors.ingredients = `That's more than ${MAX_LINES} ingredients — is something pasted twice?`
  } else if (ingredientLines.some((line) => line.text.length > MAX_LINE_LENGTH)) {
    fieldErrors.ingredients = 'One of those lines is far too long to be an ingredient.'
  }

  const stepLines = parseSectionedLines(values.steps)
  if (stepLines.length > MAX_LINES) {
    fieldErrors.steps = `That's more than ${MAX_LINES} steps — is something pasted twice?`
  } else if (stepLines.some((line) => line.text.length > MAX_LINE_LENGTH)) {
    fieldErrors.steps = 'One of those steps is far too long.'
  }

  // Deduped by `facet:value`, first writer winning, so a chip and a typed tag
  // that agree produce one row rather than a UNIQUE violation.
  const tags: TagAssignment[] = []
  const seen = new Set<string>()
  const addTag = (tag: TagAssignment) => {
    const id = `${tag.facet}:${tag.value}`
    if (seen.has(id)) return
    seen.add(id)
    tags.push(tag)
  }

  for (const chip of values.vocabularyTags) {
    const tag = parseChip(chip)
    // Rejected, not dropped: a checked box that silently fails to save is a
    // tag someone believes is on the recipe and is not.
    if (!tag) {
      fieldErrors.vocabularyTags = 'One of those tags is not one this library knows. Try again.'
      break
    }
    addTag(tag)
  }

  const freeEntries = values.freeTags.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (freeEntries.length > MAX_FREE_TAGS) {
    fieldErrors.freeTags = `That's more than ${MAX_FREE_TAGS} tags.`
  } else if (freeEntries.some((entry) => entry.length > MAX_FREE_TAG_LENGTH)) {
    fieldErrors.freeTags = 'One of those tags is too long.'
  } else {
    for (const entry of freeEntries) {
      const tag = parseFreeTag(entry)
      if (tag) addTag(tag)
    }
  }

  if (Object.keys(fieldErrors).length > 0) return fail(fieldErrors)

  const content: RecipeContentInput = {
    title,
    description: optional(values.description),
    publisher: optional(values.publisher),
    author: optional(values.author),
    sourceUrl,
    sourceDomain,
    claimedTimeMinutes: time.ok ? time.value : null,
    servings: servings.ok ? servings.value : null,
    yieldText: optional(values.yieldText),
    ingredients: ingredientLines,
    steps: stepLines,
    tags,
  }

  const result = await updateRecipeContent(db, target.id, content)

  if (!result.ok) {
    if (result.reason === 'source_url_taken') {
      return fail({ sourceUrl: 'Another recipe in the library already has that source URL.' })
    }
    return fail({}, 'That recipe is no longer in the library. Your edits are still here — copy anything you need.')
  }

  revalidatePath(`/recipes/${target.slug}`)
  redirect(`/recipes/${target.slug}`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app/recipe-edit-action.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass.

```bash
git add "src/app/(app)/recipes/[slug]/edit/actions.ts" tests/app/recipe-edit-action.test.ts
git commit -m "Refuse the edit, keep the typing"
```

---

### Task 6: The form and the edit page

**Files:**
- Create: `src/components/recipe/recipe-edit-form.tsx`
- Create: `src/app/(app)/recipes/[slug]/edit/page.tsx`
- Test: `tests/components/recipe-edit-form.test.tsx`

**Interfaces:**
- Consumes: `EditFormState`, `EditFormValues`, `saveRecipeEdits` (Task 5); `renderSectionedLines` (Task 1); `RecipeDetail` from `@/lib/db/queries/recipe-detail`; `VOCABULARY`, `FACETS` from `@/lib/taxonomy`.
- Produces:
  ```ts
  export function initialEditValues(recipe: RecipeDetail): EditFormValues
  export function RecipeEditForm(props: {
    recipe: RecipeDetail
    action: (prev: EditFormState, formData: FormData) => Promise<EditFormState>
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/components/recipe-edit-form.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { RecipeEditForm, initialEditValues } from '@/components/recipe/recipe-edit-form'
import type { EditFormState } from '@/app/(app)/recipes/[slug]/edit/actions'

afterEach(cleanup)

function recipe(over: Partial<RecipeDetail> = {}): RecipeDetail {
  return {
    id: 'r1',
    slug: 'gochujang-chicken',
    title: 'Slow-Roast Gochujang Chicken',
    sourceUrl: 'https://bonappetit.com/recipe/gochujang-chicken',
    sourceDomain: 'bonappetit.com',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    description: 'A whole chicken.',
    claimedTimeMinutes: 180,
    actualTimeMinutes: null,
    servings: 4,
    yieldText: '4 servings',
    rating: null,
    status: null,
    notes: null,
    narrativeHtml: null,
    extractionMethod: 'jsonld',
    handEdited: false,
    createdAt: new Date('2026-01-01'),
    ingredients: [
      { position: 0, section: 'For the sauce', rawText: '2 Tbsp. gochujang', quantity: null, unit: null, item: null, note: null },
      { position: 1, section: 'For the chicken', rawText: '1 whole chicken', quantity: null, unit: null, item: null, note: null },
    ],
    steps: [{ position: 0, section: null, text: 'Roast low for three hours.' }],
    tags: [
      { facet: 'course', value: 'main' },
      { facet: 'tag', value: 'holiday' },
    ],
    images: [],
    ...over,
  }
}

const noop = async (): Promise<EditFormState> => null

function renderForm(over: Partial<RecipeDetail> = {}) {
  return render(<RecipeEditForm recipe={recipe(over)} action={noop} />)
}

describe('initialEditValues', () => {
  it('renders ingredients back into text with their section headers', () => {
    expect(initialEditValues(recipe()).ingredients).toBe(
      'For the sauce:\n2 Tbsp. gochujang\n\nFor the chicken:\n1 whole chicken',
    )
  })

  it('spells an absent number as an empty box, never as a zero', () => {
    const values = initialEditValues(recipe({ claimedTimeMinutes: null, servings: null }))
    expect(values.claimedTimeMinutes).toBe('')
    expect(values.servings).toBe('')
  })

  it('lists the free-form tags, and only those, in the free-text field', () => {
    expect(initialEditValues(recipe()).freeTags).toBe('holiday')
  })

  it('lists the vocabulary tags as chip ids', () => {
    expect(initialEditValues(recipe()).vocabularyTags).toEqual(['course:main'])
  })
})

describe('RecipeEditForm', () => {
  it('opens with the recipe already in the fields', () => {
    renderForm()

    expect(screen.getByLabelText(/^title$/i)).toHaveValue('Slow-Roast Gochujang Chicken')
    expect(screen.getByLabelText(/publisher/i)).toHaveValue('Bon Appétit')
    expect(screen.getByLabelText(/how long it claims/i)).toHaveValue('180')
    expect(screen.getByLabelText(/ingredients/i)).toHaveValue(
      'For the sauce:\n2 Tbsp. gochujang\n\nFor the chicken:\n1 whole chicken',
    )
  })

  it('checks the chips the recipe already carries and leaves the rest alone', () => {
    renderForm()

    expect(screen.getByRole('checkbox', { name: 'main' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'dessert' })).not.toBeChecked()
  })

  it('groups the chips by facet so the vocabulary is visible', () => {
    renderForm()

    for (const legend of ['Course', 'Ingredient', 'Method', 'Cuisine']) {
      expect(screen.getByRole('group', { name: legend })).toBeInTheDocument()
    }
  })

  it('offers a way back that does not save', () => {
    renderForm()
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute(
      'href',
      '/recipes/gochujang-chicken',
    )
  })

  it('has no field for the narrative — that is not editable here', () => {
    renderForm()
    expect(screen.queryByLabelText(/narrative/i)).not.toBeInTheDocument()
  })

  it('renders an empty recipe without inventing content', () => {
    renderForm({ ingredients: [], steps: [], tags: [], description: null })

    expect(screen.getByLabelText(/ingredients/i)).toHaveValue('')
    expect(screen.getByLabelText(/steps/i)).toHaveValue('')
  })
})

describe('RecipeEditForm, after a rejected save', () => {
  // `useActionState` returns the initial state on first render, so the
  // rejected-state rendering is asserted through the same path the action
  // returns: a state whose values differ from the recipe's stored ones.
  it('shows a field error and keeps what was typed', async () => {
    const rejected: EditFormState = {
      message: '',
      fieldErrors: { title: 'A title is required.' },
      values: { ...initialEditValues(recipe()), title: '', steps: 'Do not lose me.' },
    }
    const action = vi.fn(async () => rejected)

    render(<RecipeEditForm recipe={recipe()} action={action} initialState={rejected} />)

    expect(screen.getByText('A title is required.')).toBeInTheDocument()
    expect(screen.getByLabelText(/^steps$/i)).toHaveValue('Do not lose me.')
  })

  it('shows a whole-form message when there is one', () => {
    const rejected: EditFormState = {
      message: 'That recipe is no longer in the library.',
      fieldErrors: {},
      values: initialEditValues(recipe()),
    }

    render(<RecipeEditForm recipe={recipe()} action={noop} initialState={rejected} />)

    expect(screen.getByRole('alert')).toHaveTextContent('no longer in the library')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/recipe-edit-form.test.tsx`
Expected: FAIL — cannot resolve `@/components/recipe/recipe-edit-form`.

- [ ] **Step 3: Write the form component**

Create `src/components/recipe/recipe-edit-form.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useActionState, useEffect, useState } from 'react'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { renderSectionedLines } from '@/lib/recipe-text'
import { FACETS, VOCABULARY, type Facet } from '@/lib/taxonomy'
import type { EditFormState, EditFormValues } from '@/app/(app)/recipes/[slug]/edit/actions'

/**
 * The recipe editor.
 *
 * A client component for exactly two reasons — `useActionState`, so a rejected
 * save re-renders with every character still in place, and the unload guard
 * below. Everything else is a plain form: the tag chips are checkboxes, the
 * lists are textareas, and the submit is a native form post to a Server
 * Action. The recipe *page* still ships almost no JavaScript; this is a
 * separate route precisely so it stays that way.
 *
 * Values come from `state.values` when there is a state and from the stored
 * recipe otherwise, so a rejection redisplays what was typed rather than what
 * is in the database — the difference between losing a hand-typed ingredient
 * list and not.
 */

const FACET_LABELS: Record<Exclude<Facet, 'tag'>, string> = {
  course: 'Course',
  ingredient: 'Ingredient',
  method: 'Method',
  cuisine: 'Cuisine',
}

const VOCABULARY_FACETS = FACETS.filter((facet): facet is Exclude<Facet, 'tag'> => facet !== 'tag')

/** The stored recipe as form values. Numbers become empty strings, not zeros. */
export function initialEditValues(recipe: RecipeDetail): EditFormValues {
  return {
    title: recipe.title,
    description: recipe.description ?? '',
    publisher: recipe.publisher ?? '',
    author: recipe.author ?? '',
    sourceUrl: recipe.sourceUrl ?? '',
    claimedTimeMinutes: recipe.claimedTimeMinutes === null ? '' : String(recipe.claimedTimeMinutes),
    servings: recipe.servings === null ? '' : String(recipe.servings),
    yieldText: recipe.yieldText ?? '',
    ingredients: renderSectionedLines(
      recipe.ingredients.map((i) => ({ section: i.section, text: i.rawText })),
    ),
    steps: renderSectionedLines(recipe.steps.map((s) => ({ section: s.section, text: s.text }))),
    vocabularyTags: recipe.tags
      .filter((tag) => tag.facet !== 'tag')
      .map((tag) => `${tag.facet}:${tag.value}`),
    // Pre-filled, and that is load-bearing: the save replaces the tag set
    // wholesale, so an empty box would silently delete every free-form tag on
    // every save.
    freeTags: recipe.tags.filter((tag) => tag.facet === 'tag').map((tag) => tag.value).join(', '),
  }
}

const inputClass =
  'w-full rounded-md border border-black/15 bg-white px-3 py-2 text-base sm:text-sm dark:border-white/20 dark:bg-neutral-900'

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null
  return <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>
}

export function RecipeEditForm({
  recipe,
  action,
  initialState = null,
}: {
  recipe: RecipeDetail
  action: (prev: EditFormState, formData: FormData) => Promise<EditFormState>
  /** Test seam: the state a rejected save would have produced. */
  initialState?: EditFormState
}) {
  const [state, formAction, pending] = useActionState(action, initialState)
  const stored = initialEditValues(recipe)
  const values = state?.values ?? stored
  const errors = state?.fieldErrors ?? {}
  const checked = new Set(values.vocabularyTags)

  // Every field is uncontrolled, with `defaultValue` read from `values`. React
  // resets an uncontrolled form after a form action completes, so a rejected
  // save re-renders with `state.values` as the new defaults and the reset
  // lands them in the boxes — the typing survives without a controlled-input
  // state tree for twelve fields.
  const [dirty, setDirty] = useState(false)

  // A close or reload mid-edit loses a hand-typed ingredient list, which is
  // not recoverable from anywhere. Same guard as the notes panel on the recipe
  // page; like that one it cannot catch an in-app navigation, which is why
  // Cancel is an explicit link rather than the only way out.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty || pending) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, pending])

  return (
    <form
      action={formAction}
      onChange={() => setDirty(true)}
      className="flex flex-col gap-5"
    >
      {state?.message && (
        <p
          role="alert"
          className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950/60 dark:text-red-200"
        >
          {state.message}
        </p>
      )}

      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-medium">Title</label>
        <input id="title" name="title" type="text" defaultValue={values.title} className={inputClass} />
        <FieldError message={errors.title} />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">Description</label>
        <textarea id="description" name="description" rows={2} defaultValue={values.description} className={inputClass} />
        <FieldError message={errors.description} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="publisher" className="mb-1 block text-sm font-medium">Publisher</label>
          <input id="publisher" name="publisher" type="text" defaultValue={values.publisher} className={inputClass} />
          <FieldError message={errors.publisher} />
        </div>
        <div>
          <label htmlFor="author" className="mb-1 block text-sm font-medium">Author</label>
          <input id="author" name="author" type="text" defaultValue={values.author} className={inputClass} />
          <FieldError message={errors.author} />
        </div>
      </div>

      <div>
        <label htmlFor="sourceUrl" className="mb-1 block text-sm font-medium">Source URL</label>
        <input id="sourceUrl" name="sourceUrl" type="text" inputMode="url" defaultValue={values.sourceUrl} className={inputClass} />
        <FieldError message={errors.sourceUrl} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="claimedTimeMinutes" className="mb-1 block text-sm font-medium">
            How long it claims to take
          </label>
          <input
            id="claimedTimeMinutes"
            name="claimedTimeMinutes"
            type="text"
            inputMode="numeric"
            defaultValue={values.claimedTimeMinutes}
            className={inputClass}
          />
          <FieldError message={errors.claimedTimeMinutes} />
        </div>
        <div>
          <label htmlFor="servings" className="mb-1 block text-sm font-medium">Servings</label>
          <input id="servings" name="servings" type="text" inputMode="numeric" defaultValue={values.servings} className={inputClass} />
          <FieldError message={errors.servings} />
        </div>
        <div>
          <label htmlFor="yieldText" className="mb-1 block text-sm font-medium">Yield</label>
          <input id="yieldText" name="yieldText" type="text" defaultValue={values.yieldText} className={inputClass} />
          <FieldError message={errors.yieldText} />
        </div>
      </div>

      <div>
        <label htmlFor="ingredients" className="mb-1 block text-sm font-medium">Ingredients</label>
        <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
          One per line, saved exactly as typed. A line ending in a colon — “For the sauce:” —
          becomes a heading for the lines under it.
        </p>
        <textarea id="ingredients" name="ingredients" rows={12} defaultValue={values.ingredients} className={`${inputClass} font-mono`} />
        <FieldError message={errors.ingredients} />
      </div>

      <div>
        <label htmlFor="steps" className="mb-1 block text-sm font-medium">Steps</label>
        <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
          One per line. Headings work here too.
        </p>
        <textarea id="steps" name="steps" rows={12} defaultValue={values.steps} className={inputClass} />
        <FieldError message={errors.steps} />
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Tags</h2>
        {VOCABULARY_FACETS.map((facet) => (
          <fieldset key={facet}>
            <legend className="mb-1 text-xs font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
              {FACET_LABELS[facet]}
            </legend>
            <div className="flex flex-wrap gap-1">
              {VOCABULARY[facet].map((value) => {
                const id = `${facet}:${value}`
                return (
                  <label
                    key={id}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-black/15 px-3 text-sm has-checked:bg-neutral-800 has-checked:text-white dark:border-white/20 dark:has-checked:bg-neutral-100 dark:has-checked:text-neutral-900"
                  >
                    <input type="checkbox" name="tag" value={id} defaultChecked={checked.has(id)} className="size-4" />
                    {value}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
        <FieldError message={errors.vocabularyTags} />

        <div>
          <label htmlFor="freeTags" className="mb-1 block text-sm font-medium">Other tags</label>
          <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
            Comma-separated. Anything the library already recognizes is filed under its own facet.
          </p>
          <input id="freeTags" name="freeTags" type="text" defaultValue={values.freeTags} className={inputClass} />
          <FieldError message={errors.freeTags} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-md bg-neutral-800 px-4 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? 'Saving…' : 'Save recipe'}
        </button>
        <Link
          href={`/recipes/${recipe.slug}`}
          className="inline-flex min-h-11 items-center px-2 text-sm text-neutral-600 underline underline-offset-2 dark:text-neutral-300"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/components/recipe-edit-form.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the page**

Create `src/app/(app)/recipes/[slug]/edit/page.tsx`:

```tsx
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
```

- [ ] **Step 6: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass.

```bash
git add src/components/recipe/recipe-edit-form.tsx "src/app/(app)/recipes/[slug]/edit/page.tsx" tests/components/recipe-edit-form.test.tsx
git commit -m "A page for fixing what a recipe says"
```

---

### Task 7: The way in, and the mark it leaves

**Files:**
- Modify: `src/components/recipe/recipe-view.tsx`
- Test: `tests/components/recipe-page.test.tsx`

**Interfaces:**
- Consumes: `RecipeDetail.handEdited` (Task 2), the `/recipes/[slug]/edit` route (Task 6).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

First, `tests/components/recipe-page.test.tsx` has a `recipe(overrides)` factory at line 58 that predates Task 2's field. Add `handEdited: false` to its defaults — TypeScript requires it now, and every other test in the file depends on that factory compiling.

Then append a new top-level `describe` to the same file. It renders through `render(<RecipeView recipe={recipe()} />)`, the pattern every other block in the file uses. The factory's slug is `gochujang-chicken`:

```tsx
describe('editing a recipe', () => {
  it('offers a way in to the editor', () => {
    render(<RecipeView recipe={recipe()} />)

    expect(screen.getByRole('link', { name: /^edit$/i })).toHaveAttribute(
      'href',
      '/recipes/gochujang-chicken/edit',
    )
  })

  it('offers it even on a recipe with no publisher, author or source', () => {
    // Four migrated recipes have no source at all, and the attribution line
    // they share the header with renders only when one of those three exists.
    // The way in must not be inside it.
    render(
      <RecipeView
        recipe={recipe({ publisher: null, author: null, sourceUrl: null, sourceDomain: null })}
      />,
    )

    expect(screen.getByRole('link', { name: /^edit$/i })).toBeInTheDocument()
  })

  it('says nothing about hand-editing for a recipe nobody has touched', () => {
    render(<RecipeView recipe={recipe({ handEdited: false })} />)

    expect(screen.queryByText(/edited by hand/i)).not.toBeInTheDocument()
  })

  it('marks a recipe someone has corrected', () => {
    render(<RecipeView recipe={recipe({ handEdited: true })} />)

    expect(screen.getByText(/edited by hand/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/recipe-page.test.tsx`
Expected: FAIL — no Edit link, no marker.

- [ ] **Step 3: Add the link and the marker**

In `src/components/recipe/recipe-view.tsx`, add `import Link from 'next/link'` beside the existing `import Image from 'next/image'`.

The attribution `<p>` in the header is wrapped in `{(recipe.publisher || recipe.author || recipe.sourceUrl) && (...)}`. **Do not put the edit link inside it** — a recipe with none of those three (four migrated recipes have no source at all) would then have no way into the editor. Add a new, unconditional row immediately *after* that closing `)}` and before the `{recipe.description && (` block:

```tsx
          {/* Its own row rather than a sibling inside the attribution line
              above: that line renders only when a publisher, author or source
              exists, and the recipes most likely to need correcting are
              exactly the sparse ones that have none of them. */}
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
            <Link
              href={`/recipes/${recipe.slug}/edit`}
              className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              Edit
            </Link>
            {recipe.handEdited && (
              // The counterpart to the warning a re-import will show: a recipe
              // carrying corrections nothing can regenerate should say so,
              // where the rest of its provenance is already stated.
              <span>Edited by hand</span>
            )}
          </p>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/components/recipe-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`
Expected: all pass.

```bash
git add src/components/recipe/recipe-view.tsx tests/components/recipe-page.test.tsx
git commit -m "A door into the editor, and a mark on the way out"
```

- [ ] **Step 6: Apply the migration to the real database**

Run: `npm run db:migrate`
Expected: `0004_*` applied. This is the only step in the plan that touches the developer's actual database; every test migrates a throwaway one.

---

## Verification

After Task 7, confirm the whole feature end to end:

- [ ] `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts` — all green.
- [ ] `npm run dev`, open a recipe, click Edit, change the title and an ingredient line, save. The recipe page shows both changes, the URL is unchanged, and "Edited by hand" appears.
- [ ] Search for a word only in the old title. It should not return the recipe. Search for a word only in the new one. It should.
- [ ] Re-open the editor. Every field, chip, and free-form tag reflects what was saved.
