import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { searchRecipes } from '@/lib/db/queries/recipes'

/**
 * Tier 2 of search: inside recipes, via FTS5 over ingredients, steps, notes
 * and the narrative.
 *
 * `searchRecipes` already turns arbitrary user input into a valid FTS5
 * `MATCH` expression or `null` — a bare `(`, an unquoted `AND`, an unmatched
 * `"` are all syntax errors that would otherwise throw at the driver. This
 * route calls it directly and adds nothing of its own on top: teaching this
 * route to pre-clean the query would be a second, divergent sanitizer, and
 * `searchRecipes` already has one plus its own tests
 * (`tests/db/search.test.ts`).
 *
 * Returns ids only, not full recipe rows. The client already holds the
 * complete `LibraryEntry[]` from `/api/library-index` — an id is enough to
 * find and highlight the matching cards without shipping a second copy of
 * the same fields over the wire.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const q = new URL(request.url).searchParams.get('q') ?? ''
  const ids = await searchRecipes(db, q)
  return NextResponse.json({ ids })
}
