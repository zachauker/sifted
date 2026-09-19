'use client'

import Image from 'next/image'
import { useRef, useState } from 'react'
import type { DetailImage } from '@/lib/db/queries/recipe-detail'

/**
 * The recipe's other photos, as a row of thumbnails under the cover; tapping
 * one opens it full-size.
 *
 * A native `<dialog>` opened with `showModal()`, so focus trapping, Escape and
 * the inert page behind it come from the browser rather than from code here.
 * The `close` event — fired by Escape, the Close button and a backdrop click
 * alike — is the one place the selection is cleared.
 *
 * Every photo passed in must have a `blobUrl`; `RecipeView` filters.
 */
export function PhotoStrip({ photos }: { photos: DetailImage[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState<DetailImage | null>(null)

  function open(photo: DetailImage) {
    setSelected(photo)
    dialogRef.current?.showModal()
  }

  return (
    <>
      <ul aria-label="More photos" className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {photos.map((photo, index) => (
          <li key={photo.id} className="shrink-0">
            <button
              type="button"
              aria-label={`View photo ${index + 1} of ${photos.length}`}
              onClick={() => open(photo)}
              className="block overflow-hidden rounded-md border border-line transition-opacity duration-(--dur-fast) hover:opacity-85"
            >
              <Image
                src={(photo.thumbUrl ?? photo.blobUrl)!}
                alt=""
                width={96}
                height={Math.round((96 * photo.height) / photo.width)}
                unoptimized
                className="size-20 object-cover sm:size-24"
              />
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialogRef}
        aria-label="Photo"
        onClose={() => setSelected(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
        // `bg-bg` is the page background token (see `body` in globals.css) —
        // the brief's `bg-canvas` does not exist in this app's theme.
        className="m-auto max-h-[92vh] max-w-[min(92vw,1100px)] rounded-xl bg-bg p-0 backdrop:bg-black/70"
      >
        {selected?.blobUrl && (
          <div className="relative">
            <Image
              src={selected.blobUrl}
              alt=""
              width={selected.width}
              height={selected.height}
              unoptimized
              className="max-h-[92vh] w-auto object-contain"
            />
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="absolute top-2 right-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-bg/90 px-3 text-sm font-medium text-ink"
            >
              Close
            </button>
          </div>
        )}
      </dialog>
    </>
  )
}
