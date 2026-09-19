/**
 * The fields the cover rule reads. Structural, so both `DetailImage` rows and
 * anything shaped like them can be passed without a mapping step.
 */
export type CoverCandidate = {
  role: 'source_hero' | 'user'
  isCover: boolean
  blobUrl: string | null
  thumbUrl: string | null
}

/**
 * True when a photo has both stored renditions and so can actually be drawn
 * on a page: the full image `<Image>` falls back to, and the thumbnail every
 * grid and strip prefers. A row with only one of the two — half-written by an
 * interrupted upload, or a legacy row backfilled for one column but not the
 * other — is not renderable and must be treated the same as a row with
 * neither: fall through to the next candidate, and offer no "make cover"
 * control for it.
 *
 * The one predicate both `pickCover` (below) and its SQL twin in
 * `buildLibraryIndex` are built from, so "renderable" means the same thing in
 * memory and in the query, and so `PhotoManager` and `RecipeView` agree with
 * both about which photos are candidates at all.
 */
export function isRenderable(image: Pick<CoverCandidate, 'blobUrl' | 'thumbUrl'>): boolean {
  return Boolean(image.blobUrl && image.thumbUrl)
}

/**
 * The one picture that stands for a recipe: the photo a person chose, else the
 * publisher's, else the oldest.
 *
 * Only renderable rows (see `isRenderable`) are candidates. Rows missing
 * either stored URL — ingested before the URL columns existed, or left
 * half-written by a failed upload — have nothing complete to render, and must
 * fall through to the next candidate rather than render as a broken `<img>`.
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
  const renderable = images.filter(isRenderable)
  return (
    renderable.find((image) => image.isCover) ??
    renderable.find((image) => image.role === 'source_hero') ??
    renderable[0]
  )
}
