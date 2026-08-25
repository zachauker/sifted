# Recipe Manager — Design

**Date:** 2026-08-25
**Status:** Approved, ready for implementation planning

## Problem

Zach and his wife save recipes from the web into a shared Notion database using
Notion's web clipper (iOS share sheet). It works, but it is unpleasant in three
specific ways:

1. **The clipper dumps the whole article.** The recipe is buried below the
   author's narrative, ads, and SEO padding. Cooking from a saved recipe means
   scrolling past a thousand words every time.
2. **Filtering is weak.** Recipes share a `Library` database with articles and
   blog posts, so the `Tags` multi-select holds 68 options mixing food tags with
   `Docker`, `MF DOOM`, and `ADHD`. Food tags themselves conflate five separate
   questions into one flat list, and Notion can only ask "has any of these tags."
3. **It feels slow.** Every view is a generic block renderer fetching over the
   network on demand.

## Current state (measured from the live Notion database, 2026-08-25)

Database: `Library`, data source `a4ac088b-6fea-4de2-bde5-594f328bce9d`.

| Fact | Value |
| --- | --- |
| Recipes (`Type = Recipe`) | 156 |
| Non-recipe items (Article / Blog Post / Academic Journal) | 48 |
| Date range | 2019-11-09 → 2026-08-23 |
| Recipes with a rating | 74 |
| Cooking Status | 76 Made It, 69 Want to Make, 11 blank |
| Recipes with no tags | 20 |
| Recipes with no publisher | 17 |
| Recipes with **no source URL** | 4 |
| Bon Appétit recipes | 44 (28%) |

Existing properties: `Name` (title), `Type` (select), `Link` (url),
`Publisher` (text), `Author` (text), `Rating` (number 0–5),
`Cooking Status` (select: Made It / Want to Make), `Tags` (multi-select, 68
options), `Topic` (multi-select, duplicates the non-food half of `Tags`),
`Added By` (person).

Notable observations that shaped this design:

- `Dinner` + `Main Course` co-occur on 36 recipes — two answers to two different
  questions that a flat tag list cannot distinguish.
- The tag vocabulary contains a `Sandwhich` typo.
- Notion image URLs are S3 links signed with `X-Amz-Expires=300`. They are not
  stable and cannot be carried over by reference.

## Goals

- Clip a recipe from an iPhone share sheet in one gesture, as today.
- Recipe content first; narrative relegated and collapsed.
- A visually scannable library with photos we own.
- Multi-facet filtering that answers real questions ("a seafood main we can
  grill, under 45 minutes, that we haven't tried").
- Feels instant.
- Migrate all 156 recipes without losing anything.

## Non-goals

Meal planning, shopping lists, nutrition tracking, public sharing, per-person
ratings, a native app, multi-household support, offline writes. Each is a real
feature; none is why we are leaving Notion.

---

## Decisions

### Capture: iOS Shortcut → API

Both users are on iPhone. iOS Safari does not support the Web Share Target API,
so an installed PWA cannot register as a share target.

**Decision:** a per-phone iOS Shortcut configured to receive URLs from the share
sheet and `POST` to `/api/import` with a bearer token. Roughly one minute of
one-time setup per phone; thereafter the flow is identical to Notion's clipper.

Rejected:

- **Native iOS app with a share extension.** Only way to get the app icon in the
  top row of the share sheet, but costs an Apple Developer account, Xcode, a
  second codebase, and TestFlight distribution to two phones. Deferred, not
  foreclosed — it would talk to the same API.
- **Notion as a permanent clipping front-end.** The only thing worth taking from
  a Notion page is the URL, since we re-extract from source anyway. Making Notion
  a permanent dependency of the system built to escape Notion is the wrong shape.
  Retained as a **one-time migration** path only.

Additional capture paths: a paste-a-URL box in the app (desktop and fallback),
and manual entry by hand.

**Condé Nast mitigation.** Bon Appétit is 28% of the library and Condé Nast
blocks datacenter IPs. The Shortcut can send the page's text alongside the URL,
so the fetch happens on the phone, from a residential IP, already logged in.
Server-side fetch remains the default; the phone-supplied copy is the fallback.
*This needs validation during implementation* — if iOS Shortcuts cannot reliably
supply page contents for a given site, those imports fall through to the
needs-attention tray, which is an acceptable floor.

### Extraction: structured data first, LLM enrichment always

Most recipe sites embed a `schema.org/Recipe` JSON-LD block. Chain:

1. **JSON-LD** `@type: Recipe`, walking `@graph` (where WP Recipe Maker hides it).
2. **Microdata / RDFa** fallback.
3. **LLM extraction** from Readability-cleaned text when neither exists.

Narrative = whatever Readability finds, minus the recipe card node.

Then **one enrichment call regardless of path**, which does what structured data
does badly:

- Maps the source's `recipeCategory` / `recipeCuisine` / `keywords` onto our
  controlled taxonomy.
- Parses each ingredient line into `{quantity, unit, item, note}`.
- Writes a one-line description.

Enrichment output is schema-validated against `lib/taxonomy`. Invalid values are
dropped, never invented. At a few recipes a week this costs cents per month.

Rejected: always-LLM (re-derives data already in the page, slower, costlier) and
structured-only (leaves the tag normalization problem unsolved).

### Filtering: faceted, not a flat tag list

Facets, replacing the flat 68-option `Tags`:

| Facet | Cardinality | Example values |
| --- | --- | --- |
| `course` | single | Main, Side, Appetizer, Dessert, Breakfast, Sauce/Condiment, Bread, Drink |
| `ingredient` | multi | Chicken, Beef, Pork, Seafood, Vegetarian, Pasta, Potato |
| `method` | multi | Grill, Oven, Stovetop, Slow cooker, Instant Pot, Air fryer, No-cook |
| `cuisine` | multi | Italian, Mexican, Thai, Mediterranean |
| `tag` | multi | Open long tail: Meal Prep, Party Food, Thanksgiving |

Filters combine **AND across facets, OR within a facet**.

**"Meal" (breakfast/lunch/dinner) is deliberately excluded.** It duplicates
`course`, and the existing data shows `Dinner` applied reflexively to almost
everything, which means it carries no information.

Non-tag filters: status, rating, total time, added by, source site, date added.

### Time: claimed vs actual

Two fields. `claimed_time_minutes` comes from the source; `actual_time_minutes`
is entered by whoever cooked it. Recipe sites systematically understate time.

- Time filters use `actual` when present, falling back to `claimed`.
- The recipe header shows the gap outright: *"claims 35m · took us 1h10."*

`actual_time_minutes` is a **field on the recipe, not a log of every cook**.
Multi-cook history is a timeline nobody reads. Adding it later is additive.

### Photos: source image plus our own uploads

At import, the hero image is **downloaded and stored by us**, with thumbnails
generated. Hot-linking is not viable: Notion's URLs expire in 5 minutes, and
source blogs reorganize or die.

Users can also upload their own photo of the dish they made. The card image
resolves as `user_photo ?? source_image`. This precedence is built from day one;
the **upload UI ships in phase 2**.

### Hosting: Vercel, SQLite dialect

Vercel + Turso (libsql) + Vercel Blob for images.

The deciding factor is **reach, not speed**: the Shortcut must reach the API from
anywhere, and a public HTTPS URL costs nothing and requires no tunnel, no certs,
and no home-server uptime.

At this scale every database returns in under 5ms; database choice is irrelevant
to perceived speed. Speed comes from the client-side index (below).

Targeting the SQLite dialect through Drizzle keeps a later move to a local file
on the unraid server open — swap the client, move the images.

Rejected: self-hosting on unraid now (requires Cloudflare Tunnel or Tailscale on
both phones; a dependency the household experiences as "the recipe thing is
broken").

### Identity: one household, two accounts

One rating, one status, one set of notes per recipe. `added_by` records who
saved it, but there is a single verdict per recipe. `recipes.notes` is a single
free-text field shared by both users; attribution inside it is by convention
("Zach: needed more flour"), not a schema feature.

Rejected: per-person ratings. Costs a join table and forces a "which rating does
the card show" decision, and the 156 migrated recipes have only one rating each,
so it would start life half-empty.

Auth is NextAuth credentials + bcrypt with two seeded accounts — distinct
identities are needed for `added_by` regardless. The Shortcut
authenticates with a long-lived bearer token, one per phone, individually
revocable.

---

## Architecture

**Stack:** Next.js 15 (App Router), TypeScript, Tailwind, shadcn/Radix,
Drizzle ORM (SQLite dialect) on Turso, NextAuth + bcrypt, Vercel Blob,
`@anthropic-ai/sdk`, Vitest. Deployed on Vercel.

**The central idea: extraction is a pure function, and everything hostile lives
outside it.**

```
POST /api/import  →  fetchPage()  →  extract()  →  ingestImages()  →  db.upsert()
   (auth, dedupe)     (network)      (PURE)         (blob store)      (persist)
```

`extract()` takes `{ url, html }` and returns an `ExtractedRecipe`. It touches no
network, no database, no clock. The messiest, highest-risk part of the system —
coping with dozens of food blogs and their theme plugins — is testable against
saved HTML fixtures with zero mocking.

### Modules

| Module | Owns | Depends on |
| --- | --- | --- |
| `lib/fetch` | Network boundary: user agents, timeouts, redirects, blocked-site detection. Returns raw HTML. | — |
| `lib/extract` | HTML → `ExtractedRecipe`. JSON-LD, microdata, Readability narrative split, LLM fallback. **Pure.** | `lib/taxonomy` |
| `lib/taxonomy` | Controlled vocabularies and the mapping from messy source strings onto them. **Pure.** | — |
| `lib/images` | Fetch/receive, resize, thumbnail, upload, return keys. | blob store |
| `lib/db` | Drizzle schema and named query functions. No business logic. | Turso |
| `app/api/*` | Thin HTTP: authenticate, validate, orchestrate, persist. | all of the above |
| `scripts/migrate-notion.ts` | One-shot migration. Deleted when complete. | `lib/extract`, `lib/db` |

**Rule:** no parsing logic in route handlers; no HTTP in `lib/`. If it cannot be
tested without a network, it is in the wrong module.

`lib/taxonomy` is a single pure module with three consumers — it constrains LLM
output, drives the filter UI, and maps the legacy Notion tags — so the vocabulary
cannot drift.

### `ExtractedRecipe` (the contract between extraction and persistence)

```ts
type ExtractedRecipe = {
  title: string
  description: string | null
  author: string | null
  publisher: string | null
  claimedTimeMinutes: number | null
  servings: number | null
  yieldText: string | null
  ingredients: Array<{
    position: number
    section: string | null
    rawText: string
    quantity: number | null
    unit: string | null
    item: string | null
    note: string | null
  }>
  steps: Array<{ position: number; section: string | null; text: string }>
  tags: Array<{ facet: Facet; value: string }>
  heroImageUrl: string | null
  narrativeHtml: string | null
  extractionMethod: 'jsonld' | 'microdata' | 'llm' | 'notion' | 'manual'
}
```

---

## Data model

```
users            id, email, name, password_hash, created_at

api_tokens       id, user_id, label, token_hash, last_used_at, created_at

recipes          id, title, slug, source_url (unique nullable), source_domain,
                 publisher, author, description,
                 claimed_time_minutes, actual_time_minutes,
                 servings, yield_text,
                 rating, status, notes,
                 narrative_html, archived_html_key,
                 extraction_method, added_by, created_at, updated_at

ingredients      id, recipe_id, position, section, raw_text,
                 quantity, unit, item, note

steps            id, recipe_id, position, section, text

recipe_tags      recipe_id, facet, value           -- index on (facet, value)

images           id, recipe_id, role, blob_key, thumb_key, width, height

import_jobs      id, url, status, error, recipe_id, created_at

recipes_fts      FTS5 virtual table over title, ingredient raw_text,
                 step text, notes, narrative
```

`recipes.status` is `'want_to_make' | 'made_it' | null`.
`images.role` is `'source_hero' | 'user'`.
`import_jobs.status` is `'queued' | 'running' | 'done' | 'failed'`.

Three load-bearing choices:

**`recipe_tags(recipe_id, facet, value)`** — one row per tag with its facet. A
single index gives AND-across / OR-within filtering *and* the live counts in the
filter rail. Adding a facet later is data, not a migration.

**`archived_html_key`** — raw fetched HTML is saved to blob storage permanently.
Every future re-extraction is offline: improve the parser, re-run all 156
recipes, no network, no rate limits, no dead blogs. Any recipe that imported
badly is already a test fixture.

**`ingredients.raw_text` alongside parsed fields** — the original line is always
preserved verbatim. Parsed fields are an enhancement layered on top, never a
replacement.

---

## Import pipeline

```
Shortcut ──POST /api/import {url, html?}──> auth → normalize URL → dedupe
                                                  ↓
                                        create import_job, return 202 immediately
                                                  ↓ (background)
   fetch page → archive HTML → extract() → enrich() → ingest images → upsert
```

**202-and-process-in-background** is required by the real usage pattern. Fetch +
parse + LLM + image processing takes 5–20 seconds; a synchronous response would
leave someone watching a spinner in a grocery aisle, and a slow blog would look
like a failure. The Shortcut gets an instant confirmation; the app shows the
recipe as *importing* until it lands. Background work runs via `waitUntil`.

**URL normalization** strips `utm_*` parameters and fragments before the dedupe
check, so the same recipe clipped from two different links does not produce two
copies.

**Failure handling.** Failed jobs land in a **needs-attention tray** with the
reason. From there: retry, paste page text manually, or fill the recipe in by
hand. Failure is a visible queue with a fix path, never a silent nothing.

---

## Surfaces

1. **Library** — persistent filter rail with live counts (facets, status, rating,
   time), instant search, sort by recent/rating/time/title, photo grid. On phone
   the rail becomes a bottom sheet.
2. **Recipe** — hero, meta chips (course, cuisine, method, claimed-vs-actual
   time, rating, status, yield), ingredients pinned left with checkboxes and a
   scale control (phase 2), steps right, household notes, original article
   collapsed at the
   bottom behind a one-line fold. Inline edit.
3. **Add** — paste a URL, or enter by hand.
4. **Needs attention** — failed and partial imports with retry and manual fix.
5. **Settings** — API tokens per phone, taxonomy editing.
6. **Auth** — sign in.

### Performance approach

On load, one request returns the whole **library index** — id, title, thumbnail
key, facets, rating, status, times — roughly 30KB for 156 recipes. Cached in
IndexedDB, revalidated in the background. Filtering, sorting, searching, and
recomputing rail counts all happen **in memory with no network round-trip**.

Full recipe bodies load on demand and are prefetched when a card scrolls into
view. Images are served from blob CDN as WebP thumbnails, lazy-loaded.

Search is two-tier: local instant matching on titles, publishers, and tags;
**"search inside recipes"** hits FTS5 server-side for ingredient- and step-level
queries.

A PWA manifest lets the app install to the home screen.

---

## Migration

A one-shot script, **read-only against Notion**. The existing database is never
modified, so the migration can be run repeatedly with no risk.

For each of the 156 `Type = Recipe` rows:

1. Take `Link` and run it through the **same import pipeline** as a live clip —
   fresh extraction from source, not Notion's dump.
2. Carry over `Rating`, `Cooking Status` → `status`, `Added By` → `added_by`, and
   the original `createdTime` (so a 2019 recipe still reads as 2019).
3. Map old `Tags` onto the new facets via `lib/taxonomy`. Roughly 25 of the 68
   options are food-related; the rest (`Docker`, `MF DOOM`, `ADHD`, …) are
   dropped.

**It also pulls every recipe's Notion page body** and stashes it as fallback
content. When Bon Appétit blocks the fetch — and with 44 recipes some will fail —
the recipe still lands with real content rather than an empty shell. Nothing in
the library can be lost by migrating, even in the worst case.

**It runs dry first**, producing a report of what extracted cleanly, what fell
back, and what needs review, before anything is written.

The 4 recipes with no source URL import directly from their Notion bodies as
manual entries. The 48 non-recipe items stay in Notion.

---

## Testing

The center of gravity is **fixture-driven extraction tests**: saved HTML from the
top publishers in the library (Bon Appétit, Cafe Delites, Natasha's Kitchen,
Sally's Baking Addiction, Allrecipes, Simply Recipes), each with an expected
`ExtractedRecipe`. This suite is what makes the parser safe to improve.

Around it:

- `lib/taxonomy` mapping, including the legacy Notion tag vocabulary.
- Ingredient parsing.
- URL normalization and dedupe.
- API routes: auth, 202 response shape, duplicate handling, failure paths.

**No test calls Claude.** The SDK is mocked, with assertions on request payloads
and fixture responses for handling — including schema-invalid responses, which
must be dropped rather than persisted.

---

## Scope

**Phase 1 — replaces Notion**
Auth and two accounts; schema and migrations; `lib/taxonomy`; `lib/fetch`;
`lib/extract` with the full chain; enrichment; `lib/images`; `/api/import` with
background processing; iOS Shortcut setup; library screen with faceted filtering;
recipe screen; needs-attention tray; Notion migration script.

**Phase 2**
Camera/photo upload; ingredient scaling UI; cook mode with screen wake lock;
needs-attention editing polish.

**Not building** (see Non-goals): meal planning, shopping lists, nutrition,
public sharing, per-person ratings, native app.

---

## Open items for implementation

- Validate that an iOS Shortcut can reliably supply page contents alongside the
  URL for Condé Nast properties. If not, those imports use the needs-attention
  tray.
- Storage is Vercel Blob. Estimated footprint is roughly 150MB for 156 recipes
  (hero image, thumbnail, and gzipped archived HTML each). Measure actual usage
  after migration; if it exceeds the free tier, move to Cloudflare R2 — the
  `lib/images` interface makes that a one-module change.
