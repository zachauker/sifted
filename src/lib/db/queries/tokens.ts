import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { apiTokens } from '@/lib/db/schema'

/**
 * SHA-256, not bcrypt.
 *
 * bcrypt's cost exists to slow brute force against low-entropy human passwords.
 * These tokens are 32 bytes from a CSPRNG — there is nothing to brute force —
 * and bcrypt would add ~100ms to every single import request for no security
 * gain. A fast digest plus a constant-time comparison is the right tool.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type IssuedToken = { token: string; tokenId: string }

export async function issueToken(db: Db, userId: string, label: string): Promise<IssuedToken> {
  const token = randomBytes(32).toString('base64url')
  const [row] = await db.insert(apiTokens)
    .values({ userId, label, tokenHash: hashToken(token) })
    .returning({ id: apiTokens.id })
  return { token, tokenId: row.id }
}

export type VerifiedToken = { userId: string; tokenId: string }

export async function verifyToken(db: Db, token: string): Promise<VerifiedToken | null> {
  const candidate = token?.trim()
  if (!candidate) return null

  const digest = hashToken(candidate)
  const row = await db.select().from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, digest), isNull(apiTokens.revokedAt)))
    .get()
  if (!row) return null

  // The lookup above already matched on the digest, so this comparison is
  // belt-and-braces against any future change that widens the query.
  const a = Buffer.from(digest, 'hex')
  const b = Buffer.from(row.tokenHash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id))
  return { userId: row.userId, tokenId: row.id }
}

export async function revokeToken(db: Db, tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId))
}
