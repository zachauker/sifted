# In-App Recipe Editing — Design

**Date:** 2026-08-29
**Status:** Approved, ready for implementation planning

## Problem

Everything a person can do to a recipe *after* it lands in the library is
either a CLI script or nothing at all. The app can write exactly four fields —
rating, status, notes, and measured time — through `EditControls` and
`PATCH /api/recipes/[id]`. Every other correction requires a terminal:

- A mangled extraction (wrong title, ingredients run together, steps missing)
  can only be repaired by re-running `npm run import` and hoping the parser
  does better this time.
- Tags cannot be added or removed at all. The schema has anticipated this
  since the beginning — `recipe_tags.source` carries a `'user'` value, and
  `upsertRecipe`'s own comment refers to "soon a tag editor in the UI" — but
  nothing has ever written one.
- Images have no UI whatsoever. `images.role` likewise has a `'user'` value
  nothing writes.

Standing in a kitchen having just discovered that step 4 is missing, the
remedy should not be "open a laptop."

## Scope

This is the first of three sub-projects. It covers **editing what a recipe
says**: its own fields, its ingredient and step lists, and its tags.

Deliberately **out of scope**, each getting its own spec:

2. **Images** — upload from a phone, choose the hero, delete one. The only
   genuinely new capability in the set (nothing in this app has ever accepted
   an inbound file) and it carries its own risks: HEIC from an iPhone, request
   size, and the fact that `RecipeView` hard-prefers `source_hero`, so an
   uploaded photo could never become the hero without a rule change.
3. **Re-running the machine steps, and delete** — wiring `runImport`,
   `enrichStoredRecipe`, and `ingestHeroImage` to buttons over the existing
   `import_jobs` table, plus recipe deletion with its blob and FTS cleanup.

Also out of scope, permanently unless argued otherwise: **editing
`narrativeHtml`**. It is the one value on the page rendered through
`dangerouslySetInnerHTML`, guarded by a test that fails the build on a second
such sink. Routing hand-typed HTML through the sanitizer is a real risk, and
no bad extraction is repaired by rewriting the blog's story.

## The durability decision

`upsertRecipe` replaces a recipe's children wholesale. A re-import after a
hand-edit therefore destroys the hand-edit — the same failure the `source`
column already fixed for tags, which ingredients and steps have no equivalent
of.

**Decision: mark, then warn.** A `hand_edited` flag on the recipe. Re-import
keeps replacing content wholesale; sub-project 3 makes the UI say "this recipe
has your edits — re-importing replaces them" and require confirmation.

Rejected: per-row `source` on ingredients and steps. Interleaving hand-written
and machine-written rows by position is a merge problem with no good answer
and no good UI, for a two-person recipe library. The flag costs one column and
one confirmation dialog.

## Architecture

### Write path

A second recipe write path, `updateRecipeContent`, alongside `upsertRecipe` —
not an edit mode bolted onto it. `upsertRecipe` takes an `ExtractedRecipe` and
is keyed on source-URL dedupe; its `sourceFields` comment ("everything here is
by definition a better read of the same source") stops being true the moment a
human types into it. Dressing a hand-edit up as an extraction muddies both.

The "single write path" rule is kept in substance rather than letter: the FTS
insert is extracted into a shared `syncFtsRow` called by both functions, so
exactly one place still knows how `recipes_fts` is written. The codebase has
no triggers by deliberate choice — "one function means one explicit, testable
sync point" — and that stays true.

### Surface

A dedicated `/recipes/[slug]/edit` route, not inline editing. The recipe page
ships essentially zero application JavaScript today (uncontrolled checkboxes, a
`<details>` for the narrative, and only `EditControls` crossing the client
boundary), and that is called out as deliberate. Inline editing would end it.

The save goes through a **Server Action**, not a JSON API route — matching
`login/actions.ts` and the inline action in `(app)/layout.tsx`. A native form
post handles the data-loss case better than a `fetch` does, and the tag editor
becomes plain checkboxes with no client state at all.

## Data model

One migration, one column:

```
recipes.hand_edited  INTEGER NOT NULL DEFAULT 0   -- boolean
```

Set true by any save through the editor. Sub-project 3 reads it to gate the
re-import warning — but a flag nobody reads is a comment that costs a column
(the same criticism `enrichment_applied` earned before `listUnenrichedRecipes`
existed), so it gets a reader immediately: the recipe page's source
attribution line gains a quiet "edited by hand" marker.

`RecipeDetail` gains `handEdited` so the page can render it. No other query
changes — `getRecipeBySlug` already returns everything the form needs.

## `updateRecipeContent(db, recipeId, input)`

One transaction, in `src/lib/db/queries/recipes.ts`:

1. **Read the existing ingredient rows before deleting anything** — their
   parsed columns are needed in step 4.

2. **Update the recipe row:** `title`, `description`, `publisher`, `author`,
   `sourceUrl`, `sourceDomain`, `claimedTimeMinutes`, `servings`, `yieldText`,
   `handEdited: true`, `updatedAt`.

   Never touched: `rating`, `status`, `notes`, `actualTimeMinutes` — the four
   columns nothing can regenerate, for the same reason `upsertRecipe` omits
   them. Also never touched: `slug`, `createdAt`, `archivedHtmlKey`,
   `sourceEncoding`, `extractionMethod`, `enrichmentApplied`.

3. **Slug is frozen.** Retitling does not move the URL. `upsertRecipe` already
   applies this rule on update for the same reason — a slug is a URL that may
   already be bookmarked, and in a two-person app it has very likely been
   texted to the other person.

4. **Ingredients and steps: delete and reinsert, with parsed-column
   carry-forward.** Build a map of `rawText → {quantity, unit, item, note}`
   from the old rows (first occurrence wins on duplicate lines). Each new line
   whose text is unchanged gets its parsed columns back; every changed or new
   line gets nulls.

   This is not an optimization — it is a correctness requirement.
   `enrichStoredRecipe` writes parsed columns keyed on
   `(recipe_id, position)`. Without carry-forward, inserting a single line at
   the top of the list silently reattaches every quantity to the wrong
   ingredient, with no visible symptom. Nulling the parsed columns on edited
   lines is the honest outcome: the old parse no longer describes the new
   text.

5. **Tags: delete every tag for the recipe, reinsert the submitted set with
   `source: 'user'`.** The form displays all tags regardless of source and
   submits the complete intended set, so that set is authoritative. Storing
   them as `user` puts them at the top of the `extracted < notion < user`
   ladder, so a later re-import or enrich cannot take them away.

   A removed `extracted` tag can in principle be reintroduced by a deliberate
   re-enrich, since `enrichStoredRecipe` inserts with `onConflictDoNothing`
   and there is no tombstone. Accepted: enrichment only runs on recipes
   flagged unenriched, and sub-project 3's re-import warning covers the case.
   A tombstone table for tags a human removed is not worth a schema for two
   users.

6. **`syncFtsRow(tx, recipeId, {title, ingredientsText, stepsText, notes,
   narrative})`** — the delete-then-insert lifted verbatim out of
   `upsertRecipe` and called by both. Two details that are easy to get wrong:
   the `narrative` column indexes *description plus tag-stripped narrative
   HTML*, so editing the description must recompute it; and `notes` is carried
   forward from the stored row, exactly as `upsertRecipe` already does, or an
   edit would leave a note stored and displayed but unfindable.

### Source URL is the one field that can fail loudly

`recipes.source_url` is `UNIQUE` — that constraint *is* the dedupe mechanism.
Input runs through `normalizeSourceUrl`, which also yields the new
`sourceDomain`. An explicit pre-check inside the transaction ("is there
another recipe with this URL and a different id") produces a message that
names the problem. The constraint remains the backstop for the race, but a
person must never meet it as a 500.

Clearing the field is allowed; the column is nullable and four migrated
recipes already have no source at all.

## The line format

A new pure module, `src/lib/recipe-text.ts`, holding the parse and render of
the sectioned line format. The manual-entry route's private `parseLines` moves
here too — two write paths quietly disagreeing about what a blank line means
is exactly the drift that function's own comment warns about. No I/O, so it is
unit-testable without a database or a Next runtime.

Rules:

- One ingredient or step per line. Blank lines — including whitespace-only —
  are dropped, never stored as empty rows.
- Splits on `\r\n`, `\r`, and `\n`, so a paste out of Notes or an email
  survives.
- **A line ending in a colon is a section header** (`For the sauce:`). It
  applies to every line beneath it until the next header, and is not itself
  stored as a row — it becomes the `section` value on the rows that follow.
  Lines before the first header have `section: null`.
- Rendering stored rows back into a textarea emits a header line wherever
  `section` changes, so the round trip is stable.

Known limitation, accepted: an actual ingredient ending in a colon would be
misread as a header. That string does not occur in practice, and an escape
syntax is one more thing to remember for a case that never happens.

## The form

`/recipes/[slug]/edit` — a Server Component that loads the recipe and
`notFound()`s on a miss, rendering a client form component beside a
`'use server'` action in `actions.ts`.

Auth is already global (`proxy.ts` redirects any un-sessioned page request),
but the action re-checks `auth()` itself the way every API route does. A
Server Action is a POST endpoint; defense in depth is cheap.

**Entry point:** a discreet "Edit" link on the recipe page beside the source
attribution — not in the "Our notes" panel, which is the after-cooking surface
and a different intent. Cancel returns to the recipe.

**Fields, top to bottom:** title · description · publisher and author · source
URL · claimed time, servings, yield text · ingredients · steps · tags ·
Save/Cancel.

**Tags:** 51 checkboxes styled as chips in four `<fieldset>`s with a legend
each (course, ingredient, method, cuisine), each carrying a `facet:value`
string as its `value` and checked when the recipe currently holds that tag.
Beside them, one free-text input for the open `tag` facet, comma-separated and
**pre-filled with the recipe's existing free-form tags** — so the input holds
the complete intended set on submit, the same way the checkboxes do. Clearing
it removes those tags, which is the only way removal could work given that the
save replaces the tag set wholesale.

Every free-form entry passes through `normalizeTag` first, so a typed value
that resolves to a vocabulary term is stored in its proper facet rather than
landing as a junk free-form row. Checkboxes mean the tag editor needs no
client JavaScript at all.

**Exactly two client-side behaviors:**

- `useActionState` (the `login-form.tsx` pattern), so a rejected save
  re-renders with every character still in place — the action returns the
  submitted values alongside the error.
- A `beforeunload` dirty guard mirroring the one in `EditControls`. This page
  holds more irreplaceable typing than any other in the app.

**Mobile:** inputs use `text-base` below the `sm` breakpoint, following the
rule already established in `EditControls` — iOS Safari zooms on focus for any
input under 16px and never zooms back out.

On success the action redirects to `/recipes/[slug]` — the same slug, since
the slug is frozen.

## Validation

Rejections re-render the form with the typed text intact and the message
beside the offending field. The action returns field-keyed issues in the same
shape `PATCH /api/recipes/[id]` already produces.

| Field | Rule |
| --- | --- |
| title | trimmed, 1–300 chars; empty is the one hard stop |
| description | ≤ 5,000 chars; empty → `null` |
| publisher, author | ≤ 200 each; empty → `null` |
| source URL | empty → `null`; else through `normalizeSourceUrl`; collision named explicitly |
| claimed time | integer, 0 – `MAX_REASONABLE_MINUTES` (imported from `lib/extract/duration`, not redeclared) |
| servings | positive integer, nullable |
| yield text | ≤ 200 chars |
| ingredients, steps | ≤ 500 lines each, ≤ 1,000 chars per line |
| free-form tags | ≤ 20 tags, ≤ 40 chars each |
| vocabulary tags | validated with `isValidTag`; an unknown `facet:value` is rejected, not silently dropped |

## Testing

- **`tests/lib/recipe-text.test.ts`** — blank lines, CRLF from a Windows
  paste, colon headers, a header with nothing beneath it, and a
  `render(parse(x))` round trip that stays stable.

- **`tests/db/update-recipe-content.test.ts`**, against real SQLite via the
  existing `tests/helpers/db.ts`:
  - parsed columns carried forward on unchanged lines, nulled on changed ones;
  - **inserting a line at the top does not shift quantities onto the wrong
    ingredients** — the trap from step 4, asserted directly;
  - sections survive a round trip;
  - tags replaced wholesale and stored with `source: 'user'`;
  - `rating`, `status`, `notes`, `actualTimeMinutes` untouched;
  - `slug` and `createdAt` untouched;
  - `handEdited` set;
  - FTS re-indexed — a term from the old text stops matching, a term from the
    new text starts;
  - a source URL collision is rejected with the specific error.

- **`tests/app/recipe-edit-action.test.ts`** — an unauthenticated save is
  rejected; each validation failure returns the submitted values.

- **`tests/components/recipe-edit-form.test.tsx`** — stored values populate
  the fields, chips reflect the recipe's current tags, error text renders.

- **`tests/db/upsert-recipe.test.ts`** is the regression guard on the
  `syncFtsRow` extraction. It must pass untouched.

Full gate: `npx vitest run && npx tsc --noEmit && npx eslint src tests scripts`

## Migration

`npm run db:generate` for the `hand_edited` column, then `npm run db:migrate`.
The column has a default, so existing rows need no backfill: every recipe in
the library today is machine-written, which is what `0` means.
