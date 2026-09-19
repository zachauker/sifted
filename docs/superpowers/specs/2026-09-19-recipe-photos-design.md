# Recipe Photos — Design

**Date:** 2026-09-19
**Status:** Approved, ready for implementation planning

## Problem

A recipe's picture is whatever the import found, and nothing else. The
`images` table has always allowed many rows per recipe and a `'user'` role,
but nothing writes either: there is no way to add a photo of the dish as we
actually made it, no way to replace a bad publisher photo, and no way to get
rid of one. Recipes recovered from a Notion body, or typed in by hand, have no
picture at all and no way to get one short of `npm run images -- --recipe=…`.

This is sub-project 2 from the in-app editing spec
(`2026-08-29-in-app-recipe-editing-design.md`), which named its risks: the
first inbound file this app has ever accepted, HEIC from an iPhone, request
size, and `RecipeView`'s hard preference for `source_hero`.

## Scope

- Upload one or more photos to a recipe.
- Choose which photo is the cover (the recipe page's hero and the library
  card's thumbnail).
- Delete a photo, removing its full-size and thumbnail blobs from storage.
- Show a recipe's other photos on the recipe page.

Out of scope: reordering, captions/alt text, cropping, restoring a deleted
publisher photo from the UI (the `--recipe --from` escape hatch still works),
and recipe deletion's blob cleanup (sub-project 3).

## Data model

One migration, two non-null boolean columns with defaults, so every
existing row keeps its current behaviour:

- **`images.is_cover`** (`integer` boolean, default `false`). At most one
  `true` per recipe, maintained by the cover `PATCH` (see *API*).
- **`recipes.source_hero_dismissed`** (`integer` boolean, default `false`).
  Set when a person deletes the recipe's `source_hero` image. It means "the
  publisher's photo was looked at and rejected", and it is what stops a
  re-import from bringing it back.

Rejected: `recipes.cover_image_id` referencing `images.id`. It makes the two
tables reference each other, and `ON DELETE SET NULL` behaviour depends on
`PRAGMA foreign_keys`, which nothing in this codebase currently asserts. A flag
on the image keeps the cover and the image in one row.

### The cover rule

One rule, used everywhere a single picture stands for the recipe:

1. the image with `is_cover = true`, else
2. the `source_hero` image, else
3. the oldest image (`created_at`, then `rowid`),

considering **only images with a non-null URL** — rows ingested before the URL
columns existed have keys but nothing renderable, and must fall through rather
than render as a broken `<img>`.

The fallback is the point: deleting the cover never leaves a recipe that still
has photos showing none, and a re-import that replaces the `source_hero` row
cannot orphan the choice, because an explicit cover lives on a `user` row the
import never touches.

It is implemented twice, deliberately kept identical:

- **`pickCover(images)`** in TypeScript, for `RecipeView` (which already has
  every image row via `getRecipeBySlug`). `DetailImage` gains `id` and
  `isCover`.
- **A correlated subquery** in `buildLibraryIndex`, replacing the
  `source_hero` left join:
  `(SELECT thumb_url FROM images WHERE recipe_id = recipes.id AND thumb_url IS NOT NULL ORDER BY is_cover DESC, role = 'source_hero' DESC, created_at ASC, rowid ASC LIMIT 1)`.
  This also retires the join's fan-out risk and the de-dupe loop that guards
  against it.

A shared test table of image sets runs against both, so they cannot drift.

## Blob keys

Uploads are written to `recipes/<recipeId>/photos/<cuid>.webp` and
`recipes/<recipeId>/photos/<cuid>-thumb.webp`. The cuid is generated per
upload, so an upload can never overwrite another upload or the import's fixed
`hero.webp` / `hero-thumb.webp`, and the `allowOverwrite: true` the Vercel
store passes is harmless for these keys.

## Image processing

The sharp half of `ingestHeroImage` — metadata, EXIF-orientation-aware width
and height, rotate, 1600px WebP at q82, 480px WebP at q74 — moves into a shared
`renderImage(bytes)` in `src/lib/images`. `ingestHeroImage` keeps its fetch,
content-type and SVG checks and calls it; behaviour is unchanged and its
existing tests stand.

A new **`ingestUploadedImage({ bytes, recipeId, store })`** in the same module:

- rejects empty input and anything over the existing 15 MB `MAX_SOURCE_BYTES`;
- rejects SVG by sniffing the bytes with the existing `looksLikeSvg` (the
  provenance argument is weaker for a file we chose, but the cost of refusing
  it is nothing, and one rule is easier to hold than two);
- runs `renderImage`, which rejects anything sharp cannot decode;
- writes the full-size blob, then the thumbnail;
- if the thumbnail write fails, best-effort deletes the full-size blob before
  failing, so a failed upload leaves nothing behind.

Unlike `ingestHeroImage`, it reports *why* it refused (`too_large`,
`unsupported`, `storage_failed`) instead of returning null — a person chose
this file and is waiting for an answer.

**HEIC.** sharp's prebuilt binaries do not decode HEIC. The file input declares
`accept="image/jpeg,image/png,image/webp"`, which makes iOS Safari transcode a
HEIC library photo to JPEG before upload. If a HEIC file arrives anyway it
fails as `unsupported` with copy that says so. Verified on a real iPhone
before this ships.

## API

All three are session-authenticated like `PATCH /api/recipes/[id]` (the API
tokens are for the Shortcut, which only imports), return 404 for an unknown
recipe or an image that is not that recipe's, and revalidate
`/recipes/<slug>` the way the edit action does.

### `POST /api/recipes/[id]/images`

`multipart/form-data` with **exactly one** `file` field. One file per request
keeps every request under both the 15 MB image cap and the platform body
limit, gives each file its own success or error in the UI, and means one bad
file cannot sink a batch. The client uploads a multi-file selection
sequentially.

Inserts a `role: 'user'`, `is_cover: false` row and returns it (`201`). Errors:
`400` for a missing/extra field, `413` for `too_large`, `415` for
`unsupported`, `502` for `storage_failed`.

### `PATCH /api/recipes/[id]/images/[imageId]`

Body `{ "cover": true }` (strict object; `cover: false` is not offered — to
change the cover you choose another). In one transaction: clear `is_cover` on
the recipe's images, set it on this one. Returns `200`.

### `DELETE /api/recipes/[id]/images/[imageId]`

1. Delete the full-size blob, then the thumbnail blob, via `BlobStore.delete`.
2. Only if both succeed, in one transaction: delete the row, and if its role
   was `source_hero`, set `recipes.source_hero_dismissed = true`.

If a blob delete fails the row stays, the photo stays visible, and the
response is `502` — "deleted" always means gone from storage. Vercel Blob's
`del` is a no-op for a missing key, so retrying a half-finished delete is
safe. Returns `204`.

## Import respects a dismissed photo

`runImport` skips hero ingestion entirely when the recipe's
`source_hero_dismissed` is set, rather than downloading a photo it will not
keep. `npm run images -- --missing` skips dismissed recipes for the same
reason. `--recipe --from` is an explicit override and is left alone.

A new recipe is never dismissed, so first imports are unaffected.

## UI

### Edit page: a Photos section

A `PhotoManager` client component on `/recipes/<slug>/edit`, in its own
section **outside** the recipe text form. Photo operations take effect
immediately; they neither need nor trigger the form's Save, and a rejected
text save cannot lose an upload.

- A grid of every photo (thumbnails). The cover wears a "Cover" badge; every
  other photo has a **Make cover** button.
- Each photo has **Delete**, which asks for confirmation. Deleting the
  publisher's photo says that re-importing will not bring it back.
- **Add photos** opens a multi-select file picker. Each file shows as a
  pending tile while it uploads and becomes a photo or an inline error
  ("Too large — 15 MB max", "Couldn't read this image").
- After each success, `router.refresh()` so the server-rendered data (and the
  cover rule) stays the single source of truth.
- Buttons meet the app's existing tap-target floor; errors are announced via
  a live region.

### Recipe page: a thumbnail strip

The cover renders exactly where the hero does now, via `pickCover`. When the
recipe has other renderable photos, a row of thumbnails sits under it; tapping
one opens it full-size in a native `<dialog>` (Escape and a close button
dismiss it). No strip when there is only the cover.

Before final styling, render options for the Photos section and the strip in
the browser and choose from screenshots.

## Testing

- **`renderImage` / `ingestUploadedImage`** against the memory store: happy
  path writes two keys under `photos/`; oversize, empty, SVG and undecodable
  inputs are refused with the right reason and write nothing; a failing
  thumbnail write leaves no full-size blob behind.
- **Cover rule:** one table of image sets (explicit cover, source hero only,
  user only, null-URL rows, none) asserted against both `pickCover` and
  `buildLibraryIndex`.
- **Routes:** auth required; 404 across recipes; upload inserts a `user` row;
  cover is exclusive after two PATCHes; DELETE removes both keys from the
  memory store and the row; a failing `delete` leaves the row; deleting a
  `source_hero` sets the flag.
- **Import:** a dismissed recipe re-imports without calling
  `ingestHeroImage`; an undismissed one still replaces its hero.
- **Components:** `PhotoManager` upload/error/cover/delete-confirm flows;
  `RecipeView` renders the strip only with more than one photo and opens the
  dialog.
