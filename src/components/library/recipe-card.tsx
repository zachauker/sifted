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
  // Defense at the render boundary, independent of whatever the write path
  // guarantees: this card renders whatever `entry.rating` holds, including a
  // row written before `applyNotionMetadata` started clamping, or one edited
  // directly in the database. `'★'.repeat` throws `RangeError` on a negative
  // count and silently truncates a fractional one — clamping to a 0–5 whole
  // number here means one bad rating can never take the rest of the grid
  // down with it, and the star count and its screen-reader text always agree.
  const displayRating =
    entry.rating === null || !Number.isFinite(entry.rating)
      ? null
      : Math.min(5, Math.max(0, Math.round(entry.rating)))

  return (
    <li>
      <Link
        href={`/recipes/${entry.slug}`}
        className="group block rounded-lg outline-offset-4"
      >
        {/* Lifted rather than outlined, via `--shadow-raised` — a card in this
            interface is a thing sitting on the page, not a box drawn on it.
            Two short shadows rather than one long one, so a grid of 156 of
            these costs the compositor nothing. */}
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-sunken shadow-(--shadow-raised)">
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
              // Transform only, so the browser can run it off the main thread
              // and the grid never reflows on hover.
              className="h-full w-full object-cover transition-transform duration-(--dur-slow) ease-(--ease-out-quart) group-hover:scale-[1.04]"
            />
          ) : (
            <PhotoFallback title={entry.title} />
          )}
          {entry.status === 'made_it' && (
            // Sits on top of an arbitrary photo, so it carries its own opaque
            // ground rather than trusting whatever is behind it — a white pill
            // on a pale dish is the one case a translucent badge fails.
            <span className="absolute top-2 left-2 rounded-full bg-ink px-2 py-0.5 text-2xs font-medium text-bg shadow-sm">
              Made it
            </span>
          )}
        </div>

        <h2 className="mt-2.5 text-sm leading-snug font-medium text-ink underline-offset-2 group-hover:underline">
          {entry.title}
        </h2>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
          {entry.publisher && <span className="truncate">{entry.publisher}</span>}
          {displayRating !== null && (
            <span>
              {/* Amber, matching the rating control on the recipe page. These
                  used to be neutral grey here and accent-coloured there — the
                  same fact, in two different visual languages, on two screens
                  a click apart. */}
              <span aria-hidden="true" className="text-accent-text">
                {'★'.repeat(displayRating)}
              </span>
              <span className="sr-only">
                {displayRating} {displayRating === 1 ? 'star' : 'stars'}
              </span>
            </span>
          )}
          {minutes !== null && (
            <span className="font-num tabular-nums">
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
