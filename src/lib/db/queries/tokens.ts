import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
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

/**
 * What the settings page shows: label and last use, per device, newest
 * first. Never the hash, never anything that could be mistaken for the
 * token itself — the plaintext value only ever exists in the response body
 * of `issueToken`'s caller, once, and this query has no way to produce it
 * again even if asked to.
 *
 * Includes revoked tokens rather than filtering them out: a device someone
 * already revoked (say, a lost phone) staying visible as "revoked" is the
 * confirmation that the revoke actually took, rather than the row just
 * quietly disappearing with no record it ever existed.
 *
 * Ordered by `created_at` then `rowid`, not `created_at` alone — the same
 * fix `listJobs` needed (see its comment in `src/lib/db/queries/jobs.ts`)
 * for the same reason: `created_at` only holds whole seconds, so issuing
 * two tokens in the same second (ordinary when someone sets up two phones
 * back to back) ties, and `rowid` is SQLite's own insertion-order counter,
 * which breaks that tie correctly at no extra cost.
 */
export type TokenSummary = {
  id: string
  label: string
  lastUsedAt: Date | null
  createdAt: Date
  revokedAt: Date | null
}

export async function listTokens(db: Db, userId: string): Promise<TokenSummary[]> {
  return db
    .select({
      id: apiTokens.id,
      label: apiTokens.label,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt), sql`${apiTokens}.rowid desc`)
}

/**
 * Who owns a token, so a revoke request can be checked against the session
 * before it acts — `revokeToken` itself trusts whatever id it's given, the
 * same way `updateUserFields`-style query functions elsewhere in this
 * codebase trust their caller and leave authorization to the route. Returns
 * `null` for an id that doesn't exist, which the route treats identically to
 * "exists but belongs to someone else": telling those two apart would let a
 * signed-in user probe for which token ids exist at all.
 */
export async function getTokenOwner(db: Db, tokenId: string): Promise<string | null> {
  const row = await db.select({ userId: apiTokens.userId }).from(apiTokens)
    .where(eq(apiTokens.id, tokenId)).get()
  return row?.userId ?? null
}
