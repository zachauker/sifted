import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { issueToken, listTokens } from '@/lib/db/queries/tokens'

/**
 * Token management for the settings page. Session-authenticated — this is a
 * page a signed-in human uses, not the Shortcut, so it belongs on the
 * cookie-based side of the bridge described in
 * `src/app/api/recipes/import/route.ts`.
 */

const bodySchema = z.object({
  label: z.string().trim().min(1).max(100),
})

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const tokens = await listTokens(db, session.user.id)
  return NextResponse.json({ tokens })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'a label is required' }, { status: 400 })
  }

  const { token, tokenId } = await issueToken(db, session.user.id, parsed.data.label)

  // The one and only place the plaintext value ever appears. Only its
  // SHA-256 hash is stored (`hashToken` in `src/lib/db/queries/tokens.ts`),
  // so there is no "show it again" — the settings page has to say that
  // plainly, because this response body is the last time this value exists
  // anywhere outside whatever the caller pastes it into next.
  return NextResponse.json({ token, tokenId }, { status: 201 })
}
