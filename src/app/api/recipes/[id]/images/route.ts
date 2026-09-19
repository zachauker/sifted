import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { addPhoto } from '@/lib/images/photos'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'

/**
 * `POST /api/recipes/[id]/images` — one uploaded photo.
 *
 * Exactly one `file` per request, and the client sends a multi-photo pick one
 * file at a time. That keeps every request under the upload cap and the
 * platform's body limit, gives each photo its own success or failure, and
 * means one unreadable file cannot sink the rest.
 *
 * A route handler rather than a Server Action: photo changes take effect
 * immediately and independently of the edit form's Save, and a Server Action
 * would also need its 1 MB body limit raised app-wide.
 *
 * Session-authenticated, like every write the browser makes; the API tokens
 * are for the Shortcut, which only imports.
 */
const STATUS = { not_found: 404, too_large: 413, unsupported: 415, storage_failed: 502 } as const

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const entries = [...form.entries()]
  const file = entries[0]?.[1]
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(file instanceof File)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // `formData()` above has already read the whole request body — there is no
  // way to check size before that. What this check skips is the copy into a
  // `Uint8Array` and the decode/resize work in `addPhoto`, for a file that is
  // already known to be too large to store.
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 })
  }

  const { id } = await params
  const result = await addPhoto(db, createVercelBlobStore(), id, new Uint8Array(await file.arrayBuffer()))

  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: STATUS.not_found })
  }
  if (result.status === 'rejected') {
    return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] })
  }

  revalidatePath(`/recipes/${result.slug}`)
  return NextResponse.json({ photo: result.photo }, { status: 201 })
}
