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
