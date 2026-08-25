import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { buildLibraryIndex } from '@/lib/db/queries/library'

/**
 * The whole library, in one payload. This is what the browsing UI loads
 * once and then filters, sorts, and searches entirely in memory — see
 * `buildLibraryIndex` for why that stays cheap.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const entries = await buildLibraryIndex(db)
  return NextResponse.json({ entries })
}
