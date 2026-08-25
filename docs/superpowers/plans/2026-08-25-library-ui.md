# Recipe Manager: The Library UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The thing the whole project was for — open the app, see your recipes as photos, narrow them down in one click, and cook from a page where the recipe is at the top and the author's life story is folded away at the bottom.

**Architecture:** The entire library index is small enough to hand to the browser at once, so filtering, sorting, counting and searching happen in memory with no network round-trip. The recipe page is server-rendered. There is no client-side data-fetching library, no global store, and no ORM in the browser.

**Tech Stack:** Next 16 App Router, React 19, Tailwind 4, NextAuth v5, `sanitize-html`, Vitest + Testing Library.

**Source spec:** `docs/superpowers/specs/2026-08-25-recipe-manager-design.md` — the Surfaces and Performance sections, and the two layouts chosen during brainstorming (library = filter rail plus photo grid; recipe = recipe-only with the story folded at the bottom).

**Predecessors:** plans 1–3. Read the "Handoff", "Findings during execution", and "Decisions made during execution" sections of each. Several tasks here exist because of them.

**Scope note:** Plan 4 of 4, covering the Phase 1 surfaces. Explicitly **not** in scope, per the spec's own phasing: user photo upload, ingredient scaling, and cook mode with screen wake lock. Those are Phase 2 and should stay there.

---

## Task 1 is a checkpoint, and it is not optional

This plan was written **before the Notion migration was run**, so the real shape of the data is unknown. That matters more here than anywhere else in the project:

- A facet with three recipes does not deserve a row in the filter rail. One with sixty may need sub-grouping.
- If most recipes have no hero image, a photo grid needs a designed empty state rather than a wall of grey rectangles.
- If `Course` turns out to be populated on only a third of the library, leading with it is a bad default.

Task 1 measures all of that and **explicitly authorizes changing the later tasks**. Treat numbers in this plan as placeholders until then. The only figures known for certain come from the source database: 156 recipes, 74 rated, 76 Made It, 69 Want to Make, spanning 2019 to 2026.

---

## What already exists

| Module | What you will use |
| --- | --- |
| `src/lib/db/queries/recipes.ts` | `upsertRecipe`, `searchRecipes`, `listUnenrichedRecipes`, `applyNotionMetadata` |
| `src/lib/db/queries/jobs.ts` | `listJobs`, `getJob` |
| `src/lib/db/schema.ts` | `recipes`, `ingredients`, `steps`, `recipeTags` (with `source`), `images`, `importJobs` |
| `src/lib/auth.ts` | `auth`, `signIn`, `signOut`, `handlers` |
| `src/lib/taxonomy` | `FACETS`, `COURSE_VALUES`, `INGREDIENT_VALUES`, `METHOD_VALUES`, `CUISINE_VALUES` |
| `src/app/api/import`, `src/app/api/jobs` | already built, already tested |

`searchRecipes` already sanitizes user input — raw FTS5 `MATCH` throws on ordinary words like "and". Use it; do not build a second query path.

---

### Task 1: Measure the migrated library — CHECKPOINT

**Files:** none. This task produces a decision, recorded in this plan.

- [ ] **Step 1: Run the migration if it has not been run**

Follow `docs/migration-notes.md`. Do not proceed on an empty database — every design decision below depends on real data.

- [ ] **Step 2: Measure**

```bash
npm run migrate:verify
npm run unenriched
```

- [ ] **Step 3: Record the answers in this plan, under a "Measured library" heading**

- Total recipes, and how many have a hero image. **If image coverage is below about 60%, the grid needs a designed fallback** — a coloured tile carrying the title, not a grey box.
- The facet distribution: how many recipes per course, per ingredient, per method, per cuisine. **Any facet value with fewer than 3 recipes is noise in the rail** — decide whether to hide it behind a "more" control or drop it.
- How many recipes have zero tags. Those are invisible to every filter, and if the number is large the rail needs an "Untagged" escape hatch so they are reachable at all.
- How many have `enrichment_applied = false`. Repair them before building against the data.
- The rating and status split, to size those filters.
- How many recipes came from Notion bodies rather than their source — those have no narrative and often no image, and they are the ones most likely to look broken.

- [ ] **Step 4: Adjust the plan**

Change the later tasks to match what you found, and note what you changed and why. A plan that survives contact with the data unaltered probably was not read.

---

### Task 2: Give images a URL the browser can use

A blocker found while writing this plan: **nothing in the database can currently be rendered as an image.**

`BlobStore.put` returns `{key, url, size}`, but `ingestHeroImage` returns only `{blobKey, thumbKey, width, height}` and the `images` table stores only the keys. A Vercel Blob public URL looks like `https://<storeId>.public.blob.vercel-storage.com/<pathname>` — the store id is not derivable from the key, so the URL cannot be reconstructed later.

**Files:** Modify `src/lib/storage/index.ts` (types only), `src/lib/images/index.ts`, `src/lib/db/schema.ts`, `src/lib/import/run-import.ts`. Create a migration. Test: `tests/images/ingest.test.ts`, `tests/import/run-import.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/images/ingest.test.ts`, assert `ingestHeroImage` returns `blobUrl` and `thumbUrl` taken from what the store returned — not reconstructed from the key. The memory store returns `memory://<key>`, so assert exactly that, which proves the value came from the store.

In `tests/import/run-import.test.ts`, assert the `images` row stores both URLs.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Implement**

Add `blobUrl` and `thumbUrl` to `IngestedImage`, populated from the `StoredBlob` each `put` returns. Add `blob_url` and `thumb_url` to the `images` table — nullable, because a future backfill of already-ingested images may not have them. Generate the migration.

Add a comment on the columns recording *why* the key is not enough: the public URL is provider-shaped, and storing the provider's own answer is what keeps `lib/storage` swappable.

- [ ] **Step 4: Run, then commit**

```bash
git add src/lib/storage src/lib/images src/lib/db/schema.ts src/lib/import/run-import.ts drizzle/migrations tests/images tests/import
git commit -m "feat: store the public URL of every ingested image"
```

**If the migration has already run before this task**, existing `images` rows will have null URLs and their recipes will render without photos. Re-run the import for those recipes, or write a one-off backfill. Say which you did.

---

### Task 3: The library index endpoint

The performance idea the spec rests on: the whole library is small enough to hand over at once, so every filter click and keystroke is a pure in-memory operation.

**Files:** Create `src/lib/db/queries/library.ts`, `src/app/api/library-index/route.ts`. Test: `tests/db/library-index.test.ts`, `tests/api/library-index-route.test.ts`.

- [ ] **Step 1: Write the failing tests**

`buildLibraryIndex(db)` returns one entry per recipe:

```ts
export type LibraryEntry = {
  id: string
  slug: string
  title: string
  thumbUrl: string | null
  publisher: string | null
  rating: number | null
  status: 'want_to_make' | 'made_it' | null
  claimedTimeMinutes: number | null
  actualTimeMinutes: number | null
  createdAt: number          // epoch ms, so it sorts and serializes cheaply
  tags: string[]             // "facet:value", flat — see below
}
```

Cover: an empty library returns `[]`; a recipe with no image has `thumbUrl: null`; tags arrive as `facet:value` strings; a recipe with no tags has `[]`; entries are ordered newest first; and — the one that matters — **the payload for 156 realistic recipes stays under 100KB when serialized**. Build 156 entries with realistic field lengths and assert `JSON.stringify(...).length`. If that assertion ever fails, the whole client-side-filtering design needs revisiting, and a test is the right place to find out.

**Why tags are flat strings rather than objects:** `{facet, value}` objects roughly triple the tag payload, and every consumer wants to compare, group, or set-test them. `"course:main"` does all three with string equality. Note it in a comment.

The route test asserts a signed-out request gets 401.

- [ ] **Step 2: Run, confirm they fail**

- [ ] **Step 3: Implement**

One query with a join, or two queries and an in-memory group — measure both against 156 rows and pick, saying which and why. Do not issue a query per recipe.

`GET /api/library-index` authenticates with `auth()` and returns `{ entries }`.

- [ ] **Step 4: Run and commit**

---

### Task 4: The app shell, sign-in, and route protection

**Files:** Create `src/middleware.ts`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`. Modify `src/app/layout.tsx`. Test: `tests/app/middleware.test.ts`.

- [ ] **Step 1: Protect everything except sign-in**

There are exactly two accounts and no signup. Every route except `/login` and `/api/auth/*` requires a session. `/api/import` is the deliberate exception — it authenticates with a bearer token because the iOS Shortcut has no cookie. **Getting this wrong in the permissive direction exposes the whole library, so write the test first**: assert that an unauthenticated request to `/`, to a recipe page, and to `/api/library-index` all redirect or 401, and that `/api/import` is untouched by the middleware.

- [ ] **Step 2: Build the sign-in page**

Email and password, posting through NextAuth's credentials provider. On failure show one message that does not reveal whether the account exists — the constant-time compare in `src/lib/auth.ts` exists precisely to avoid leaking that, and a chatty error would undo it.

- [ ] **Step 3: Build the shell**

A minimal header: the library, an "Add" link, a needs-attention link showing a count when anything is failed, and sign-out. Nothing else. This is a two-person app; navigation should disappear.

- [ ] **Step 4: Commit**

---

### Task 5: The library grid

The chosen layout: a persistent filter rail beside a photo grid. On a phone the rail becomes a bottom sheet.

**Files:** Create `src/app/(app)/page.tsx`, `src/components/library/*`. Test: `tests/components/library-grid.test.tsx`.

- [ ] **Step 1: Add Testing Library**

```bash
npm install -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Configure a `jsdom` environment for `tests/components/**`. Vitest supports per-file environments via a docblock, or add a second project config — pick one and say why.

- [ ] **Step 2: Server-render the index into the page**

**A deliberate deviation from the spec.** The spec describes fetching the index client-side and caching it in IndexedDB. Instead, the server component calls `buildLibraryIndex` directly and passes the entries as props to a client component.

The result is strictly better for this app: no fetch waterfall, no loading state on first paint, no cache-invalidation logic, and no IndexedDB code to maintain. The endpoint from Task 3 still exists for revalidation and for anything built later. At 156 recipes and under 100KB, a cache is solving a problem this app does not have.

- [ ] **Step 3: Write the failing component tests**

Test behavior, not markup:

- every recipe renders as a card with its title
- a card with `thumbUrl: null` still renders and is still clickable — **it must not be a blank hole**, and after Task 1 you will know how common this is
- clicking a facet value narrows the grid
- selecting two values within one facet ORs them
- selecting values across two facets ANDs them
- clearing a filter restores the full grid
- the empty result state says something useful and offers a way back
- sorting by rating, by time, and by date changes the order
- a recipe with no rating sorts last under "highest rated" rather than first

- [ ] **Step 4: Implement**

Filtering is a pure function over the entries array — put it in `src/lib/library/filter.ts` and unit-test it separately from the DOM, since it is the logic and the components are the presentation.

- [ ] **Step 5: Commit**

---

### Task 6: The filter rail and its live counts

The counts are the point. They tell you things the old Notion database never could — *"we have eleven seafood mains and we've only made three."*

**Files:** Create `src/components/library/filter-rail.tsx`, `src/lib/library/facets.ts`. Test: `tests/lib/facets.test.ts`, `tests/components/filter-rail.test.tsx`.

- [ ] **Step 1: Write the failing tests for the counting logic**

`computeFacetCounts(entries, activeFilters)` is pure and is where the subtlety lives:

- with no filters, each value's count is how many recipes carry it
- **counts for a facet are computed with that facet's own filters excluded.** If you have selected `course:main`, the ingredient counts must show what is available *within* mains — but the course counts must keep showing the whole library, or selecting a second course would show `0` next to it and look broken while being reachable
- a value whose count is zero under the current filters is disabled, not hidden — things must not move around under the cursor
- values sort by count descending, then alphabetically, so the rail is stable
- a facet with no values at all does not render a heading

That second rule is the one that gets implemented wrong. Write it as an explicit test with a comment.

- [ ] **Step 2: Run, confirm they fail**

- [ ] **Step 3: Implement the rail**

Facets in the order the spec chose: Course, Ingredient, Method, Cuisine, then free tags. Then status, rating, and time.

Apply whatever you decided in Task 1 about low-count values and untagged recipes.

**Time filtering uses `actualTimeMinutes ?? claimedTimeMinutes`** — the measured time wins when it exists. That is the whole reason both columns exist.

- [ ] **Step 4: Make it a bottom sheet on mobile**

Same component, same state. Assert with a viewport-sized test that the rail is reachable on a narrow screen — a filter rail you cannot open on a phone is a filter rail you do not have, and the phone is where this app gets used.

- [ ] **Step 5: Commit**

---

### Task 7: Search

Two tiers, as the spec describes.

**Files:** Create `src/lib/library/search.ts`, `src/app/api/search/route.ts`. Test: `tests/lib/search.test.ts`, `tests/api/search-route.test.ts`.

- [ ] **Step 1: Local search, in memory**

Matches title, publisher, and tags from the index. Case- and accent-insensitive: the library is full of `sauté` and `crème`, and someone typing `saute` must find them. FTS5's tokenizer already folds diacritics server-side — the client must match that, or the two tiers disagree and the app feels broken. Normalize with `String.prototype.normalize('NFD')` and strip combining marks.

Tests: an exact title match; a partial word; a publisher match; a tag match; a diacritic-insensitive match in both directions; an empty query returning everything; a query matching nothing returning an empty array with the empty state.

- [ ] **Step 2: Server search, inside recipes**

`GET /api/search?q=` calls the existing `searchRecipes`, which searches ingredients, steps, and the narrative via FTS5 and already sanitizes input. Session-authenticated.

Test: a term appearing only in a step is found; a malformed query (`(`, `AND`, a bare quote) returns `[]` rather than a 500 — that behavior exists in `searchRecipes`, and this test is what stops a future refactor from routing around it.

- [ ] **Step 3: Wire the UI**

Typing filters locally and instantly. A clearly-labelled "search inside recipes" control runs the server search. Show which mode produced the results — silently changing what "search" means is worse than offering two buttons.

- [ ] **Step 4: Commit**

---

### Task 8: Sanitize the narrative before it ever renders

**This is the security-critical task in the plan.** Do it before the recipe page, not after.

Measured in plan 1: Readability strips `<script>` and `<style>`, but **inline event handlers survive intact** — `<p onclick="...">` and `<img onerror="...">` both pass through into `narrativeHtml`, which is stored and then rendered. Ingredient `rawText` and step text are untrusted third-party strings too, and a `<script>` element's text content survives into them as plain text.

**Files:** Create `src/lib/sanitize.ts`. Test: `tests/lib/sanitize.test.ts`.

- [ ] **Step 1: Write the failing tests**

```bash
npm install sanitize-html && npm install -D @types/sanitize-html
```

`sanitizeNarrative(html)` must:

- keep ordinary prose markup: `p`, `h2`–`h4`, `ul`, `ol`, `li`, `blockquote`, `em`, `strong`, `a`, `img`, `figure`, `figcaption`, `br`
- **strip every event-handler attribute** — test `onclick`, `onerror`, `onload`, `onmouseover` explicitly, on several tags
- allow `href` only for `http`, `https`, and `mailto`; drop `javascript:` and `data:` hrefs
- allow `src` only for `http` and `https`
- add `rel="noopener noreferrer"` and `target="_blank"` to external links
- strip `style` attributes entirely — the narrative must not be able to restyle the page it sits in
- drop `script`, `style`, `iframe`, `object`, `embed`, `form`, `input` outright
- return an empty string for null or undefined input rather than throwing

Include a test using a **real fixture**: `src/lib/extract/fixtures/*.html.gz` are genuine pages. Extract one, take its narrative, and assert the sanitized output contains its prose and no `on*` attribute.

- [ ] **Step 2: Run, confirm they fail**

- [ ] **Step 3: Implement**

Sanitize at **render** time, in the server component, not at extract time. Doing it in both places would invite the render layer to trust its input — and the stored value should stay faithful to the source so a future re-render can do better.

- [ ] **Step 4: Add a guard against the wrong kind of rendering**

Write a test that scans `src/app` and `src/components` and fails if `dangerouslySetInnerHTML` appears anywhere except the one narrative component, and fails if that component does not call `sanitizeNarrative`. Model it on `src/lib/extract/purity.test.ts`.

**Verify the guard fails when violated** — add a `dangerouslySetInnerHTML` elsewhere temporarily, confirm the test fails, remove it. A guard you have not seen fail is worthless.

- [ ] **Step 5: Commit**

---

### Task 9: The recipe page

The chosen layout, and the reason the project exists: the recipe at the top, the story folded away at the bottom.

**Files:** Create `src/app/(app)/recipes/[slug]/page.tsx`, `src/lib/db/queries/recipe-detail.ts`, `src/components/recipe/*`. Test: `tests/db/recipe-detail.test.ts`, `tests/components/recipe-page.test.tsx`.

- [ ] **Step 1: The query**

`getRecipeBySlug(db, slug)` returns the recipe with its ingredients, steps, tags, and images — ordered by `position`, in one round of queries, not N+1. Test that ordering explicitly: steps out of order are silently, dangerously wrong.

- [ ] **Step 2: Write the failing component tests**

- title, publisher, author, and source link render; the source link opens externally
- ingredients render **`rawText` verbatim**, not the parsed fields — the parse is an enhancement and the raw line is the truth
- ingredients and steps appear in `position` order
- a section label groups the ingredients beneath it
- steps are numbered
- **the claimed-versus-actual time chip**: with both, it reads like "claims 35m · took us 1h10"; with only a claim, just the claim; with neither, no chip at all
- the narrative renders inside a collapsed control that names its length, and is **not** expanded by default
- a recipe with no narrative renders no fold at all rather than an empty one
- a recipe with no image renders without a broken image
- household notes render when present

- [ ] **Step 3: Implement**

Server component. Ingredients pinned beside the steps on a wide screen, stacked on a phone. Ingredient checkboxes are client-side and need no persistence — they reset on reload, which is correct for a cooking session.

**The scale control is Phase 2.** Do not build it.

- [ ] **Step 4: Commit**

---

### Task 10: Editing what only you know

Rating, status, notes, and actual time are the four fields no extraction can produce. They are also the fields `upsertRecipe` deliberately preserves across a re-import.

**Files:** Create `src/app/api/recipes/[id]/route.ts`, `src/components/recipe/edit-controls.tsx`. Modify `src/lib/db/queries/recipes.ts`. Test: `tests/db/update-recipe.test.ts`, `tests/api/recipe-route.test.ts`.

- [ ] **Step 1: The query**

`updateUserFields(db, recipeId, { rating, status, notes, actualTimeMinutes })`, updating only the keys present so a partial edit cannot blank the others.

**Re-index FTS when notes change.** `upsertRecipe` writes an empty notes column into the FTS row because notes are user-owned and never arrive from extraction — this is the path that fills it, and plan 2's handoff records it as owed. Test that a note becomes findable via `searchRecipes`, and that editing it again removes the old text from the index.

- [ ] **Step 2: The endpoint**

`PATCH /api/recipes/[id]`, session-authenticated, validated with zod. Reject a rating outside 0–5 and a negative time. Test each.

- [ ] **Step 3: The controls**

A rating control, a status toggle, a notes field, and an actual-time field, on the recipe page. Optimistic update, with a visible revert if the request fails — silently losing "we made this, it was a 5" is the one thing this app must never do.

- [ ] **Step 4: Commit**

---

### Task 11: The needs-attention tray

`GET /api/jobs` and the retry endpoint already exist and are tested. This is their UI.

**Files:** Create `src/app/(app)/needs-attention/page.tsx`. Test: `tests/components/needs-attention.test.tsx`.

- [ ] **Step 1: Write the failing tests**

- failed jobs list with their URL and a plain-English reason
- **each `failureKind` gets an explanation and the right call to action.** `blocked` says the publisher refuses our server and offers the paste-HTML form. `fetch_failed` and `llm_failed` offer a plain retry. `no_recipe` says the page has no recipe and offers removal, not a retry. `internal` offers a retry and shows the error
- a `running` job shows as in progress and offers no retry — the endpoint returns 409 and the UI should not invite it
- pasting HTML and retrying calls the endpoint with the HTML
- an empty tray says so plainly rather than rendering nothing

The `failureKind` mapping is the substance of this task. Those types were designed so recovery differs per kind; a tray that shows one generic "Retry" throws that away.

- [ ] **Step 2: Implement, then commit**

---

### Task 12: Adding a recipe from the browser

**Files:** Create `src/app/(app)/add/page.tsx`, `src/app/api/recipes/manual/route.ts`. Test: `tests/api/manual-route.test.ts`.

- [ ] **Step 1: Paste a URL**

The desktop path. Posts to the existing import flow and shows the job's progress. A duplicate reports plainly that the recipe is already saved, with a link to it.

**The browser is session-authenticated, but `/api/import` expects a bearer token.** Decide how to bridge that — a session-authenticated wrapper route is the obvious answer — and say what you chose and why. Do not weaken the bearer path.

- [ ] **Step 2: Enter one by hand**

Title, ingredients (one per line), steps (one per line), and optional time and servings. Goes through `upsertRecipe` with `extractionMethod: 'manual'` and a null `sourceUrl`.

This is how a recipe with no web source gets in — the same case as the hand-typed family recipes the migration rescued. Test that a manual recipe with no source URL saves, and that two of them can coexist (the unique constraint is on `sourceUrl`, which is nullable).

- [ ] **Step 3: Commit**

---

### Task 13: Settings, and installing to the home screen

**Files:** Create `src/app/(app)/settings/page.tsx`, `src/app/api/tokens/route.ts`, `public/manifest.json`, icons. Test: `tests/api/tokens-route.test.ts`.

- [ ] **Step 1: Token management**

List tokens by label and last use. Issue a new one, **showing its value exactly once** with a clear warning. Revoke one. Test that revoking one token leaves the other working — that is the entire reason tokens are per-device.

- [ ] **Step 2: The PWA manifest**

Name, icons, `display: standalone`, theme colour. Enough to install to a home screen and open without browser chrome. No service worker — offline is not in scope and a half-built one causes stale-cache bugs that are miserable to diagnose.

- [ ] **Step 3: Commit**

---

### Task 14: Use it, on a phone, with real data

**Files:** update this plan with the results.

- [ ] **Step 1: Run it against the migrated library**

```bash
npm run dev
```

- [ ] **Step 2: Walk the real paths and record what you find**

- Sign in on a laptop and on a phone.
- **Find a specific recipe you remember, using only the filter rail.** Time it. If it takes more than a few seconds, the rail is wrong and Task 6 needs revisiting.
- Filter to a seafood main you have not made. Check the count is right by counting the cards.
- Open a Bon Appétit recipe: is the story folded away, and is the recipe genuinely at the top?
- Open one recovered from a Notion body: does it look broken? Those have no narrative and often no image, and they are the ones most likely to disappoint.
- Search for something you know is buried in a step.
- Search `saute` and confirm it finds `sauté`.
- Rate a recipe and mark it made, then reload and confirm it stuck.
- Add a recipe by pasting a URL, and watch it appear.
- Install to a phone home screen and open it there.

- [ ] **Step 3: Record honestly what is wrong**

List what felt slow, wrong, or ugly. **Do not fix it in this task** — record it, then decide what is worth a follow-up. The point is an honest account of the built thing, not a green checkmark.

- [ ] **Step 4: Commit**

---

## Definition of done

- Signing in works; nothing is reachable signed out except the sign-in page and the bearer-authenticated import endpoint.
- The library renders every migrated recipe, filters across facets with live counts, sorts, and searches — with no network round-trip for any of it.
- The recipe page shows the recipe first and the story folded, with ingredients verbatim and steps in order.
- Rating, status, notes, and actual time save and survive a reload; a note becomes searchable.
- Failed imports appear with a per-kind explanation and the right recovery.
- `dangerouslySetInnerHTML` appears in exactly one component, which sanitizes — enforced by a test proven to fail when violated.
- `npm test` passes; `tsc --noEmit` and `eslint` clean.
- Task 14's findings are written down, including what is still wrong.

## Known-open, carried from earlier plans

- A redirected failed job's archive is not findable from the job row; fixing it properly needs a column.
- No reaper for stale `running` jobs.
- `extract()`'s time budget rejects but cannot preempt synchronous parsing; a genuinely pathological page still blocks the event loop.
- RDFa is specified but unimplemented.
- Fixture coverage is thin for the publishers that block datacenter fetches.
- **If a tag editor is ever built, it must write `source: 'user'`.** The column defaults to `extracted`, which the next re-import deletes.
