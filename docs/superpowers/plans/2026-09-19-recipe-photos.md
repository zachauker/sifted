# Recipe Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload photos to a recipe, choose its cover, and delete photos (and their blobs) from the edit page; show the extra photos on the recipe page.

**Architecture:** Two boolean columns (`images.is_cover`, `recipes.source_hero_dismissed`) plus one cover rule implemented in TypeScript (`pickCover`) and SQL (library subquery). Upload processing shares the sharp pipeline with hero ingestion. A small server module (`src/lib/images/photos.ts`) owns add/cover/delete against the DB and `BlobStore`; three thin session-authenticated route handlers expose it; two client components (`PhotoManager`, `PhotoStrip`) drive it.

**Tech Stack:** Next.js 16.3 App Router (route handlers, `proxy.ts`), React 19, Drizzle ORM on libSQL/Turso, sharp, Vercel Blob via `BlobStore`, Vitest + Testing Library (jsdom per file), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-09-19-recipe-photos-design.md`

## Global Constraints

- Upload cap: **15 MB** (`15 * 1024 * 1024`), the existing `MAX_SOURCE_BYTES` value, exported as `MAX_IMAGE_BYTES` from `src/lib/images/limits.ts`.
- Rendition sizes/quality unchanged: full **1600px WebP q82**, thumb **480px WebP q74**.
- Upload blob keys: `recipes/<recipeId>/photos/<cuid>.webp` and `recipes/<recipeId>/photos/<cuid>-thumb.webp`.
- File input `accept="image/jpeg,image/png,image/webp"`.
- Cover rule, everywhere: `is_cover` → `source_hero` → oldest (`created_at`, then `rowid`), considering only rows with a non-null URL.
- All photo routes are session-authenticated (`auth()` from `@/lib/auth`), never token-authenticated.
- Tap targets: `min-h-11` (and `min-w-11` for icon-sized buttons), matching existing components.
- Next.js here is 16.x: read `node_modules/next/dist/docs/` before using an API you are unsure of. `node_modules` lives in the main checkout (`/Users/zacharyauker/Development/recipe-manager/node_modules`); Node resolution finds it from the worktree, so do **not** run `npm install` in the worktree.
- Run tests with `npx vitest run <path>`; the full suite is `npx vitest run` (baseline: 66 files, 1186 tests, all passing).
- Commit messages: imperative sentence in the repo's style (e.g. "Let a recipe choose its own cover"), ending with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Match the codebase's comment style: comments explain *why*, in full sentences, and are dense where a decision was made.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/lib/db/schema.ts` | modify | `images.isCover`, `recipes.sourceHeroDismissed` |
| `drizzle/migrations/0005_recipe_photos.sql` (+ meta) | create (generated) | the two columns |
| `src/lib/images/cover.ts` | create | `pickCover` — pure, client-safe |
| `src/lib/images/limits.ts` | create | `MAX_IMAGE_BYTES` — pure, client-safe |
| `src/lib/db/queries/recipe-detail.ts` | modify | `DetailImage` gains `id`, `isCover`; rowid tiebreak |
| `src/lib/db/queries/library.ts` | modify | cover subquery replaces the `source_hero` join |
| `src/components/recipe/recipe-view.tsx` | modify | hero via `pickCover`; renders `PhotoStrip` |
| `src/lib/import/run-import.ts` | modify | skip hero ingestion when dismissed |
| `scripts/repair-images.ts` | modify | `--missing` skips dismissed recipes |
| `src/lib/images/index.ts` | modify | `renderImage`, `ingestUploadedImage` |
| `src/lib/images/photos.ts` | create | `addPhoto`, `makeCover`, `removePhoto` |
| `src/app/api/recipes/[id]/images/route.ts` | create | `POST` |
| `src/app/api/recipes/[id]/images/[imageId]/route.ts` | create | `PATCH`, `DELETE` |
| `next.config.ts` | modify | `experimental.proxyClientMaxBodySize` |
| `src/components/recipe/photo-manager.tsx` | create | edit-page Photos section |
| `src/app/(app)/recipes/[slug]/edit/page.tsx` | modify | mounts `PhotoManager` |
| `src/components/recipe/photo-strip.tsx` | create | recipe-page thumbnails + dialog |

---

### Task 1: Data model and the cover rule

**Files:**
- Modify: `src/lib/db/schema.ts` (recipes table after `handEdited`; images table after `thumbUrl`)
- Create: `drizzle/migrations/0005_recipe_photos.sql` and its `meta/` snapshot + journal entry (generated)
- Create: `src/lib/images/cover.ts`
- Modify: `src/lib/db/queries/recipe-detail.ts` (`DetailImage` type ~line 69; image select ~line 176)
- Modify: `src/lib/db/queries/library.ts` (`buildLibraryIndex`, ~lines 28-100)
- Modify: `src/components/recipe/recipe-view.tsx` (~lines 50-57)
- Test: `tests/db/cover-rule.test.ts` (create)
- Test: `tests/components/recipe-page.test.tsx` (update image fixtures, add one test)
- Test: `tests/db/recipe-detail.test.ts` (update the images expectation, ~line 183)

**Interfaces:**
- Produces:
  - Drizzle columns `images.isCover: boolean` (not null, default false) and `recipes.sourceHeroDismissed: boolean` (not null, default false).
  - `export type DetailImage = { id: string; role: 'source_hero' | 'user'; isCover: boolean; blobUrl: string | null; thumbUrl: string | null; width: number; height: number }` from `@/lib/db/queries/recipe-detail`. `getRecipeBySlug` returns images oldest-first (`created_at`, then `rowid`).
  - `export type CoverCandidate = { role: 'source_hero' | 'user'; isCover: boolean; blobUrl: string | null }` and `export function pickCover<T extends CoverCandidate>(images: readonly T[]): T | undefined` from `@/lib/images/cover`.
  - `buildLibraryIndex` entries' `thumbUrl` follow the cover rule.

- [ ] **Step 1: Add the columns to the schema**

In `src/lib/db/schema.ts`, inside `recipes`, directly after the `handEdited` column:

```ts
  // Set when a person deletes this recipe's `source_hero` image. It records
  // that the publisher's photo was looked at and rejected, and it is the only
  // thing that stops a re-import — which replaces the `source_hero` row
  // wholesale — from quietly bringing it back. Nothing clears it: restoring a
  // publisher photo is the `npm run images -- --recipe --from` escape hatch.
  sourceHeroDismissed: integer('source_hero_dismissed', { mode: 'boolean' }).notNull().default(false),
```

Inside `images`, directly after `thumbUrl`:

```ts
  // The photo a person chose to stand for the recipe. At most one per recipe,
  // held by the cover route clearing every sibling in the same transaction.
  // Absent a choice, the cover falls back to the `source_hero`, then the
  // oldest photo — see `pickCover` in `@/lib/images/cover`, and its SQL twin
  // in `buildLibraryIndex`.
  isCover: integer('is_cover', { mode: 'boolean' }).notNull().default(false),
```

- [ ] **Step 2: Generate the migration**

Run: `TURSO_DATABASE_URL=file:unused.db npx drizzle-kit generate --name recipe_photos`
(`generate` does not connect; the dummy URL only satisfies the config. Delete `unused.db` if it appears.)

Expected: `drizzle/migrations/0005_recipe_photos.sql` containing exactly these two statements (order may differ), plus `meta/0005_snapshot.json` and a new `_journal.json` entry:

```sql
ALTER TABLE `images` ADD `is_cover` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `recipes` ADD `source_hero_dismissed` integer DEFAULT false NOT NULL;
```

If drizzle-kit produces anything else (a table rebuild, a dropped index), stop and report it — do not hand-edit around it.

- [ ] **Step 3: Write the failing cover-rule test**

Create `tests/db/cover-rule.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { recipes, images } from '@/lib/db/schema'
import { buildLibraryIndex } from '@/lib/db/queries/library'
import { getRecipeBySlug } from '@/lib/db/queries/recipe-detail'
import { pickCover } from '@/lib/images/cover'

/**
 * The cover rule lives in two places — `pickCover` for the recipe page and a
 * correlated subquery for the library grid — because the grid must not load
 * every image row of every recipe to pick one thumbnail. This table is what
 * keeps the two identical: every case runs through both, against a real
 * database, and they must agree with each other and with the expectation.
 */
type ImageSpec = {
  key: string
  role: 'source_hero' | 'user'
  isCover?: boolean
  /** False models a row ingested before the URL columns existed. */
  hasUrl?: boolean
  createdAt?: Date
}

const SAME_SECOND = new Date('2026-01-01T00:00:00Z')

const CASES: { name: string; images: ImageSpec[]; expected: string | null }[] = [
  {
    name: 'a chosen cover beats the publisher photo',
    images: [{ key: 'hero', role: 'source_hero' }, { key: 'mine', role: 'user', isCover: true }],
    expected: 'mine',
  },
  {
    name: 'the publisher photo when nothing is chosen, even if it is not the oldest',
    images: [{ key: 'mine', role: 'user' }, { key: 'hero', role: 'source_hero' }],
    expected: 'hero',
  },
  {
    name: 'the oldest photo when there is neither a choice nor a publisher photo',
    images: [
      { key: 'late', role: 'user', createdAt: new Date('2026-02-01T00:00:00Z') },
      { key: 'early', role: 'user', createdAt: new Date('2026-01-01T00:00:00Z') },
    ],
    expected: 'early',
  },
  {
    name: 'insertion order breaks a tie on created_at',
    images: [{ key: 'first', role: 'user' }, { key: 'second', role: 'user' }],
    expected: 'first',
  },
  {
    name: 'a chosen cover with no stored URL falls through',
    images: [
      { key: 'legacy', role: 'user', isCover: true, hasUrl: false },
      { key: 'hero', role: 'source_hero' },
    ],
    expected: 'hero',
  },
  {
    name: 'nothing when the only image has no stored URL',
    images: [{ key: 'legacy', role: 'source_hero', hasUrl: false }],
    expected: null,
  },
  { name: 'nothing when there are no images', images: [], expected: null },
]

const full = (key: string) => `https://blob.example.com/${key}.webp`
const thumb = (key: string) => `https://blob.example.com/${key}-thumb.webp`

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

describe('the cover rule', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const [recipe] = await db.insert(recipes).values({
        title: 'Egg Korma', slug: 'egg-korma', extractionMethod: 'manual',
      }).returning()

      // Inserted one at a time, in array order, so `rowid` follows the array.
      for (const spec of c.images) {
        const hasUrl = spec.hasUrl ?? true
        await db.insert(images).values({
          recipeId: recipe.id,
          role: spec.role,
          isCover: spec.isCover ?? false,
          blobKey: `recipes/${recipe.id}/${spec.key}.webp`,
          thumbKey: `recipes/${recipe.id}/${spec.key}-thumb.webp`,
          blobUrl: hasUrl ? full(spec.key) : null,
          thumbUrl: hasUrl ? thumb(spec.key) : null,
          width: 1600,
          height: 1067,
          createdAt: spec.createdAt ?? SAME_SECOND,
        })
      }

      const detail = await getRecipeBySlug(db, 'egg-korma')
      const [entry] = await buildLibraryIndex(db)

      expect(pickCover(detail!.images)?.blobUrl ?? null).toBe(c.expected ? full(c.expected) : null)
      expect(entry.thumbUrl).toBe(c.expected ? thumb(c.expected) : null)
    })
  }
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/db/cover-rule.test.ts`
Expected: FAIL — `Cannot find module '@/lib/images/cover'` (or equivalent resolution error).

- [ ] **Step 5: Create `pickCover`**

Create `src/lib/images/cover.ts`:

```ts
/**
 * The fields the cover rule reads. Structural, so both `DetailImage` rows and
 * anything shaped like them can be passed without a mapping step.
 */
export type CoverCandidate = {
  role: 'source_hero' | 'user'
  isCover: boolean
  blobUrl: string | null
}

/**
 * The one picture that stands for a recipe: the photo a person chose, else the
 * publisher's, else the oldest.
 *
 * Only rows with a stored URL are candidates. Rows ingested before the URL
 * columns existed have keys and nothing renderable, and must fall through to
 * the next candidate rather than render as a broken `<img>`.
 *
 * `images` must be oldest-first, which is the order `getRecipeBySlug` returns.
 * The fallback chain is what makes deletion safe: removing the cover never
 * leaves a recipe that still has photos showing none.
 *
 * Kept free of imports on purpose — client components call it, and
 * `@/lib/images` itself pulls in sharp. Its SQL twin is the thumbnail
 * subquery in `buildLibraryIndex`; `tests/db/cover-rule.test.ts` holds them
 * together.
 */
export function pickCover<T extends CoverCandidate>(images: readonly T[]): T | undefined {
  const renderable = images.filter((image) => image.blobUrl)
  return (
    renderable.find((image) => image.isCover) ??
    renderable.find((image) => image.role === 'source_hero') ??
    renderable[0]
  )
}
```

- [ ] **Step 6: Extend the detail query**

In `src/lib/db/queries/recipe-detail.ts`, replace the `DetailImage` type:

```ts
export type DetailImage = {
  id: string
  role: 'source_hero' | 'user'
  isCover: boolean
  blobUrl: string | null
  thumbUrl: string | null
  width: number
  height: number
}
```

In the images select, add `id: images.id,` and `isCover: images.isCover,` to the selected columns, and change `.orderBy(images.createdAt)` to:

```ts
      // Oldest first, which `pickCover` relies on for its last fallback.
      // `created_at` is second-resolution and a multi-photo upload lands
      // inside one second, so `rowid` — insertion order — breaks the tie.
      .orderBy(images.createdAt, sql`${images}.rowid`),
```

Add `sql` to the `drizzle-orm` import if it is not already imported.

- [ ] **Step 7: Replace the library join with the cover subquery**

In `src/lib/db/queries/library.ts`, in `buildLibraryIndex`:
- replace `thumbUrl: images.thumbUrl,` in the select with:

```ts
      // The cover rule in SQL — `pickCover`'s twin, held to it by
      // `tests/db/cover-rule.test.ts`. A correlated subquery rather than a
      // join: it yields exactly one value per recipe, so a recipe with five
      // photos is still one row.
      thumbUrl: sql<string | null>`(
        SELECT ${images.thumbUrl} FROM ${images}
        WHERE ${images.recipeId} = ${recipes.id} AND ${images.thumbUrl} IS NOT NULL
        ORDER BY ${images.isCover} DESC, (${images.role} = 'source_hero') DESC,
          ${images.createdAt} ASC, ${images}.rowid ASC
        LIMIT 1
      )`,
```

- delete the `.leftJoin(images, …)` line;
- delete the "Defensive de-dupe" `seen` set and its comment (the subquery cannot fan out), keeping the loop that builds `entries`;
- rewrite the function's doc comment paragraph about "left-joined to its `source_hero` image" to describe the cover subquery instead (one or two sentences; the join rationale no longer applies).

Remove any import that becomes unused (`and` may be).

- [ ] **Step 8: Use `pickCover` on the recipe page**

In `src/components/recipe/recipe-view.tsx`, import `import { pickCover } from '@/lib/images/cover'` and replace the `hero` computation and its comment with:

```ts
  // The cover rule — a chosen photo, else the publisher's, else the oldest —
  // skipping rows with no stored URL, which must render as no image rather
  // than an `<img>` with an empty src (the browser's broken-image icon).
  const hero = pickCover(recipe.images)
```

- [ ] **Step 9: Update fixtures that build `DetailImage`**

In `tests/components/recipe-page.test.tsx`, every image object literal gains `id` and `isCover`, e.g.:

```ts
            {
              id: 'img-hero',
              role: 'source_hero',
              isCover: false,
              blobUrl: 'https://blob.example.com/hero.webp',
              thumbUrl: 'https://blob.example.com/thumb.webp',
              width: 1600,
              height: 1067,
            },
```

and `{ id: 'img-legacy', role: 'source_hero', isCover: false, blobUrl: null, thumbUrl: null, width: 1600, height: 1067 }` for the null-URL case. In `tests/db/recipe-detail.test.ts`, update the images expectation in "returns tags with their facet, and images with their stored URLs" to include `id: expect.any(String)` and `isCover: false`.

Then add to the `describe('the recipe header', …)` block in `recipe-page.test.tsx`:

```ts
  it('shows the photo a person chose as the cover, not the publisher photo', () => {
    render(
      <RecipeView
        recipe={recipe({
          images: [
            { id: 'img-hero', role: 'source_hero', isCover: false, blobUrl: 'https://blob.example.com/hero.webp', thumbUrl: 'https://blob.example.com/hero-thumb.webp', width: 1600, height: 1067 },
            { id: 'img-mine', role: 'user', isCover: true, blobUrl: 'https://blob.example.com/mine.webp', thumbUrl: 'https://blob.example.com/mine-thumb.webp', width: 1600, height: 1200 },
          ],
        })}
      />,
    )

    expect(document.querySelector('img')).toHaveAttribute('src', 'https://blob.example.com/mine.webp')
  })
```

- [ ] **Step 10: Run the affected tests**

Run: `npx vitest run tests/db/cover-rule.test.ts tests/db/library-index.test.ts tests/db/recipe-detail.test.ts tests/components/recipe-page.test.tsx tests/db/migration-verify.test.ts tests/db/schema.test.ts`
Expected: all PASS. If a `library-index` test asserted on the removed de-dupe behaviour specifically, update its comment/expectation to the subquery's behaviour (one row per recipe) rather than deleting coverage.

- [ ] **Step 11: Full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/lib/db/schema.ts drizzle/migrations src/lib/images/cover.ts src/lib/db/queries/recipe-detail.ts src/lib/db/queries/library.ts src/components/recipe/recipe-view.tsx tests/db/cover-rule.test.ts tests/db/recipe-detail.test.ts tests/components/recipe-page.test.tsx tests/db/library-index.test.ts
git commit -m "Let a recipe choose its own cover

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: A dismissed publisher photo stays dismissed

**Files:**
- Modify: `src/lib/import/run-import.ts` (hero block, ~line 369-398)
- Modify: `scripts/repair-images.ts` (`--missing` branch, ~lines 165-176)
- Test: `tests/import/run-import.test.ts` (new `describe` at the end)
- Test: `tests/scripts/repair-images-args.test.ts` (add a `describe` for the new export)

**Interfaces:**
- Consumes: `recipes.sourceHeroDismissed` (Task 1).
- Produces: `export function missingImageTargets<T extends { id: string; dismissed: boolean }>(recipes: T[], withImages: Set<string>): T[]` from `scripts/repair-images.ts`.

- [ ] **Step 1: Write the failing import test**

Append to `tests/import/run-import.test.ts` (it already imports `eq`, `recipes`, `images`, and defines `newJob`, `fakeLlm`, `fakeFetch`, `fetchedPage`, `recipeHtml`, `fakeIngest`, `SOURCE_URL`):

```ts
/**
 * Deleting the publisher's photo is a decision, and a re-import — which
 * replaces the `source_hero` row wholesale — must not quietly reverse it.
 */
describe('runImport: a dismissed publisher photo stays dismissed', () => {
  async function importOnce(ingest = fakeIngest()) {
    const jobId = await newJob()
    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      allowExistingUpdate: true,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: ingest,
    })
    return ingest
  }

  it('does not download or store the publisher photo again', async () => {
    await importOnce()
    const [recipe] = await db.select().from(recipes)
    await db.delete(images).where(eq(images.recipeId, recipe.id))
    await db.update(recipes).set({ sourceHeroDismissed: true }).where(eq(recipes.id, recipe.id))

    const ingest = await importOnce()

    expect(ingest.calls).toEqual([])
    expect(await db.select().from(images)).toEqual([])
    const [after] = await db.select().from(recipes)
    expect(after.sourceHeroDismissed).toBe(true)
  })

  it('still replaces the publisher photo of a recipe that never dismissed it', async () => {
    await importOnce()
    const ingest = await importOnce()

    expect(ingest.calls).toHaveLength(1)
    expect(await db.select().from(images)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify the first test fails**

Run: `npx vitest run tests/import/run-import.test.ts -t "dismissed"`
Expected: FAIL on "does not download or store the publisher photo again" (`ingest.calls` has one entry).

- [ ] **Step 3: Skip ingestion when dismissed**

In `src/lib/import/run-import.ts`, `existing` is the full row returned by `findBySourceUrl` earlier in the same `try` block. Change the hero condition from `if (extracted.heroImageUrl) {` to:

```ts
    // Skipped outright, not downloaded and then discarded, when a person has
    // deleted this recipe's publisher photo: the re-import is here to repair
    // the words, and bringing back a picture someone removed is not a repair.
    if (extracted.heroImageUrl && !existing?.sourceHeroDismissed) {
```

Keep the existing comment above it.

- [ ] **Step 4: Run the import tests**

Run: `npx vitest run tests/import/run-import.test.ts`
Expected: all PASS.

- [ ] **Step 5: Write the failing repair-script test**

Add to `tests/scripts/repair-images-args.test.ts` (extend its existing import from the script to include `missingImageTargets`):

```ts
describe('missingImageTargets', () => {
  it('picks recipes with no image row', () => {
    const rows = [
      { id: 'a', dismissed: false },
      { id: 'b', dismissed: false },
    ]
    expect(missingImageTargets(rows, new Set(['a']))).toEqual([{ id: 'b', dismissed: false }])
  })

  it('leaves alone a recipe whose publisher photo was deleted on purpose', () => {
    const rows = [{ id: 'a', dismissed: true }]
    expect(missingImageTargets(rows, new Set())).toEqual([])
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/scripts/repair-images-args.test.ts`
Expected: FAIL — `missingImageTargets` is not exported.

- [ ] **Step 7: Implement and use `missingImageTargets`**

In `scripts/repair-images.ts`, add near `parseArgs`:

```ts
/**
 * Recipes `--missing` should go looking for a picture for: no image row, and
 * not a recipe whose publisher photo a person deleted. The second condition
 * is the same one `runImport` honours — this script re-finding the photo
 * from the archived page would undo that deletion just as surely.
 */
export function missingImageTargets<T extends { id: string; dismissed: boolean }>(
  rows: T[],
  withImages: Set<string>,
): T[] {
  return rows.filter((r) => !withImages.has(r.id) && !r.dismissed)
}
```

In the `--missing` branch, add `dismissed: recipes.sourceHeroDismissed,` to the `select({...})`, and replace `let targets = all.filter((r) => !have.has(r.id))` with `let targets = missingImageTargets(all, have)`.

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run tests/scripts tests/import && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/import/run-import.ts scripts/repair-images.ts tests/import/run-import.test.ts tests/scripts/repair-images-args.test.ts
git commit -m "Keep a deleted publisher photo deleted through a re-import

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Processing an uploaded image

**Files:**
- Create: `src/lib/images/limits.ts`
- Modify: `src/lib/images/index.ts`
- Test: `tests/images/upload.test.ts` (create); `tests/images/ingest.test.ts` must keep passing unchanged

**Interfaces:**
- Produces:
  - `export const MAX_IMAGE_BYTES = 15 * 1024 * 1024` from `@/lib/images/limits` (no imports; client-safe).
  - `export type RenderedImage = { full: Buffer; thumb: Buffer; width: number; height: number }`
  - `export async function renderImage(bytes: Uint8Array): Promise<RenderedImage | null>` — null when sharp cannot decode or reports no dimensions.
  - `export type UploadRejection = 'too_large' | 'unsupported' | 'storage_failed'`
  - `export type UploadResult = { ok: true; image: IngestedImage } | { ok: false; reason: UploadRejection }`
  - `export async function ingestUploadedImage(input: { bytes: Uint8Array; recipeId: string; store: BlobStore }): Promise<UploadResult>`
  - (existing) `IngestedImage = { blobKey; thumbKey; blobUrl; thumbUrl; width; height }`

- [ ] **Step 1: Write the failing tests**

Create `tests/images/upload.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { ingestUploadedImage } from '@/lib/images'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'
import { createMemoryStore } from '@/lib/storage/memory'
import type { BlobStore } from '@/lib/storage'

async function jpegBytes(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 160, b: 90 } },
  }).jpeg().toBuffer()
  return new Uint8Array(buf)
}

const SVG = new Uint8Array(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', 'utf-8',
))

describe('ingestUploadedImage', () => {
  it('stores a full image and a thumbnail under the recipe’s photos prefix', async () => {
    const store = createMemoryStore()

    const result = await ingestUploadedImage({ bytes: await jpegBytes(2400, 1600), recipeId: 'r1', store })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.image.blobKey).toMatch(/^recipes\/r1\/photos\/[a-z0-9]+\.webp$/)
    expect(result.image.thumbKey).toBe(result.image.blobKey.replace(/\.webp$/, '-thumb.webp'))
    expect(result.image.blobUrl).toBe(`memory://${result.image.blobKey}`)
    expect(result.image.thumbUrl).toBe(`memory://${result.image.thumbKey}`)
    expect(result.image).toMatchObject({ width: 2400, height: 1600 })
    expect(store.keys().sort()).toEqual([result.image.thumbKey, result.image.blobKey].sort())

    const fullMeta = await sharp(Buffer.from((await store.get(result.image.blobKey))!)).metadata()
    expect(fullMeta).toMatchObject({ format: 'webp', width: 1600 })
    const thumbMeta = await sharp(Buffer.from((await store.get(result.image.thumbKey))!)).metadata()
    expect(thumbMeta.width).toBe(480)
  })

  it('never reuses a key, so one upload cannot overwrite another or the publisher photo', async () => {
    const store = createMemoryStore()
    const bytes = await jpegBytes(800, 600)

    const a = await ingestUploadedImage({ bytes, recipeId: 'r1', store })
    const b = await ingestUploadedImage({ bytes, recipeId: 'r1', store })

    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.image.blobKey).not.toBe(b.image.blobKey)
    expect(a.image.blobKey).not.toBe('recipes/r1/hero.webp')
    expect(store.keys()).toHaveLength(4)
  })

  it('refuses a file over the size cap without decoding it', async () => {
    const store = createMemoryStore()
    const result = await ingestUploadedImage({ bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), recipeId: 'r1', store })
    expect(result).toEqual({ ok: false, reason: 'too_large' })
    expect(store.keys()).toEqual([])
  })

  it.each([
    ['an empty file', new Uint8Array(0)],
    ['an SVG', SVG],
    ['bytes that are not an image', new Uint8Array(Buffer.from('definitely not a photo'))],
  ])('refuses %s as unsupported and writes nothing', async (_name, bytes) => {
    const store = createMemoryStore()
    const result = await ingestUploadedImage({ bytes, recipeId: 'r1', store })
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
    expect(store.keys()).toEqual([])
  })

  it('removes the full-size blob when the thumbnail cannot be written', async () => {
    const memory = createMemoryStore()
    const store: BlobStore = {
      ...memory,
      async put(key, data, contentType) {
        if (key.endsWith('-thumb.webp')) throw new Error('blob store unavailable')
        return memory.put(key, data, contentType)
      },
    }

    const result = await ingestUploadedImage({ bytes: await jpegBytes(800, 600), recipeId: 'r1', store })

    expect(result).toEqual({ ok: false, reason: 'storage_failed' })
    expect(memory.keys()).toEqual([])
  })

  it('reports storage_failed when the full-size write fails', async () => {
    const memory = createMemoryStore()
    const store: BlobStore = { ...memory, async put() { throw new Error('down') } }

    const result = await ingestUploadedImage({ bytes: await jpegBytes(800, 600), recipeId: 'r1', store })

    expect(result).toEqual({ ok: false, reason: 'storage_failed' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/images/upload.test.ts`
Expected: FAIL — `@/lib/images/limits` not found / `ingestUploadedImage` not exported.

- [ ] **Step 3: Create the limits module**

Create `src/lib/images/limits.ts`:

```ts
/**
 * The largest image we accept, whether downloaded from a publisher or
 * uploaded from a phone. A modern phone's full-resolution JPEG is 3-8 MB, so
 * this leaves room without letting one request hold a large buffer.
 *
 * Its own module, with no imports, because the upload form checks it in the
 * browser before sending anything — and `@/lib/images` pulls in sharp, which
 * must never reach a client bundle.
 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
```

- [ ] **Step 4: Extract `renderImage` and add `ingestUploadedImage`**

In `src/lib/images/index.ts`:

1. Replace `const MAX_SOURCE_BYTES = 15 * 1024 * 1024` with `import { MAX_IMAGE_BYTES } from './limits'` (top of file, with the other imports) and use `MAX_IMAGE_BYTES` where `MAX_SOURCE_BYTES` was used. Add `import { createId } from '@paralleldrive/cuid2'`.

2. Add, above `ingestHeroImage`, a `renderImage` holding the sharp work that currently lives in `ingestHeroImage`'s second `try` — **move** the existing orientation comment with it verbatim:

```ts
export type RenderedImage = {
  /** Up to 1600px wide, WebP. What the recipe page draws. */
  full: Buffer
  /** 480px wide, WebP. What the library grid and thumbnail strips draw. */
  thumb: Buffer
  /** Display dimensions of the source, after EXIF orientation. */
  width: number
  height: number
}

/**
 * Normalizes any image sharp can decode into the two renditions the app
 * draws. Shared by publisher heroes and uploaded photos, so both are held to
 * the same sizes and encodings.
 *
 * Returns null for bytes sharp cannot decode or that report no dimensions.
 * Callers are responsible for size and SVG checks before calling this.
 */
export async function renderImage(bytes: Uint8Array): Promise<RenderedImage | null> {
  try {
    const meta = await sharp(Buffer.from(bytes)).metadata()
    if (!meta.width || !meta.height) return null

    // (existing orientation comment, moved here unchanged)
    const orientation = meta.orientation ?? 1
    const swapAxes = orientation >= 5 && orientation <= 8
    const width = swapAxes ? meta.height : meta.width
    const height = swapAxes ? meta.width : meta.height

    const full = await sharp(Buffer.from(bytes))
      .rotate()
      .resize({ width: FULL_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()

    const thumb = await sharp(Buffer.from(bytes))
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 74 })
      .toBuffer()

    return { full, thumb, width, height }
  } catch {
    return null
  }
}
```

3. Rewrite `ingestHeroImage`'s second `try` block to use it (the keys, puts and return shape stay identical):

```ts
  try {
    const rendered = await renderImage(bytes)
    if (!rendered) return null

    const blobKey = `recipes/${recipeId}/hero.webp`
    const thumbKey = `recipes/${recipeId}/hero-thumb.webp`

    const blobResult = await store.put(blobKey, new Uint8Array(rendered.full), 'image/webp')
    const thumbResult = await store.put(thumbKey, new Uint8Array(rendered.thumb), 'image/webp')

    return {
      blobKey,
      thumbKey,
      blobUrl: blobResult.url,
      thumbUrl: thumbResult.url,
      width: rendered.width,
      height: rendered.height,
    }
  } catch {
    return null
  }
```

4. Append `ingestUploadedImage`:

```ts
export type UploadRejection = 'too_large' | 'unsupported' | 'storage_failed'

export type UploadResult =
  | { ok: true; image: IngestedImage }
  | { ok: false; reason: UploadRejection }

/**
 * Stores a photo a person uploaded: the same two renditions as a publisher
 * hero, under a fresh key per upload.
 *
 * Differs from `ingestHeroImage` in two deliberate ways. It says *why* it
 * refused, because a person chose this file and is waiting for an answer;
 * and its keys are unique per upload (`photos/<cuid>`), because the Vercel
 * store writes with `allowOverwrite` and a fixed key would let one upload
 * replace another — or the publisher's `hero.webp`.
 *
 * SVG is refused here too. The provenance argument that motivates the check
 * for heroes is weaker for a file we picked ourselves, but refusing it costs
 * nothing, and one rule is easier to hold than two.
 *
 * A failed thumbnail write deletes the full-size blob it just wrote, so a
 * failed upload leaves nothing in storage for nobody to reference.
 */
export async function ingestUploadedImage(input: {
  bytes: Uint8Array
  recipeId: string
  store: BlobStore
}): Promise<UploadResult> {
  const { bytes, recipeId, store } = input

  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: 'too_large' }
  if (bytes.byteLength === 0 || looksLikeSvg(bytes)) return { ok: false, reason: 'unsupported' }

  const rendered = await renderImage(bytes)
  if (!rendered) return { ok: false, reason: 'unsupported' }

  const id = createId()
  const blobKey = `recipes/${recipeId}/photos/${id}.webp`
  const thumbKey = `recipes/${recipeId}/photos/${id}-thumb.webp`

  let blobUrl: string
  try {
    blobUrl = (await store.put(blobKey, new Uint8Array(rendered.full), 'image/webp')).url
  } catch {
    return { ok: false, reason: 'storage_failed' }
  }

  let thumbUrl: string
  try {
    thumbUrl = (await store.put(thumbKey, new Uint8Array(rendered.thumb), 'image/webp')).url
  } catch {
    await store.delete(blobKey).catch(() => {})
    return { ok: false, reason: 'storage_failed' }
  }

  return {
    ok: true,
    image: { blobKey, thumbKey, blobUrl, thumbUrl, width: rendered.width, height: rendered.height },
  }
}
```

- [ ] **Step 5: Run the image tests**

Run: `npx vitest run tests/images`
Expected: all PASS — both the new file and the untouched `ingest.test.ts`.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/lib/images/index.ts src/lib/images/limits.ts tests/images/upload.test.ts
git commit -m "Turn an uploaded file into the same two renditions as a hero

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Adding, choosing and deleting photos

**Files:**
- Create: `src/lib/images/photos.ts`
- Test: `tests/images/photos.test.ts` (create)

**Interfaces:**
- Consumes: `ingestUploadedImage`, `UploadRejection` (Task 3); `images.isCover`, `recipes.sourceHeroDismissed` (Task 1); `Db` from `@/lib/db`; `BlobStore` from `@/lib/storage`.
- Produces (all from `@/lib/images/photos`):
  - `export type Photo = { id: string; role: 'source_hero' | 'user'; isCover: boolean; blobUrl: string | null; thumbUrl: string | null; width: number; height: number }`
  - `export type AddPhotoResult = { status: 'ok'; slug: string; photo: Photo } | { status: 'not_found' } | { status: 'rejected'; reason: UploadRejection }`
  - `export async function addPhoto(db: Db, store: BlobStore, recipeId: string, bytes: Uint8Array): Promise<AddPhotoResult>`
  - `export type MakeCoverResult = { status: 'ok'; slug: string } | { status: 'not_found' }`
  - `export async function makeCover(db: Db, recipeId: string, imageId: string): Promise<MakeCoverResult>`
  - `export type RemovePhotoResult = { status: 'ok'; slug: string } | { status: 'not_found' } | { status: 'storage_failed' }`
  - `export async function removePhoto(db: Db, store: BlobStore, recipeId: string, imageId: string): Promise<RemovePhotoResult>`

- [ ] **Step 1: Write the failing tests**

Create `tests/images/photos.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/db'
import { createMemoryStore } from '@/lib/storage/memory'
import type { BlobStore } from '@/lib/storage'
import { recipes, images } from '@/lib/db/schema'
import { addPhoto, makeCover, removePhoto } from '@/lib/images/photos'

let db: TestDb
let store: ReturnType<typeof createMemoryStore>

beforeEach(async () => {
  db = await createTestDb()
  store = createMemoryStore()
})

async function jpeg(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer())
}

async function insertRecipe(slug = 'egg-korma') {
  const [row] = await db.insert(recipes).values({ title: 'Egg Korma', slug, extractionMethod: 'manual' }).returning()
  return row
}

/** A publisher hero as `runImport` writes it, with real blobs behind it. */
async function insertHero(recipeId: string) {
  const blobKey = `recipes/${recipeId}/hero.webp`
  const thumbKey = `recipes/${recipeId}/hero-thumb.webp`
  await store.put(blobKey, new Uint8Array([1]), 'image/webp')
  await store.put(thumbKey, new Uint8Array([1]), 'image/webp')
  const [row] = await db.insert(images).values({
    recipeId, role: 'source_hero', blobKey, thumbKey,
    blobUrl: `memory://${blobKey}`, thumbUrl: `memory://${thumbKey}`, width: 1600, height: 1067,
  }).returning()
  return row
}

describe('addPhoto', () => {
  it('stores the upload as a user photo that is not the cover', async () => {
    const recipe = await insertRecipe()

    const result = await addPhoto(db, store, recipe.id, await jpeg())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.slug).toBe('egg-korma')
    expect(result.photo).toMatchObject({ role: 'user', isCover: false, width: 800, height: 600 })
    const rows = await db.select().from(images)
    expect(rows).toHaveLength(1)
    expect(store.keys()).toHaveLength(2)
  })

  it('answers not_found for an unknown recipe and writes nothing', async () => {
    const result = await addPhoto(db, store, 'nope', await jpeg())
    expect(result).toEqual({ status: 'not_found' })
    expect(store.keys()).toEqual([])
  })

  it('passes a rejection through and writes no row', async () => {
    const recipe = await insertRecipe()
    const result = await addPhoto(db, store, recipe.id, new Uint8Array(Buffer.from('not an image')))
    expect(result).toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(await db.select().from(images)).toEqual([])
  })
})

describe('makeCover', () => {
  it('makes exactly one photo the cover, however many times it is called', async () => {
    const recipe = await insertRecipe()
    const a = await addPhoto(db, store, recipe.id, await jpeg())
    const b = await addPhoto(db, store, recipe.id, await jpeg())
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('setup failed')

    expect(await makeCover(db, recipe.id, a.photo.id)).toEqual({ status: 'ok', slug: 'egg-korma' })
    expect(await makeCover(db, recipe.id, b.photo.id)).toEqual({ status: 'ok', slug: 'egg-korma' })

    const covers = (await db.select().from(images)).filter((row) => row.isCover)
    expect(covers.map((row) => row.id)).toEqual([b.photo.id])
  })

  it('refuses an image that belongs to another recipe, and changes nothing', async () => {
    const mine = await insertRecipe('mine')
    const theirs = await insertRecipe('theirs')
    const photo = await addPhoto(db, store, theirs.id, await jpeg())
    if (photo.status !== 'ok') throw new Error('setup failed')

    expect(await makeCover(db, mine.id, photo.photo.id)).toEqual({ status: 'not_found' })
    const [row] = await db.select().from(images)
    expect(row.isCover).toBe(false)
  })
})

describe('removePhoto', () => {
  it('deletes both blobs and the row', async () => {
    const recipe = await insertRecipe()
    const added = await addPhoto(db, store, recipe.id, await jpeg())
    if (added.status !== 'ok') throw new Error('setup failed')

    expect(await removePhoto(db, store, recipe.id, added.photo.id)).toEqual({ status: 'ok', slug: 'egg-korma' })

    expect(store.keys()).toEqual([])
    expect(await db.select().from(images)).toEqual([])
    const [after] = await db.select().from(recipes)
    expect(after.sourceHeroDismissed).toBe(false)
  })

  it('remembers that the publisher photo was deleted', async () => {
    const recipe = await insertRecipe()
    const hero = await insertHero(recipe.id)

    expect((await removePhoto(db, store, recipe.id, hero.id)).status).toBe('ok')

    expect(store.keys()).toEqual([])
    const [after] = await db.select().from(recipes).where(eq(recipes.id, recipe.id))
    expect(after.sourceHeroDismissed).toBe(true)
  })

  it('keeps the row when storage refuses the delete, so nothing claims to be gone that is not', async () => {
    const recipe = await insertRecipe()
    const hero = await insertHero(recipe.id)
    const failing: BlobStore = { ...store, async delete() { throw new Error('blob store unavailable') } }

    expect(await removePhoto(db, failing, recipe.id, hero.id)).toEqual({ status: 'storage_failed' })

    expect(await db.select().from(images)).toHaveLength(1)
    const [after] = await db.select().from(recipes)
    expect(after.sourceHeroDismissed).toBe(false)
  })

  it('refuses an image that belongs to another recipe, and deletes nothing', async () => {
    const mine = await insertRecipe('mine')
    const theirs = await insertRecipe('theirs')
    const hero = await insertHero(theirs.id)

    expect(await removePhoto(db, store, mine.id, hero.id)).toEqual({ status: 'not_found' })
    expect(store.keys()).toHaveLength(2)
    expect(await db.select().from(images)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/images/photos.test.ts`
Expected: FAIL — cannot resolve `@/lib/images/photos`.

- [ ] **Step 3: Implement `photos.ts`**

Create `src/lib/images/photos.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { images, recipes } from '@/lib/db/schema'
import type { BlobStore } from '@/lib/storage'
import { ingestUploadedImage, type UploadRejection } from '@/lib/images'

/**
 * The photos a person manages from the edit page: add one, choose the cover,
 * delete one. Everything here takes the recipe id *and* the image id and
 * matches both, so a request can never touch another recipe's photo by
 * guessing an image id.
 *
 * Each result carries the recipe's slug on success, because the caller's next
 * move is revalidating `/recipes/<slug>` and it has only the id.
 */

export type Photo = {
  id: string
  role: 'source_hero' | 'user'
  isCover: boolean
  blobUrl: string | null
  thumbUrl: string | null
  width: number
  height: number
}

export type AddPhotoResult =
  | { status: 'ok'; slug: string; photo: Photo }
  | { status: 'not_found' }
  | { status: 'rejected'; reason: UploadRejection }

export type MakeCoverResult = { status: 'ok'; slug: string } | { status: 'not_found' }

export type RemovePhotoResult =
  | { status: 'ok'; slug: string }
  | { status: 'not_found' }
  | { status: 'storage_failed' }

async function findPhoto(db: Db, recipeId: string, imageId: string) {
  return db
    .select({
      id: images.id,
      role: images.role,
      blobKey: images.blobKey,
      thumbKey: images.thumbKey,
      slug: recipes.slug,
    })
    .from(images)
    .innerJoin(recipes, eq(recipes.id, images.recipeId))
    .where(and(eq(images.id, imageId), eq(images.recipeId, recipeId)))
    .get()
}

export async function addPhoto(
  db: Db,
  store: BlobStore,
  recipeId: string,
  bytes: Uint8Array,
): Promise<AddPhotoResult> {
  // Checked before any bytes are processed or written: a typo'd id should not
  // leave two orphaned blobs behind.
  const recipe = await db.select({ slug: recipes.slug }).from(recipes).where(eq(recipes.id, recipeId)).get()
  if (!recipe) return { status: 'not_found' }

  const result = await ingestUploadedImage({ bytes, recipeId, store })
  if (!result.ok) return { status: 'rejected', reason: result.reason }

  const { image } = result
  try {
    const [row] = await db.insert(images).values({
      recipeId,
      role: 'user',
      isCover: false,
      blobKey: image.blobKey,
      thumbKey: image.thumbKey,
      blobUrl: image.blobUrl,
      thumbUrl: image.thumbUrl,
      width: image.width,
      height: image.height,
    }).returning()

    return {
      status: 'ok',
      slug: recipe.slug,
      photo: {
        id: row.id, role: row.role, isCover: row.isCover,
        blobUrl: row.blobUrl, thumbUrl: row.thumbUrl, width: row.width, height: row.height,
      },
    }
  } catch (error) {
    // The blobs are written and nothing will ever reference them. Best-effort
    // cleanup, then the original failure — which is the one worth reporting.
    await store.delete(image.blobKey).catch(() => {})
    await store.delete(image.thumbKey).catch(() => {})
    throw error
  }
}

export async function makeCover(db: Db, recipeId: string, imageId: string): Promise<MakeCoverResult> {
  const target = await findPhoto(db, recipeId, imageId)
  if (!target) return { status: 'not_found' }

  // One transaction, so no reader ever sees two covers or none mid-change.
  await db.transaction(async (tx) => {
    await tx.update(images).set({ isCover: false }).where(eq(images.recipeId, recipeId))
    await tx.update(images).set({ isCover: true }).where(eq(images.id, imageId))
  })

  return { status: 'ok', slug: target.slug }
}

export async function removePhoto(
  db: Db,
  store: BlobStore,
  recipeId: string,
  imageId: string,
): Promise<RemovePhotoResult> {
  const target = await findPhoto(db, recipeId, imageId)
  if (!target) return { status: 'not_found' }

  // Storage first, row second. If storage refuses, the row survives and the
  // photo stays on screen, so "deleted" always means gone from storage — the
  // opposite order would leave files nobody can see or remove. Vercel Blob's
  // `del` is a no-op for a missing key, which makes retrying a half-finished
  // delete safe.
  try {
    await store.delete(target.blobKey)
    await store.delete(target.thumbKey)
  } catch {
    return { status: 'storage_failed' }
  }

  await db.transaction(async (tx) => {
    await tx.delete(images).where(eq(images.id, imageId))
    if (target.role === 'source_hero') {
      await tx.update(recipes).set({ sourceHeroDismissed: true }).where(eq(recipes.id, recipeId))
    }
  })

  return { status: 'ok', slug: target.slug }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/images/photos.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/lib/images/photos.ts tests/images/photos.test.ts
git commit -m "Add, choose and delete a recipe's photos, storage first

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The photo routes, and a body the proxy will not truncate

**Files:**
- Create: `src/app/api/recipes/[id]/images/route.ts`
- Create: `src/app/api/recipes/[id]/images/[imageId]/route.ts`
- Modify: `next.config.ts`
- Test: `tests/api/recipe-images-route.test.ts` (create)
- Test: `tests/build/proxy-body-limit.test.ts` (create)

**Interfaces:**
- Consumes: `addPhoto`, `makeCover`, `removePhoto`, `Photo` (Task 4); `MAX_IMAGE_BYTES` (Task 3); `createVercelBlobStore` from `@/lib/storage/vercel-blob`; `auth` from `@/lib/auth`; `db` from `@/lib/db`; `revalidatePath` from `next/cache`.
- Produces (HTTP, consumed by Task 6's client):
  - `POST /api/recipes/:id/images` — body `FormData` with exactly one `file`. `201 { photo: Photo }`; `400 { error: 'bad_request' }`; `401`; `404 { error: 'not_found' }`; `413 { error: 'too_large' }`; `415 { error: 'unsupported' }`; `502 { error: 'storage_failed' }`.
  - `PATCH /api/recipes/:id/images/:imageId` — JSON `{ "cover": true }`. `200 { ok: true }`; `400`; `401`; `404`.
  - `DELETE /api/recipes/:id/images/:imageId` — `204`; `401`; `404`; `502 { error: 'storage_failed' }`.

**Why the config change:** `src/proxy.ts` matches `/api/recipes/*`, and Next 16 buffers a request body for the proxy only up to `experimental.proxyClientMaxBodySize` (default **10 MB**) — past that, the route handler silently receives a *truncated* body (see `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`). A 12 MB photo would reach sharp cut short and fail as "unsupported". The limit must exceed `MAX_IMAGE_BYTES` plus multipart overhead.

- [ ] **Step 1: Write the failing route tests**

Create `tests/api/recipe-images-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  addPhoto: vi.fn(),
  makeCover: vi.fn(),
  removePhoto: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: () => ({ marker: 'store' }) }))
vi.mock('@/lib/images/photos', () => ({
  addPhoto: mocks.addPhoto,
  makeCover: mocks.makeCover,
  removePhoto: mocks.removePhoto,
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

const { POST } = await import('@/app/api/recipes/[id]/images/route')
const { PATCH, DELETE } = await import('@/app/api/recipes/[id]/images/[imageId]/route')

const PHOTO = {
  id: 'img1', role: 'user', isCover: false,
  blobUrl: 'memory://a.webp', thumbUrl: 'memory://a-thumb.webp', width: 800, height: 600,
}

function upload(form: FormData) {
  return POST(
    new Request('https://app.example.com/api/recipes/r1/images', { method: 'POST', body: form }),
    { params: Promise.resolve({ id: 'r1' }) },
  )
}

function oneFile(bytes = new Uint8Array([1, 2, 3]), name = 'dish.jpg') {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type: 'image/jpeg' }))
  return form
}

const imageParams = { params: Promise.resolve({ id: 'r1', imageId: 'img1' }) }

function patch(body: string) {
  return PATCH(
    new Request('https://app.example.com/api/recipes/r1/images/img1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body,
    }),
    imageParams,
  )
}

function del() {
  return DELETE(new Request('https://app.example.com/api/recipes/r1/images/img1', { method: 'DELETE' }), imageParams)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.addPhoto.mockResolvedValue({ status: 'ok', slug: 'egg-korma', photo: PHOTO })
  mocks.makeCover.mockResolvedValue({ status: 'ok', slug: 'egg-korma' })
  mocks.removePhoto.mockResolvedValue({ status: 'ok', slug: 'egg-korma' })
})

describe('POST /api/recipes/[id]/images', () => {
  it('stores the file and returns the new photo', async () => {
    const res = await upload(oneFile(new Uint8Array([9, 8, 7])))

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ photo: PHOTO })
    expect(mocks.addPhoto).toHaveBeenCalledWith({ marker: 'db' }, { marker: 'store' }, 'r1', new Uint8Array([9, 8, 7]))
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/recipes/egg-korma')
  })

  it('returns 401 for a signed-out caller and reads nothing', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await upload(oneFile())
    expect(res.status).toBe(401)
    expect(mocks.addPhoto).not.toHaveBeenCalled()
  })

  it('refuses a request with no file', async () => {
    const res = await upload(new FormData())
    expect(res.status).toBe(400)
    expect(mocks.addPhoto).not.toHaveBeenCalled()
  })

  it('refuses two files in one request', async () => {
    const form = oneFile()
    form.append('file', new File([new Uint8Array([1])], 'second.jpg', { type: 'image/jpeg' }))
    expect((await upload(form)).status).toBe(400)
  })

  it('refuses a text field posing as the file', async () => {
    const form = new FormData()
    form.append('file', 'not a file')
    expect((await upload(form)).status).toBe(400)
  })

  it('refuses an oversized file before reading it', async () => {
    const res = await upload(oneFile(new Uint8Array(MAX_IMAGE_BYTES + 1)))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too_large' })
    expect(mocks.addPhoto).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'not_found' }, 404, 'not_found'],
    [{ status: 'rejected', reason: 'too_large' }, 413, 'too_large'],
    [{ status: 'rejected', reason: 'unsupported' }, 415, 'unsupported'],
    [{ status: 'rejected', reason: 'storage_failed' }, 502, 'storage_failed'],
  ])('maps %o to %i', async (result, status, error) => {
    mocks.addPhoto.mockResolvedValue(result)
    const res = await upload(oneFile())
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error })
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/recipes/[id]/images/[imageId]', () => {
  it('makes the photo the cover', async () => {
    const res = await patch('{"cover":true}')
    expect(res.status).toBe(200)
    expect(mocks.makeCover).toHaveBeenCalledWith({ marker: 'db' }, 'r1', 'img1')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/recipes/egg-korma')
  })

  it.each(['{"cover":false}', '{}', '{"cover":true,"extra":1}', 'not json'])('refuses %s', async (body) => {
    expect((await patch(body)).status).toBe(400)
    expect(mocks.makeCover).not.toHaveBeenCalled()
  })

  it('returns 404 for a photo that is not this recipe’s', async () => {
    mocks.makeCover.mockResolvedValue({ status: 'not_found' })
    expect((await patch('{"cover":true}')).status).toBe(404)
  })

  it('returns 401 for a signed-out caller', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await patch('{"cover":true}')).status).toBe(401)
    expect(mocks.makeCover).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/recipes/[id]/images/[imageId]', () => {
  it('deletes the photo', async () => {
    const res = await del()
    expect(res.status).toBe(204)
    expect(mocks.removePhoto).toHaveBeenCalledWith({ marker: 'db' }, { marker: 'store' }, 'r1', 'img1')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/recipes/egg-korma')
  })

  it('returns 502 when storage refused, so the client knows the photo is still there', async () => {
    mocks.removePhoto.mockResolvedValue({ status: 'storage_failed' })
    const res = await del()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'storage_failed' })
  })

  it('returns 404 for a photo that is not this recipe’s', async () => {
    mocks.removePhoto.mockResolvedValue({ status: 'not_found' })
    expect((await del()).status).toBe(404)
  })

  it('returns 401 for a signed-out caller', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await del()).status).toBe(401)
    expect(mocks.removePhoto).not.toHaveBeenCalled()
  })
})
```

Create `tests/build/proxy-body-limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import nextConfig from '../../next.config'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'

/**
 * `src/proxy.ts` runs in front of the photo upload route, and Next buffers a
 * body for the proxy only up to `proxyClientMaxBodySize` — beyond it, the
 * route silently receives a truncated body. Nothing fails loudly: a large
 * photo simply arrives cut short and is refused as unreadable. This holds the
 * config above the upload cap.
 */
function toBytes(limit: string | number): number {
  if (typeof limit === 'number') return limit
  const match = /^(\d+)(b|kb|mb|gb)$/i.exec(limit.trim())
  if (!match) throw new Error(`unparseable limit: ${limit}`)
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[match[2].toLowerCase() as 'b' | 'kb' | 'mb' | 'gb']
  return Number(match[1]) * unit
}

describe('proxyClientMaxBodySize', () => {
  it('admits the largest photo we accept, with room for multipart overhead', () => {
    const limit = nextConfig.experimental?.proxyClientMaxBodySize
    expect(limit).toBeDefined()
    expect(toBytes(limit!)).toBeGreaterThanOrEqual(MAX_IMAGE_BYTES + 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/recipe-images-route.test.ts tests/build/proxy-body-limit.test.ts`
Expected: FAIL — route modules not found; `proxyClientMaxBodySize` undefined.

- [ ] **Step 3: Implement the upload route**

Create `src/app/api/recipes/[id]/images/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { addPhoto } from '@/lib/images/photos'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'

/**
 * `POST /api/recipes/[id]/images` — one uploaded photo.
 *
 * Exactly one `file` per request, and the client sends a multi-photo pick one
 * file at a time. That keeps every request under the upload cap and the
 * platform's body limit, gives each photo its own success or failure, and
 * means one unreadable file cannot sink the rest.
 *
 * A route handler rather than a Server Action: photo changes take effect
 * immediately and independently of the edit form's Save, and a Server Action
 * would also need its 1 MB body limit raised app-wide.
 *
 * Session-authenticated, like every write the browser makes; the API tokens
 * are for the Shortcut, which only imports.
 */
const STATUS = { not_found: 404, too_large: 413, unsupported: 415, storage_failed: 502 } as const

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const entries = [...form.entries()]
  const file = entries[0]?.[1]
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(file instanceof File)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // Checked against the declared size before the bytes are copied out.
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 })
  }

  const { id } = await params
  const result = await addPhoto(db, createVercelBlobStore(), id, new Uint8Array(await file.arrayBuffer()))

  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: STATUS.not_found })
  }
  if (result.status === 'rejected') {
    return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] })
  }

  revalidatePath(`/recipes/${result.slug}`)
  return NextResponse.json({ photo: result.photo }, { status: 201 })
}
```

- [ ] **Step 4: Implement the per-image route**

Create `src/app/api/recipes/[id]/images/[imageId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { makeCover, removePhoto } from '@/lib/images/photos'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'

type Params = { params: Promise<{ id: string; imageId: string }> }

/**
 * `cover: true` only. There is no "un-cover": to change the cover you choose
 * another photo, and with no choice at all the cover rule already falls back
 * to the publisher's photo, then the oldest.
 */
const patchSchema = z.strictObject({ cover: z.literal(true) })

/** `PATCH /api/recipes/[id]/images/[imageId]` — make this photo the cover. */
export async function PATCH(request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  if (!patchSchema.safeParse(json).success) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const { id, imageId } = await params
  const result = await makeCover(db, id, imageId)
  if (result.status === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })

  revalidatePath(`/recipes/${result.slug}`)
  return NextResponse.json({ ok: true })
}

/**
 * `DELETE /api/recipes/[id]/images/[imageId]` — delete the photo and its
 * blobs. A 502 means storage refused and the photo is still there, intact;
 * see `removePhoto` for why storage goes first.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id, imageId } = await params
  const result = await removePhoto(db, createVercelBlobStore(), id, imageId)
  if (result.status === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (result.status === 'storage_failed') {
    return NextResponse.json({ error: 'storage_failed' }, { status: 502 })
  }

  revalidatePath(`/recipes/${result.slug}`)
  return new NextResponse(null, { status: 204 })
}
```

- [ ] **Step 5: Raise the proxy body limit**

In `next.config.ts`, add to the config object (sibling of `images`):

```ts
  experimental: {
    // `src/proxy.ts` sits in front of every `/api/recipes/*` route, and Next
    // buffers a body for the proxy only up to this limit (10 MB by default).
    // Past it the route handler gets a *truncated* body with no error — a
    // large phone photo would arrive cut short and be refused as unreadable.
    // Photo uploads are capped at 15 MB (`MAX_IMAGE_BYTES`); this leaves room
    // for the multipart envelope. `tests/build/proxy-body-limit.test.ts`
    // holds the two together.
    proxyClientMaxBodySize: '17mb',
  },
```

If `tsc` rejects `proxyClientMaxBodySize` as an unknown key, check the key name in `node_modules/next/dist/server/config-shared.d.ts` and report rather than casting.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/api/recipe-images-route.test.ts tests/build/proxy-body-limit.test.ts && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/recipes/[id]/images next.config.ts tests/api/recipe-images-route.test.ts tests/build/proxy-body-limit.test.ts
git commit -m "Routes for a recipe's photos, and a proxy that passes a whole photo through

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The Photos section on the edit page

**Files:**
- Create: `src/components/recipe/photo-manager.tsx`
- Modify: `src/app/(app)/recipes/[slug]/edit/page.tsx`
- Test: `tests/components/photo-manager.test.tsx` (create)

**Interfaces:**
- Consumes: HTTP contract from Task 5; `DetailImage` (Task 1); `pickCover` (Task 1); `MAX_IMAGE_BYTES` from `@/lib/images/limits` (Task 3).
- Produces: `export function PhotoManager(props: { recipeId: string; photos: DetailImage[]; coverId: string | null }): JSX.Element` — a `'use client'` component.

**Behaviour (the tests are the contract):**
- Section heading "Photos" and a line: "Changes to photos save as soon as you make them."
- A list (`aria-label="Photos"`) of every photo, oldest first. Each item shows the thumbnail (`thumbUrl ?? blobUrl`, `alt=""`) or a "No preview" box when both are null.
- The cover item shows the text "Cover"; every other item has a **Make cover** button.
- Each item has **Delete**. Pressing it replaces the item's buttons with a question and **Delete photo** / **Cancel**. The question is "Delete this photo?", or for `role === 'source_hero'`: "Delete the publisher’s photo? Re-importing this recipe won’t bring it back."
- **Add photos**: a `<label>` styled as a button wrapping a visually hidden `<input type="file" multiple accept="image/jpeg,image/png,image/webp">`. Selected files upload **one at a time**, each as `FormData` with one `file`. A file over `MAX_IMAGE_BYTES` is refused in the browser without a request.
- Upload failures are listed by file name with the copy below, in a `role="alert"` region. Progress is announced in a `role="status"` region ("Uploading 1 of 2…").
- After any successful operation, `router.refresh()` (from `next/navigation`'s `useRouter`). After a failed cover/delete, an alert: "Couldn’t make that the cover. Try again." / "Couldn’t delete that photo — it’s still here. Try again."
- While an operation is in flight, all photo buttons and the file input are disabled.
- All buttons `min-h-11`.

Upload error copy, keyed by the route's `error`:

```ts
const UPLOAD_ERRORS: Record<string, string> = {
  too_large: 'Too large — photos can be up to 15 MB.',
  unsupported: 'Couldn’t read this image. Use a JPEG, PNG or WebP photo.',
  storage_failed: 'Couldn’t save this photo. Try again.',
}
const UPLOAD_FALLBACK = 'Couldn’t upload this photo. Try again.'
```

- [ ] **Step 1: Write the failing tests**

Create `tests/components/photo-manager.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { DetailImage } from '@/lib/db/queries/recipe-detail'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'
import { PhotoManager } from '@/components/recipe/photo-manager'

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

function photo(id: string, overrides: Partial<DetailImage> = {}): DetailImage {
  return {
    id,
    role: 'user',
    isCover: false,
    blobUrl: `https://blob.example.com/${id}.webp`,
    thumbUrl: `https://blob.example.com/${id}-thumb.webp`,
    width: 1600,
    height: 1200,
    ...overrides,
  }
}

const HERO = photo('hero', { role: 'source_hero' })
const MINE = photo('mine')

// Typed with both parameters so `mockImplementation((url, init) => …)` below
// typechecks — `tsc` covers `tests/` too.
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderManager(photos: DetailImage[] = [HERO, MINE], coverId: string | null = 'hero') {
  return render(<PhotoManager recipeId="r1" photos={photos} coverId={coverId} />)
}

function item(index: number) {
  return within(screen.getByRole('list', { name: 'Photos' })).getAllByRole('listitem')[index]
}

describe('PhotoManager', () => {
  it('marks the cover and offers every other photo as the cover', () => {
    renderManager()
    expect(within(item(0)).getByText('Cover')).toBeInTheDocument()
    expect(within(item(0)).queryByRole('button', { name: 'Make cover' })).not.toBeInTheDocument()
    expect(within(item(1)).getByRole('button', { name: 'Make cover' })).toBeInTheDocument()
  })

  it('shows a placeholder, not a broken image, for a photo with no stored URL', () => {
    renderManager([photo('legacy', { blobUrl: null, thumbUrl: null })], null)
    expect(within(item(0)).getByText('No preview')).toBeInTheDocument()
    expect(item(0).querySelector('img')).toBeNull()
  })

  it('makes a photo the cover and refreshes', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }))
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Make cover' }))

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1/images/mine', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ cover: true }),
    }))
  })

  it('says so when the cover could not be changed', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"not_found"}', { status: 404 }))
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Make cover' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t make that the cover.')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('asks before deleting, and Cancel sends nothing', async () => {
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete' }))
    expect(within(item(1)).getByText('Delete this photo?')).toBeInTheDocument()
    await userEvent.click(within(item(1)).getByRole('button', { name: 'Cancel' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(within(item(1)).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('deletes after confirmation and refreshes', async () => {
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete photo' }))

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1/images/mine', expect.objectContaining({ method: 'DELETE' }))
  })

  it('warns that a deleted publisher photo will not come back on re-import', async () => {
    renderManager()
    await userEvent.click(within(item(0)).getByRole('button', { name: 'Delete' }))
    expect(within(item(0)).getByText(/Re-importing this recipe won’t bring it back/)).toBeInTheDocument()
  })

  it('says the photo is still there when storage refused the delete', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"storage_failed"}', { status: 502 }))
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete photo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('it’s still here')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('accepts only formats the server can read', () => {
    renderManager()
    expect(screen.getByLabelText('Add photos')).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp')
    expect(screen.getByLabelText('Add photos')).toHaveAttribute('multiple')
  })

  it('uploads each chosen file in its own request, one after another', async () => {
    const order: string[] = []
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const file = (init!.body as FormData).get('file') as File
      order.push(`start ${file.name}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end ${file.name}`)
      return Response.json({ photo: photo(file.name) }, { status: 201 })
    })
    renderManager()

    await userEvent.upload(screen.getByLabelText('Add photos'), [
      new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' }),
    ])

    await waitFor(() => expect(order).toEqual(['start a.jpg', 'end a.jpg', 'start b.jpg', 'end b.jpg']))
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1/images', expect.objectContaining({ method: 'POST' }))
    for (const [, init] of fetchMock.mock.calls) {
      expect([...(init.body as FormData).keys()]).toEqual(['file'])
    }
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
  })

  it('refuses an oversized file in the browser without sending it', async () => {
    renderManager()

    await userEvent.upload(
      screen.getByLabelText('Add photos'),
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('huge.jpg')
    expect(screen.getByRole('alert')).toHaveTextContent('up to 15 MB')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the file the server could not read', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unsupported"}', { status: 415 }))
    renderManager()

    await userEvent.upload(
      screen.getByLabelText('Add photos'),
      new File([new Uint8Array([1])], 'odd.jpg', { type: 'image/jpeg' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('odd.jpg')
    expect(alert).toHaveTextContent('Couldn’t read this image.')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/components/photo-manager.test.tsx`
Expected: FAIL — cannot resolve `@/components/recipe/photo-manager`.

- [ ] **Step 3: Implement `PhotoManager`**

Create `src/components/recipe/photo-manager.tsx`. Required structure (styling via the app's existing tokens — `border-line`, `text-ink`, `text-ink-muted`, `bg-sunken`, `rounded-md`/`rounded-xl`, `transition-colors duration-(--dur-fast) ease-(--ease-out-quart)` — copied from neighbours such as `recipe-view.tsx:93` and `recipe-edit-form.tsx`):

```tsx
'use client'

import Image from 'next/image'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DetailImage } from '@/lib/db/queries/recipe-detail'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'

const UPLOAD_ERRORS: Record<string, string> = {
  too_large: 'Too large — photos can be up to 15 MB.',
  unsupported: 'Couldn’t read this image. Use a JPEG, PNG or WebP photo.',
  storage_failed: 'Couldn’t save this photo. Try again.',
}
const UPLOAD_FALLBACK = 'Couldn’t upload this photo. Try again.'

type UploadFailure = { name: string; message: string }

/**
 * The Photos section of the edit page: add photos, choose the cover, delete.
 *
 * Deliberately outside the recipe text form. Every change here takes effect
 * the moment it is made and is followed by `router.refresh()`, so the server
 * render — and the cover rule it applies — stays the only source of truth; a
 * rejected text save can never lose an upload, and an upload never needs a
 * Save.
 *
 * Uploads go one file per request, in sequence, matching the route's
 * one-file contract (see `POST /api/recipes/[id]/images`).
 */
export function PhotoManager({
  recipeId,
  photos,
  coverId,
}: {
  recipeId: string
  photos: DetailImage[]
  coverId: string | null
}) {
  const router = useRouter()
  const inputId = useId()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [failures, setFailures] = useState<UploadFailure[]>([])
  const [actionError, setActionError] = useState('')

  async function upload(files: File[]) {
    setBusy(true)
    setFailures([])
    setActionError('')
    const failed: UploadFailure[] = []
    let uploaded = 0

    for (const [index, file] of files.entries()) {
      setProgress(`Uploading ${index + 1} of ${files.length}…`)
      if (file.size > MAX_IMAGE_BYTES) {
        failed.push({ name: file.name, message: UPLOAD_ERRORS.too_large })
        continue
      }
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/recipes/${recipeId}/images`, { method: 'POST', body })
        if (res.ok) {
          uploaded += 1
          continue
        }
        const { error } = (await res.json().catch(() => ({}))) as { error?: string }
        failed.push({ name: file.name, message: (error && UPLOAD_ERRORS[error]) || UPLOAD_FALLBACK })
      } catch {
        failed.push({ name: file.name, message: UPLOAD_FALLBACK })
      }
    }

    setProgress('')
    setFailures(failed)
    setBusy(false)
    if (uploaded > 0) router.refresh()
  }

  async function act(request: () => Promise<Response>, failure: string) {
    setBusy(true)
    setActionError('')
    setFailures([])
    try {
      const res = await request()
      if (!res.ok) throw new Error(String(res.status))
      setConfirming(null)
      router.refresh()
    } catch {
      setActionError(failure)
    } finally {
      setBusy(false)
    }
  }

  const makeCover = (id: string) =>
    act(
      () => fetch(`/api/recipes/${recipeId}/images/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cover: true }),
      }),
      'Couldn’t make that the cover. Try again.',
    )

  const remove = (id: string) =>
    act(
      () => fetch(`/api/recipes/${recipeId}/images/${id}`, { method: 'DELETE' }),
      'Couldn’t delete that photo — it’s still here. Try again.',
    )

  // Render: a <ul aria-label="Photos"> of photos (thumbnail via next/image
  // with `unoptimized` and alt="", or a "No preview" box), each with the
  // Cover text / Make cover button and the Delete → confirm → Delete photo /
  // Cancel flow; then the Add photos <label htmlFor={inputId}> + hidden
  // <input id={inputId} type="file" multiple accept="image/jpeg,image/png,image/webp"
  // className="sr-only" disabled={busy} onChange={…}>; then a
  // <p role="status"> for `progress`; then, when there are failures or an
  // actionError, one <div role="alert"> listing `${name}: ${message}` lines
  // and/or `actionError`. In onChange: copy `event.target.files` to an array,
  // reset `event.target.value = ''` (so choosing the same file again fires),
  // then `void upload(files)`.
}
```

Write the JSX described in the final comment (replace the comment with it). Constraints: there must be at most one `role="alert"` element at a time (tests use `findByRole('alert')`); the confirm question text must be exactly as in *Behaviour*; the Add photos label must be the input's accessible name "Add photos"; the empty state (no photos) shows only the Add photos control plus the line "No photos yet."

- [ ] **Step 4: Run the component tests**

Run: `npx vitest run tests/components/photo-manager.test.tsx`
Expected: all PASS. If `userEvent.upload` drops files because of `accept` matching, pass files whose `type` is in the accept list (the tests already do) — do not loosen `accept`.

- [ ] **Step 5: Mount it on the edit page**

In `src/app/(app)/recipes/[slug]/edit/page.tsx`, import `PhotoManager` and `pickCover`, and between the intro `<p>` and `<RecipeEditForm …/>` add:

```tsx
      {/* Outside the form on purpose: photo changes save as they happen and
          neither need nor trigger the form's Save. */}
      <section aria-labelledby="photos-heading" className="mb-10">
        <h2 id="photos-heading" className="text-lg font-semibold">Photos</h2>
        <p className="mt-1 mb-4 text-sm text-ink-muted">
          Changes to photos save as soon as you make them.
        </p>
        <PhotoManager
          recipeId={recipe.id}
          photos={recipe.images}
          coverId={pickCover(recipe.images)?.id ?? null}
        />
      </section>
```

(If `PhotoManager` already renders its own heading/line from Step 3, keep them in exactly one place — the page — and remove the duplicate from the component. Update the test's expectations only if you moved the "Photos" heading text; the list's `aria-label` stays in the component.)

- [ ] **Step 6: Full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests`
Expected: all pass, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/recipe/photo-manager.tsx "src/app/(app)/recipes/[slug]/edit/page.tsx" tests/components/photo-manager.test.tsx
git commit -m "A Photos section on the edit page: add, choose the cover, delete

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The rest of the photos on the recipe page

**Files:**
- Create: `src/components/recipe/photo-strip.tsx`
- Modify: `src/components/recipe/recipe-view.tsx` (directly after the hero `<Image … />`, inside `<header>`)
- Test: `tests/components/recipe-page.test.tsx` (new `describe`)

**Interfaces:**
- Consumes: `DetailImage`, `pickCover` (Task 1).
- Produces: `export function PhotoStrip(props: { photos: DetailImage[] }): JSX.Element` — `'use client'`; every photo passed must have a non-null `blobUrl`.

**Behaviour:**
- A `<ul aria-label="More photos">` of buttons, one per photo, each labelled `View photo N of M` and containing the thumbnail (`thumbUrl ?? blobUrl`, `alt=""`, `unoptimized`, lazy — no `priority`).
- Pressing one opens a native `<dialog aria-label="Photo">` via `showModal()`, showing the full-size `blobUrl` (`alt=""`, `unoptimized`) and a **Close** button (`min-h-11 min-w-11`). Close calls `dialog.close()`; the dialog's `close` event clears the selection (so Escape works too). A click on the backdrop (event target is the dialog itself) closes it.
- `RecipeView` renders `<PhotoStrip photos={others} />` only when `others.length > 0`, where `others = recipe.images.filter((image) => image.blobUrl && image.id !== hero?.id)`.

- [ ] **Step 1: Write the failing tests**

jsdom does not implement `HTMLDialogElement.prototype.showModal`/`close`. Add to `tests/components/recipe-page.test.tsx`:

```tsx
describe('more photos', () => {
  beforeEach(() => {
    // jsdom has no modal dialog. These stand-ins do the two things the
    // component relies on: toggle `open`, and fire `close` on close().
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  })

  const img = (id: string, overrides: Partial<RecipeDetail['images'][number]> = {}) => ({
    id,
    role: 'user' as const,
    isCover: false,
    blobUrl: `https://blob.example.com/${id}.webp`,
    thumbUrl: `https://blob.example.com/${id}-thumb.webp`,
    width: 1600,
    height: 1200,
    ...overrides,
  })

  it('shows no strip when the cover is the only photo', () => {
    render(<RecipeView recipe={recipe({ images: [img('hero', { role: 'source_hero' })] })} />)
    expect(screen.queryByRole('list', { name: 'More photos' })).not.toBeInTheDocument()
  })

  it('lists every photo except the cover, and nothing without a stored URL', () => {
    render(
      <RecipeView
        recipe={recipe({
          images: [
            img('hero', { role: 'source_hero' }),
            img('one'),
            img('legacy', { blobUrl: null, thumbUrl: null }),
            img('two'),
          ],
        })}
      />,
    )

    const strip = screen.getByRole('list', { name: 'More photos' })
    const buttons = within(strip).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['View photo 1 of 2', 'View photo 2 of 2'])
    expect([...strip.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'https://blob.example.com/one-thumb.webp',
      'https://blob.example.com/two-thumb.webp',
    ])
  })

  it('opens a photo full-size, and closes it again', async () => {
    render(<RecipeView recipe={recipe({ images: [img('hero', { role: 'source_hero' }), img('one')] })} />)

    await userEvent.click(screen.getByRole('button', { name: 'View photo 1 of 1' }))

    const dialog = screen.getByRole('dialog', { name: 'Photo' })
    expect(dialog).toHaveAttribute('open')
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'https://blob.example.com/one.webp')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(dialog).not.toHaveAttribute('open')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/components/recipe-page.test.tsx -t "more photos"`
Expected: FAIL — no list named "More photos".

- [ ] **Step 3: Implement `PhotoStrip`**

Create `src/components/recipe/photo-strip.tsx`:

```tsx
'use client'

import Image from 'next/image'
import { useRef, useState } from 'react'
import type { DetailImage } from '@/lib/db/queries/recipe-detail'

/**
 * The recipe's other photos, as a row of thumbnails under the cover; tapping
 * one opens it full-size.
 *
 * A native `<dialog>` opened with `showModal()`, so focus trapping, Escape and
 * the inert page behind it come from the browser rather than from code here.
 * The `close` event — fired by Escape, the Close button and a backdrop click
 * alike — is the one place the selection is cleared.
 *
 * Every photo passed in must have a `blobUrl`; `RecipeView` filters.
 */
export function PhotoStrip({ photos }: { photos: DetailImage[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState<DetailImage | null>(null)

  function open(photo: DetailImage) {
    setSelected(photo)
    dialogRef.current?.showModal()
  }

  return (
    <>
      <ul aria-label="More photos" className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {photos.map((photo, index) => (
          <li key={photo.id} className="shrink-0">
            <button
              type="button"
              aria-label={`View photo ${index + 1} of ${photos.length}`}
              onClick={() => open(photo)}
              className="block overflow-hidden rounded-md border border-line transition-opacity duration-(--dur-fast) hover:opacity-85"
            >
              <Image
                src={(photo.thumbUrl ?? photo.blobUrl)!}
                alt=""
                width={96}
                height={Math.round((96 * photo.height) / photo.width)}
                unoptimized
                className="size-20 object-cover sm:size-24"
              />
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialogRef}
        aria-label="Photo"
        onClose={() => setSelected(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
        className="m-auto max-h-[92vh] max-w-[min(92vw,1100px)] rounded-xl bg-canvas p-0 backdrop:bg-black/70"
      >
        {selected?.blobUrl && (
          <div className="relative">
            <Image
              src={selected.blobUrl}
              alt=""
              width={selected.width}
              height={selected.height}
              unoptimized
              className="max-h-[92vh] w-auto object-contain"
            />
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="absolute top-2 right-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-canvas/90 px-3 text-sm font-medium text-ink"
            >
              Close
            </button>
          </div>
        )}
      </dialog>
    </>
  )
}
```

Check `src/app/globals.css` for the real background token name before using `bg-canvas`; use whatever the page background token is (e.g. the one `body` uses).

- [ ] **Step 4: Render it from `RecipeView`**

In `src/components/recipe/recipe-view.tsx`, import `PhotoStrip`, and after `const hero = pickCover(recipe.images)` add:

```ts
  // Everything renderable that is not already the cover. Empty when there is
  // no cover, because `pickCover` only comes back empty-handed when nothing
  // is renderable.
  const others = recipe.images.filter((image) => image.blobUrl && image.id !== hero?.id)
```

and directly after the hero `{hero?.blobUrl && (<Image … />)}` block, inside `<header>`:

```tsx
          {others.length > 0 && <PhotoStrip photos={others} />}
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/recipe/photo-strip.tsx src/components/recipe/recipe-view.tsx tests/components/recipe-page.test.tsx
git commit -m "Show a recipe's other photos under its cover

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Controller checkpoint (not a subagent task): look at it, then choose

After Task 7, the controller (not an implementer subagent):

1. Runs `npx vitest run && npx tsc --noEmit && npx eslint src tests && npx next build`.
2. Starts the dev server against a scratch copy of the local database, uploads photos to a recipe, and captures screenshots of the edit page's Photos section and the recipe page's strip + dialog at phone (375px) and desktop widths.
3. Shows the user rendered options for the Photos section placement/layout and the strip, per their stated preference to choose from screenshots, and applies the chosen direction.
4. Reminds the user that HEIC-on-iPhone must be verified on a real phone after deploy, and that the migration must be applied (`npm run db:migrate`) before the deploy that ships this.
