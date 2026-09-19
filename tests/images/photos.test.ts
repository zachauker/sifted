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

  it('keeps the row when the thumbnail delete fails after the full-size delete succeeds', async () => {
    // A half-finished delete: `store.delete` for the full-size blob resolves,
    // then the thumbnail delete throws. The row must survive so the photo
    // stays on screen — and because Vercel Blob's `del` is a no-op for a key
    // that is already gone, retrying is safe: it will not error a second time
    // on the blob that already succeeded.
    const recipe = await insertRecipe()
    const hero = await insertHero(recipe.id)
    let fullDeleted = false
    const failing: BlobStore = {
      ...store,
      async delete(key: string) {
        if (key.endsWith('-thumb.webp')) throw new Error('blob store unavailable')
        fullDeleted = true
        return store.delete(key)
      },
    }

    expect(await removePhoto(db, failing, recipe.id, hero.id)).toEqual({ status: 'storage_failed' })

    expect(fullDeleted).toBe(true)
    expect(store.keys()).toEqual([hero.thumbKey])
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
