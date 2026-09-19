'use client'

import Image from 'next/image'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DetailImage } from '@/lib/db/queries/recipe-detail'
import { isRenderable } from '@/lib/images/cover'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'

const UPLOAD_ERRORS: Record<string, string> = {
  too_large: 'Too large — photos can be up to 15 MB.',
  unsupported: 'Couldn’t read this image. Use a JPEG, PNG or WebP photo.',
  storage_failed: 'Couldn’t save this photo. Try again.',
}
const UPLOAD_FALLBACK = 'Couldn’t upload this photo. Try again.'

type UploadFailure = { name: string; message: string }

const buttonClass =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-line px-3 text-sm font-medium text-ink transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * The Photos section of the edit page: add photos, choose the cover, delete.
 *
 * Deliberately outside the recipe text form. Every change here takes effect
 * the moment it is made and is followed by `router.refresh()`, so the server
 * render — and the cover rule it applies — stays the only source of truth; a
 * rejected text save can never lose an upload, and an upload never needs a
 * Save.
 *
 * Uploads go one file per request, in sequence, matching the route's
 * one-file contract (see `POST /api/recipes/[id]/images`).
 */
export function PhotoManager({
  recipeId,
  photos,
  coverId,
}: {
  recipeId: string
  photos: DetailImage[]
  coverId: string | null
}) {
  const router = useRouter()
  const inputId = useId()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [failures, setFailures] = useState<UploadFailure[]>([])
  const [actionError, setActionError] = useState('')

  async function upload(files: File[]) {
    setBusy(true)
    setFailures([])
    setActionError('')
    const failed: UploadFailure[] = []
    let uploaded = 0

    for (const [index, file] of files.entries()) {
      setProgress(`Uploading ${index + 1} of ${files.length}…`)
      if (file.size > MAX_IMAGE_BYTES) {
        failed.push({ name: file.name, message: UPLOAD_ERRORS.too_large })
        continue
      }
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/recipes/${recipeId}/images`, { method: 'POST', body })
        if (res.ok) {
          uploaded += 1
          continue
        }
        const { error } = (await res.json().catch(() => ({}))) as { error?: string }
        // A platform-level 413 (a proxy or edge limit rejecting the body
        // before the route ever runs) does not come back as our JSON error
        // shape — it is plain text or HTML. The status code alone is still
        // enough to know what happened, so a 413 with no recognized `error`
        // falls back to the same too-large copy the route's own 413 gets.
        const message =
          (error && UPLOAD_ERRORS[error]) ||
          (res.status === 413 ? UPLOAD_ERRORS.too_large : undefined) ||
          UPLOAD_FALLBACK
        failed.push({ name: file.name, message })
      } catch {
        failed.push({ name: file.name, message: UPLOAD_FALLBACK })
      }
    }

    setProgress('')
    setFailures(failed)
    setBusy(false)
    if (uploaded > 0) router.refresh()
  }

  async function act(request: () => Promise<Response>, failure: string) {
    setBusy(true)
    setActionError('')
    setFailures([])
    try {
      const res = await request()
      if (!res.ok) throw new Error(String(res.status))
      setConfirming(null)
      router.refresh()
    } catch {
      setActionError(failure)
    } finally {
      setBusy(false)
    }
  }

  const makeCover = (id: string) =>
    act(
      () => fetch(`/api/recipes/${recipeId}/images/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cover: true }),
      }),
      'Couldn’t make that the cover. Try again.',
    )

  const remove = (id: string) =>
    act(
      () => fetch(`/api/recipes/${recipeId}/images/${id}`, { method: 'DELETE' }),
      'Couldn’t delete that photo — it’s still here. Try again.',
    )

  function onFilesChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    // Reset so choosing the exact same file again still fires a change event.
    event.target.value = ''
    if (files.length > 0) void upload(files)
  }

  return (
    <div>
      {photos.length === 0 && <p className="text-sm text-ink-muted">No photos yet.</p>}

      {photos.length > 0 && (
        <ul aria-label="Photos" className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {photos.map((photo) => {
            const isCover = photo.id === coverId
            const isConfirming = confirming === photo.id
            const preview = photo.thumbUrl ?? photo.blobUrl
            // Both cover-rule implementations (`pickCover` and the library's
            // SQL subquery) skip a photo missing either stored URL, so
            // offering "Make cover" on one would silently change nothing when
            // clicked.
            const canBeCover = isRenderable(photo)

            return (
              <li key={photo.id} className="flex flex-col gap-2">
                {preview ? (
                  <Image
                    src={preview}
                    alt=""
                    width={photo.width}
                    height={photo.height}
                    // Thumbnails are already 480px WebP — re-optimizing a
                    // file that was already encoded for this purpose would
                    // just spend a request per image for nothing.
                    unoptimized
                    className="aspect-square w-full rounded-md border border-line object-cover"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded-md border border-line bg-sunken text-xs text-ink-muted">
                    No preview
                  </div>
                )}

                {isConfirming ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-ink-muted">
                      {photo.role === 'source_hero'
                        ? 'Delete the publisher’s photo? Re-importing this recipe won’t bring it back.'
                        : 'Delete this photo?'}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(photo.id)}
                        className={`${buttonClass} border-danger text-danger`}
                      >
                        Delete photo
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                        className={buttonClass}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {isCover ? (
                      <span className="text-xs font-medium text-ink-muted">Cover</span>
                    ) : (
                      canBeCover && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void makeCover(photo.id)}
                          className={buttonClass}
                        >
                          Make cover
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(photo.id)}
                      className={buttonClass}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-4">
        <label htmlFor={inputId} className={buttonClass}>
          Add photos
        </label>
        <input
          id={inputId}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={onFilesChosen}
          className="sr-only"
        />
      </div>

      <p role="status" className="mt-2 text-sm text-ink-muted">
        {progress}
      </p>

      {(failures.length > 0 || actionError) && (
        <div role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {failures.map((failure, index) => (
            // Keyed by position, not `failure.name`: iOS routinely gives
            // picked photos identical filenames (e.g. two shots both named
            // "image.jpg"), and two failures sharing a name must still both
            // render rather than colliding on a React key.
            <p key={`${failure.name}-${index}`}>{`${failure.name}: ${failure.message}`}</p>
          ))}
          {actionError && <p>{actionError}</p>}
        </div>
      )}
    </div>
  )
}
