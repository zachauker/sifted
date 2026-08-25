import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { getTokenOwner, revokeToken } from '@/lib/db/queries/tokens'

/**
 * Revoke one device's token without disturbing any other — the entire
 * reason tokens are per-device rather than per-account. See
 * `tests/api/tokens-route.test.ts` for the test that a second token keeps
 * working after this runs.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const ownerId = await getTokenOwner(db, id)

  // Same response whether the id doesn't exist or belongs to someone else:
  // this is only a two-account app, but there is no reason a signed-in user
  // should be able to tell those two cases apart.
  if (!ownerId || ownerId !== session.user.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  await revokeToken(db, id)
  return NextResponse.json({ status: 'revoked' })
}
