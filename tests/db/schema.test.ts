import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { users, apiTokens } from '@/lib/db/schema'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

describe('users', () => {
  it('assigns a cuid2 id and a created timestamp', async () => {
    const [row] = await db.insert(users)
      .values({ name: 'Zach', email: 'zach@example.com', passwordHash: 'x' })
      .returning()

    expect(row.id).toMatch(/^[a-z0-9]{20,}$/)
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('rejects a duplicate email', async () => {
    await db.insert(users).values({ name: 'A', email: 'same@example.com', passwordHash: 'x' })
    await expect(
      db.insert(users).values({ name: 'B', email: 'same@example.com', passwordHash: 'y' }),
    ).rejects.toThrow()
  })
})

describe('api_tokens', () => {
  it('links to a user and starts unrevoked', async () => {
    const [user] = await db.insert(users)
      .values({ name: 'Zach', email: 'z@example.com', passwordHash: 'x' }).returning()

    const [token] = await db.insert(apiTokens)
      .values({ userId: user.id, label: "Zach's iPhone", tokenHash: 'hash-1' }).returning()

    expect(token.revokedAt).toBeNull()
    expect(token.lastUsedAt).toBeNull()

    const found = await db.select().from(apiTokens).where(eq(apiTokens.userId, user.id))
    expect(found).toHaveLength(1)
  })

  it('rejects a duplicate token hash', async () => {
    const [user] = await db.insert(users)
      .values({ name: 'Z', email: 'z2@example.com', passwordHash: 'x' }).returning()
    await db.insert(apiTokens).values({ userId: user.id, label: 'a', tokenHash: 'dup' })
    await expect(
      db.insert(apiTokens).values({ userId: user.id, label: 'b', tokenHash: 'dup' }),
    ).rejects.toThrow()
  })
})
