import sharp from 'sharp'
import type { BlobStore } from '@/lib/storage'

const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const FULL_MAX_WIDTH = 1600
const THUMB_WIDTH = 480
const TIMEOUT_MS = 15_000

// Declared content types we refuse outright, on top of the general
// non-`image/*` rejection below. See `looksLikeSvg` for why SVG specifically
// is excluded rather than just left to sharp.
const DISALLOWED_IMAGE_CONTENT_TYPES = new Set(['image/svg+xml', 'image/svg'])

// How many bytes of the response body we inspect to sniff for SVG/XML. Real
// XML declarations and root elements appear in the first handful of bytes;
// this only needs to be big enough to survive a BOM plus leading whitespace.
const SVG_SNIFF_BYTES = 512

export type IngestedImage = {
  blobKey: string
  thumbKey: string
  /**
   * The public URL of the full-size display image (up to 1600px wide), taken
   * verbatim from what `store.put` returned — never reconstructed from
   * `blobKey`. A Vercel Blob URL is
   * `https://<storeId>.public.blob.vercel-storage.com/<key>`, and the store
   * id is not derivable from the key, so the store's own answer is the only
   * source of truth. This is the full image: a grid thumbnail must use
   * `thumbUrl` instead, or every card in a 156-recipe grid pulls a 1600px
   * image.
   */
  blobUrl: string
  /**
   * The public URL of the 480px grid thumbnail, taken verbatim from what
   * `store.put` returned. This is the one a photo grid should render.
   */
  thumbUrl: string
  width: number
  height: number
}

export type IngestInput = {
  url: string
  recipeId: string
  store: BlobStore
}

/**
 * True if `bytes` starts (after an optional UTF-8 BOM and leading
 * whitespace) with an XML declaration or an `<svg` root element.
 *
 * We exclude SVG from ingestion entirely, and it is a provenance decision,
 * not a reaction to a known defect in the currently vendored libvips.
 * `heroImageUrl` comes straight out of a third party's JSON-LD `image`
 * field on a page we imported, so both the URL and everything the server
 * behind it chooses to send — including a spoofed Content-Type — are
 * attacker-controlled. Rasterizing attacker-supplied XML through a C parser
 * stack is a risk class real recipe blogs simply never require: hero images
 * are JPEG, PNG, and WebP essentially without exception. That means this
 * check should stay even if a future audit finds the current libvips build
 * refuses external entities and network fetches (it does, as of this
 * writing) — the point is removing a class of input we have no reason to
 * accept, not patching a bug that was found. Do not delete this check on
 * the grounds that libvips "looks safe" today.
 *
 * Anchored to the very start of the buffer rather than scanning the whole
 * thing, so a PNG that merely contains the literal text "<svg" somewhere in
 * a metadata chunk is not misidentified.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let start = 0
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3
  }

  const end = Math.min(bytes.length, start + SVG_SNIFF_BYTES)
  let head = ''
  for (let i = start; i < end; i++) head += String.fromCharCode(bytes[i])
  head = head.replace(/^\s+/, '')

  return /^<\?xml/i.test(head) || /^<svg[\s>/]/i.test(head) || /^<!doctype\s+svg/i.test(head)
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
    if (DISALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) return null

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_SOURCE_BYTES) return null
    bytes = new Uint8Array(buffer)

    // The Content-Type header is just as attacker-controlled as the URL — a
    // server can declare `image/png` and send SVG bytes. Sniff the actual
    // content before it ever reaches sharp, rather than trusting the header
    // or relying on the parser to reject it.
    if (looksLikeSvg(bytes)) return null
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

    const blobResult = await store.put(blobKey, new Uint8Array(full), 'image/webp')
    const thumbResult = await store.put(thumbKey, new Uint8Array(thumb), 'image/webp')

    return {
      blobKey,
      thumbKey,
      blobUrl: blobResult.url,
      thumbUrl: thumbResult.url,
      width,
      height,
    }
  } catch {
    return null
  }
}
