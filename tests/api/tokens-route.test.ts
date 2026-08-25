import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Real database, only `auth` mocked — same reasoning as
 * `tests/api/search-route.test.ts`. The behavior worth proving here is real
 * revoke/verify interaction between two tokens, which a mocked query layer
 * would just assert its own mock was called correctly and prove nothing.
 */
const mocks = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db')
  return { db: await createTestDb() }
})

const { db } = await import('@/lib/db')
const { GET, POST } = await import('@/app/api/tokens/route')
const { DELETE } = await import('@/app/api/tokens/[id]/route')
const { users } = await import('@/lib/db/schema')
const { verifyToken } = await import('@/lib/db/queries/tokens')

function postRequest(body: unknown) {
  return new Request('https://app.example.com/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteRequest() {
  return new Request('https://app.example.com/api/tokens/x', { method: 'DELETE' })
}

async function makeUser(label: string) {
  const [user] = await db.insert(users)
    .values({ name: label, email: `${label}-${Math.random()}@example.com`, passwordHash: 'x' })
    .returning()
  return user.id
}

let userId: string

beforeEach(async () => {
  vi.clearAllMocks()
  userId = await makeUser('zach')
  mocks.auth.mockResolvedValue({ user: { id: userId } })
})

describe('GET /api/tokens', () => {
  it('returns 401 when the caller is anonymous', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('lists issued tokens by label and last use, newest first', async () => {
    await POST(postRequest({ label: 'phone A' }))
    await POST(postRequest({ label: 'phone B' }))

    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: { label: string; lastUsedAt: unknown }[] }
    expect(body.tokens.map((t) => t.label)).toEqual(['phone B', 'phone A'])
    expect(body.tokens.every((t) => t.lastUsedAt === null)).toBe(true)
  })

  it('never includes the token value or its hash', async () => {
    await POST(postRequest({ label: 'phone A' }))
    const res = await GET()
    const text = await res.text()
    expect(text).not.toContain('tokenHash')
    expect(text).not.toContain('token_hash')
  })

  it("only lists the calling user's own tokens", async () => {
    await POST(postRequest({ label: 'mine' }))

    const otherUserId = await makeUser('someone-else')
    mocks.auth.mockResolvedValue({ user: { id: otherUserId } })
    const res = await GET()
    const body = (await res.json()) as { tokens: unknown[] }
    expect(body.tokens).toEqual([])
  })
})

describe('POST /api/tokens', () => {
  it('returns 401 when the caller is anonymous', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await POST(postRequest({ label: 'phone' }))
    expect(res.status).toBe(401)
  })

  it('issues a token and returns its plaintext value exactly once', async () => {
    const res = await POST(postRequest({ label: "Zach's iPhone" }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; tokenId: string }
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(body.tokenId).toEqual(expect.any(String))

    // The value just handed back actually works as a bearer credential.
    expect(await verifyToken(db, body.token)).toEqual({ userId, tokenId: body.tokenId })
  })

  it('requires a non-empty label', async () => {
    const res = await POST(postRequest({ label: '' }))
    expect(res.status).toBe(400)
    const res2 = await POST(postRequest({}))
    expect(res2.status).toBe(400)
  })
})

describe('DELETE /api/tokens/[id]', () => {
  it('returns 401 when the caller is anonymous', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: 'whatever' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 for an id that does not exist', async () => {
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: 'not-a-real-id' }) })
    expect(res.status).toBe(404)
  })

  it("returns 404 (not 200) for a token that exists but belongs to someone else", async () => {
    const issued = await POST(postRequest({ label: 'phone' }))
    const { tokenId } = (await issued.json()) as { tokenId: string }

    const otherUserId = await makeUser('someone-else')
    mocks.auth.mockResolvedValue({ user: { id: otherUserId } })

    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: tokenId }) })
    expect(res.status).toBe(404)
  })

  // The self-review probe, and the entire reason tokens are per-device: a
  // lost phone's token can be revoked without disturbing the other one.
  it('revoking one token leaves the other working', async () => {
    const a = await POST(postRequest({ label: 'phone A' }))
    const b = await POST(postRequest({ label: 'phone B' }))
    const aBody = (await a.json()) as { token: string; tokenId: string }
    const bBody = (await b.json()) as { token: string; tokenId: string }

    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: aBody.tokenId }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'revoked' })

    expect(await verifyToken(db, aBody.token)).toBeNull()
    expect(await verifyToken(db, bBody.token)).toEqual({ userId, tokenId: bBody.tokenId })
  })

  it('shows a revoked token as revoked in the list rather than removing it', async () => {
    const issued = await POST(postRequest({ label: 'lost phone' }))
    const { tokenId } = (await issued.json()) as { tokenId: string }
    await DELETE(deleteRequest(), { params: Promise.resolve({ id: tokenId }) })

    const res = await GET()
    const body = (await res.json()) as { tokens: { id: string; revokedAt: unknown }[] }
    const row = body.tokens.find((t) => t.id === tokenId)
    expect(row?.revokedAt).not.toBeNull()
  })
})
