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
  it("stores a full image and a thumbnail under the recipe's photos prefix", async () => {
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
