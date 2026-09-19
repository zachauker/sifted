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
