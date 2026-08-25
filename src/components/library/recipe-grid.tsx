import type { LibraryEntry } from '@/lib/db/queries/library'
import { RecipeCard } from './recipe-card'

/**
 * Every matching recipe, rendered at once — no virtualization.
 *
 * 156 cards is roughly 156 lazily-loaded 480px thumbnails and a few hundred
 * DOM nodes; the browser handles that without dropping a frame, and the
 * whole point of the design is that narrowing happens in the rail rather
 * than by scrolling. Virtualization here would buy nothing and cost
 * ctrl-F, anchor links, and correct scroll restoration. If the library ever
 * grows an order of magnitude, revisit — not before.
 */
export function RecipeGrid({ entries }: { entries: readonly LibraryEntry[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {entries.map((entry) => (
        <RecipeCard key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}
