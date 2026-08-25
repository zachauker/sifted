import sharp from 'sharp'
import type { BlobStore } from '@/lib/storage'

const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const FULL_MAX_WIDTH = 1600
const THUMB_WIDTH = 480
const TIMEOUT_MS = 15_000

export type IngestedImage = {
  blobKey: string
  thumbKey: string
  width: number
  height: number
}

export type IngestInput = {
  url: string
  recipeId: string
  store: BlobStore
}

/**
 * Downloads a source hero image, normalizes it, and stores both a display copy
 * and a grid thumbnail.
 *
 * We hold our own copy rather than hot-linking because the alternative decays:
 * Notion's image URLs expire in five minutes, and source blogs reorganize, go
 * behind Cloudflare, or die — a library you want to look at in three years has
 * to own its pictures.
 *
 * Returns null on any failure. A recipe without a picture is still a recipe;
 * a failed import because a CDN hiccuped is not acceptable.
 *
 * The same AbortSignal is passed to `fetch()` and stays attached for the
 * lifetime of the request, including the body read below — per the Fetch
 * spec, aborting the signal errors an in-flight `arrayBuffer()` the same way
 * it errors the initial connection, so a source that stalls mid-body is
 * still bounded by `TIMEOUT_MS` (see `src/lib/fetch/index.ts` for the same
 * pattern applied to page fetches).
 */
export async function ingestHeroImage(input: IngestInput): Promise<IngestedImage | null> {
  const { url, recipeId, store } = input

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let bytes: Uint8Array
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) return null

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType && !contentType.startsWith('image/')) return null

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_SOURCE_BYTES) return null
    bytes = new Uint8Array(buffer)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }

  try {
    const source = sharp(Buffer.from(bytes))
    const meta = await source.metadata()
    if (!meta.width || !meta.height) return null

    // `.rotate()` with no argument applies the EXIF orientation tag (when
    // present) and strips it, so the pixel data itself ends up upright and
    // downstream viewers — which mostly ignore EXIF — render correctly.
    // `meta.width`/`meta.height` are read BEFORE rotation and describe the
    // encoded raster, not the display orientation; for a 90/270-degree EXIF
    // orientation (5-8) sharp swaps the axes when rotating, so the reported
    // width/height would be transposed relative to the output pixels. We
    // only ever ingest photos in practice (orientation 1 or missing for the
    // vast majority of blog/CDN sources); if a rotated source ever reaches
    // here, swap width/height for orientation values 5-8 before returning.
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

    const blobKey = `recipes/${recipeId}/hero.webp`
    const thumbKey = `recipes/${recipeId}/hero-thumb.webp`

    await store.put(blobKey, new Uint8Array(full), 'image/webp')
    await store.put(thumbKey, new Uint8Array(thumb), 'image/webp')

    return { blobKey, thumbKey, width, height }
  } catch {
    return null
  }
}
