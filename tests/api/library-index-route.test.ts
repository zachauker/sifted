import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  buildLibraryIndex: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/library', () => ({ buildLibraryIndex: mocks.buildLibraryIndex }))

// Imported after the mocks above are registered so it resolves against the
// mocked modules rather than a real database and auth session.
const { GET } = await import('@/app/api/library-index/route')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.buildLibraryIndex.mockResolvedValue([{ id: 'recipe-1', tags: [] }])
})

describe('GET /api/library-index', () => {
  it('returns the library index for an authenticated session', async () => {
    const res = await GET()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [{ id: 'recipe-1', tags: [] }] })
  })

  it('returns 401 when the caller is anonymous, before touching the db', async () => {
    mocks.auth.mockResolvedValue(null)

    const res = await GET()

    expect(res.status).toBe(401)
    expect(mocks.buildLibraryIndex).not.toHaveBeenCalled()
  })
})
