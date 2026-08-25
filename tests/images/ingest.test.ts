import { describe, it, expect, vi, afterEach } from 'vitest'
import sharp from 'sharp'
import { ingestHeroImage } from '@/lib/images'
import { createMemoryStore } from '@/lib/storage/memory'

afterEach(() => { vi.unstubAllGlobals() })

async function pngBytes(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).png().toBuffer()
  return new Uint8Array(buf)
}

function stubFetch(bytes: Uint8Array<ArrayBuffer>, contentType = 'image/png', status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(status === 200 ? bytes : null, {
      status,
      headers: { 'content-type': contentType },
    }),
  ))
}

function svgBytes(): Uint8Array<ArrayBuffer> {
  const text =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
  return new Uint8Array(Buffer.from(text, 'utf-8'))
}

/**
 * A real, decodable PNG with an arbitrary trailing marker appended after the
 * real image data (well past the sniff window), simulating a metadata chunk
 * far from the start of the file. Uses random noise raw pixels with
 * compression disabled so the encoded PNG is reliably larger than the sniff
 * window, rather than collapsing to a few dozen bytes the way a solid-color
 * PNG would.
 */
async function pngBytesWithTrailingMarker(width: number, height: number, marker: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256)
  const png = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
  const trailer = Buffer.from(`; unrelated trailing marker: ${marker}`, 'utf-8')
  return new Uint8Array(Buffer.concat([png, trailer]))
}

describe('ingestHeroImage', () => {
  it('stores a full image and a thumbnail and reports dimensions', async () => {
    stubFetch(await pngBytes(1600, 900))
    const store = createMemoryStore()

    const result = await ingestHeroImage({
      url: 'https://example.com/hero.png', recipeId: 'rec123', store,
    })

    expect(result).not.toBeNull()
    expect(result!.width).toBe(1600)
    expect(result!.height).toBe(900)
    expect(store.keys().sort()).toEqual(
      ['recipes/rec123/hero-thumb.webp', 'recipes/rec123/hero.webp'],
    )
  })

  it('converts to webp', async () => {
    stubFetch(await pngBytes(800, 600))
    const store = createMemoryStore()
    await ingestHeroImage({ url: 'https://example.com/h.png', recipeId: 'r', store })

    const stored = await store.get('recipes/r/hero.webp')
    expect((await sharp(Buffer.from(stored!)).metadata()).format).toBe('webp')
  })

  it('caps the thumbnail width', async () => {
    stubFetch(await pngBytes(2000, 1000))
    const store = createMemoryStore()
    await ingestHeroImage({ url: 'https://example.com/h.png', recipeId: 'r', store })

    const thumb = await sharp(Buffer.from((await store.get('recipes/r/hero-thumb.webp'))!)).metadata()
    expect(thumb.width).toBe(480)
  })

  it('returns null when the image cannot be fetched', async () => {
    stubFetch(new Uint8Array(), 'image/png', 404)
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
    expect(store.keys()).toEqual([])
  })

  it('returns null for a non-image content type', async () => {
    stubFetch(await pngBytes(10, 10), 'text/html')
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x', recipeId: 'r', store })).toBeNull()
  })

  it('returns null for bytes sharp cannot decode', async () => {
    stubFetch(new Uint8Array([1, 2, 3, 4]), 'image/png')
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
  })

  it('returns null rather than throwing when the network rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
  })

  it('rejects a declared image/svg+xml content type and writes nothing', async () => {
    stubFetch(svgBytes(), 'image/svg+xml')
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.svg', recipeId: 'r', store })).toBeNull()
    expect(store.keys()).toEqual([])
  })

  it('still ingests a valid PNG declared as image/png (no regression)', async () => {
    stubFetch(await pngBytes(400, 300), 'image/png')
    const store = createMemoryStore()
    const result = await ingestHeroImage({ url: 'https://example.com/h.png', recipeId: 'r', store })
    expect(result).not.toBeNull()
    expect(result!.width).toBe(400)
    expect(result!.height).toBe(300)
  })

  it('rejects SVG bytes served with a spoofed image/png content type', async () => {
    stubFetch(svgBytes(), 'image/png')
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
    expect(store.keys()).toEqual([])
  })

  it('accepts a PNG that merely contains the text "<svg" well past the header', async () => {
    stubFetch(await pngBytesWithTrailingMarker(64, 64, '<svg>not the start of the file</svg>'), 'image/png')
    const store = createMemoryStore()
    const result = await ingestHeroImage({ url: 'https://example.com/h.png', recipeId: 'r', store })
    expect(result).not.toBeNull()
  })
})
