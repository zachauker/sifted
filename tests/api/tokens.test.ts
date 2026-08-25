import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { issueToken, verifyToken, revokeToken } from '@/lib/db/queries/tokens'
import { users, apiTokens } from '@/lib/db/schema'

let db: TestDb
let userId: string

beforeEach(async () => {
  db = await createTestDb()
  const [user] = await db.insert(users)
    .values({ name: 'Zach', email: 'z@example.com', passwordHash: 'x' }).returning()
  userId = user.id
})

describe('issueToken', () => {
  it('returns a high-entropy token and stores only its hash', async () => {
    const { token } = await issueToken(db, userId, "Zach's iPhone")

    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId))
    expect(row.tokenHash).not.toContain(token)
    expect(row.label).toBe("Zach's iPhone")
  })

  it('produces a different token every time', async () => {
    const a = await issueToken(db, userId, 'a')
    const b = await issueToken(db, userId, 'b')
    expect(a.token).not.toBe(b.token)
  })
})

describe('verifyToken', () => {
  it('accepts a valid token and returns the owner', async () => {
    const { token } = await issueToken(db, userId, 'phone')
    expect(await verifyToken(db, token)).toEqual({ userId, tokenId: expect.any(String) })
  })

  it('rejects a wrong token', async () => {
    await issueToken(db, userId, 'phone')
    expect(await verifyToken(db, 'not-a-real-token')).toBeNull()
  })

  it('rejects an empty or malformed token without throwing', async () => {
    expect(await verifyToken(db, '')).toBeNull()
    expect(await verifyToken(db, '   ')).toBeNull()
  })

  it('rejects a revoked token', async () => {
    const { token, tokenId } = await issueToken(db, userId, 'lost phone')
    await revokeToken(db, tokenId)
    expect(await verifyToken(db, token)).toBeNull()
  })

  it('records last use', async () => {
    const { token } = await issueToken(db, userId, 'phone')
    await verifyToken(db, token)
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId))
    expect(row.lastUsedAt).toBeInstanceOf(Date)
  })

  it('revoking one phone leaves the other working', async () => {
    const keep = await issueToken(db, userId, 'phone A')
    const lose = await issueToken(db, userId, 'phone B')
    await revokeToken(db, lose.tokenId)

    expect(await verifyToken(db, lose.token)).toBeNull()
    expect(await verifyToken(db, keep.token)).not.toBeNull()
  })
})
