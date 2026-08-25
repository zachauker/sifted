import Image from 'next/image'
import Link from 'next/link'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { formatMinutes } from '@/lib/format'
import { effectiveTimeMinutes } from '@/lib/library/filter'
import { PhotoFallback } from './photo-fallback'

/**
 * Thumbnails are generated at 480px by `ingestHeroImage`, which is already
 * the widest a card is ever drawn — so there is nothing for Next's image
 * optimizer to do but re-encode a file that was encoded for this exact
 * purpose, at a per-image cost, on a host that would additionally have to
 * be whitelisted in `next.config.ts` (`remotePatterns`) before it would
 * serve at all. `unoptimized` keeps lazy loading and the reserved
 * width/height that stop the grid jumping, and skips the rest.
 *
 * If a second, larger rendition is ever needed here, this is the line to
 * revisit — and `next.config.ts` will need a
 * `**.public.blob.vercel-storage.com` remote pattern at the same time.
 */
const THUMB_WIDTH = 480
const THUMB_HEIGHT = 360

export function RecipeCard({ entry }: { entry: LibraryEntry }) {
  const minutes = effectiveTimeMinutes(entry)

  return (
    <li>
      <Link
        href={`/recipes/${entry.slug}`}
        className="group block rounded-lg outline-offset-4 focus-visible:outline-2"
      >
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800">
          {entry.thumbUrl ? (
            <Image
              src={entry.thumbUrl}
              // Empty on purpose: the title is right below, as text. A card
              // that announces its title twice is worse than one that
              // announces it once.
              alt=""
              width={THUMB_WIDTH}
              height={THUMB_HEIGHT}
              unoptimized
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            />
          ) : (
            <PhotoFallback title={entry.title} />
          )}
          {entry.status === 'made_it' && (
            <span className="absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white">
              Made it
            </span>
          )}
        </div>

        <h2 className="mt-2 text-sm leading-snug font-medium group-hover:underline">
          {entry.title}
        </h2>

        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500 dark:text-neutral-400">
          {entry.publisher && <span>{entry.publisher}</span>}
          {entry.rating !== null && (
            <span>
              <span aria-hidden="true">{'★'.repeat(entry.rating)}</span>
              <span className="sr-only">
                {entry.rating} {entry.rating === 1 ? 'star' : 'stars'}
              </span>
            </span>
          )}
          {minutes !== null && (
            <span>
              {formatMinutes(minutes)}
              {/* A measured time is a different kind of fact from a
                  publisher's claim, and the card says which it is showing. */}
              {entry.actualTimeMinutes !== null && <span className="sr-only"> (measured)</span>}
            </span>
          )}
        </p>
      </Link>
    </li>
  )
}
