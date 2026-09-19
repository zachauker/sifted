import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { makeCover, removePhoto } from '@/lib/images/photos'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'

type Params = { params: Promise<{ id: string; imageId: string }> }

/**
 * `cover: true` only. There is no "un-cover": to change the cover you choose
 * another photo, and with no choice at all the cover rule already falls back
 * to the publisher's photo, then the oldest.
 */
const patchSchema = z.strictObject({ cover: z.literal(true) })

/** `PATCH /api/recipes/[id]/images/[imageId]` — make this photo the cover. */
export async function PATCH(request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  if (!patchSchema.safeParse(json).success) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const { id, imageId } = await params
  const result = await makeCover(db, id, imageId)
  if (result.status === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })

  revalidatePath(`/recipes/${result.slug}`)
  return NextResponse.json({ ok: true })
}

/**
 * `DELETE /api/recipes/[id]/images/[imageId]` — delete the photo and its
 * blobs. A 502 means storage refused and the photo is still there, intact;
 * see `removePhoto` for why storage goes first.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id, imageId } = await params
  const result = await removePhoto(db, createVercelBlobStore(), id, imageId)
  if (result.status === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (result.status === 'storage_failed') {
    return NextResponse.json({ error: 'storage_failed' }, { status: 502 })
  }

  revalidatePath(`/recipes/${result.slug}`)
  return new NextResponse(null, { status: 204 })
}
