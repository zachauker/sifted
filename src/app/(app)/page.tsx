import { db } from '@/lib/db'
import { buildLibraryIndex } from '@/lib/db/queries/library'
import { LibraryView } from '@/components/library/library-view'
import { parseFilterState } from '@/lib/library/filter'

/**
 * The library, server-rendered with its whole index inlined.
 *
 * **A deliberate deviation from the spec**, recorded in plan 4: the spec
 * describes fetching `/api/library-index` from the client and caching it in
 * IndexedDB. This calls `buildLibraryIndex` directly instead and hands the
 * entries to a client component as props. At 69KB for 156 recipes that is
 * strictly better — no fetch waterfall, no loading state on first paint, no
 * cache-invalidation logic and no IndexedDB code to maintain. The endpoint
 * still exists for anything built later.
 *
 * This file replaces the placeholder that stood at `src/app/page.tsx`,
 * which was deleted in the same commit: route groups add no URL segment, so
 * both files resolve to `/` and Next refuses to build with two pages at one
 * path. Living inside `(app)` is what gets the library the app-shell header.
 *
 * Reading `searchParams` opts this page into dynamic rendering, which is
 * what we want anyway: the index has to be current, and the session check
 * in the middleware already makes every request user-specific.
 */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [entries, params] = await Promise.all([buildLibraryIndex(db), searchParams])

  return <LibraryView entries={entries} initialState={parseFilterState(params)} />
}
