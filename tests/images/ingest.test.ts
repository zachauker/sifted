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
})
