import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_REASONABLE_MINUTES } from '@/lib/extract/duration'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateUserFields: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
// Only `updateUserFields` is mocked; the module's other exports are untouched
// so nothing else that imports it changes behaviour under test.
vi.mock('@/lib/db/queries/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/recipes')>()
  return { ...actual, updateUserFields: mocks.updateUserFields }
})

const { PATCH } = await import('@/app/api/recipes/[id]/route')

const STORED = {
  rating: 5,
  status: 'made_it' as const,
  notes: 'Brine it in buttermilk.',
  actualTimeMinutes: 70,
}

function makeRequest(body: unknown, opts: { raw?: string } = {}) {
  return new Request('https://app.example.com/api/recipes/r1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
  })
}

function call(body: unknown, opts: { raw?: string; id?: string } = {}) {
  return PATCH(makeRequest(body, opts), { params: Promise.resolve({ id: opts.id ?? 'r1' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.updateUserFields.mockResolvedValue(STORED)
})

describe('PATCH /api/recipes/[id]', () => {
  it('applies the patch and returns the stored fields', async () => {
    const res = await call({ rating: 5 })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recipe: { id: 'r1', ...STORED } })
    expect(mocks.updateUserFields).toHaveBeenCalledWith({ marker: 'db' }, 'r1', { rating: 5 })
  })

  it('passes only the keys that were sent', async () => {
    await call({ notes: 'More salt.' })
    expect(mocks.updateUserFields).toHaveBeenCalledWith({ marker: 'db' }, 'r1', {
      notes: 'More salt.',
    })
  })

  it('accepts an explicit null as a clear', async () => {
    await call({ rating: null, status: null, notes: null, actualTimeMinutes: null })
    expect(mocks.updateUserFields).toHaveBeenCalledWith({ marker: 'db' }, 'r1', {
      rating: null,
      status: null,
      notes: null,
      actualTimeMinutes: null,
    })
  })

  it('returns 401 for a signed-out caller and never touches the database', async () => {
    mocks.auth.mockResolvedValue(null)

    const res = await call({ rating: 5 })

    expect(res.status).toBe(401)
    expect(mocks.updateUserFields).not.toHaveBeenCalled()
  })

  it('returns 404 when the recipe does not exist', async () => {
    mocks.updateUserFields.mockResolvedValue(null)

    const res = await call({ rating: 5 }, { id: 'no-such-recipe' })

    expect(res.status).toBe(404)
  })

  it('rejects a body that is not JSON', async () => {
    const res = await call(undefined, { raw: 'not json' })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid json' })
    expect(mocks.updateUserFields).not.toHaveBeenCalled()
  })

  it('rejects an empty patch rather than answering 200 to a no-op', async () => {
    const res = await call({})

    expect(res.status).toBe(400)
    expect(mocks.updateUserFields).not.toHaveBeenCalled()
  })

  it('rejects an unknown key rather than silently dropping it', async () => {
    // `{ ratings: 5 }` answered with 200 is a rating lost with no way to tell.
    const res = await call({ ratings: 5 })

    expect(res.status).toBe(400)
    expect(mocks.updateUserFields).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/recipes/[id] validation', () => {
  const rejected: Array<[string, unknown]> = [
    ['a rating above 5', { rating: 6 }],
    ['a rating below 0', { rating: -1 }],
    ['a fractional rating', { rating: 3.5 }],
    ['a rating that is a string', { rating: '5' }],
    ['a negative measured time', { actualTimeMinutes: -1 }],
    // 30 days is the ceiling `parseDurationMinutes` applies to a publisher's
    // own claim, for exactly the same reason: past it, the number is a typo
    // that would quietly distort every time filter it lands in.
    ['an absurd measured time', { actualTimeMinutes: MAX_REASONABLE_MINUTES + 1 }],
    ['a fractional measured time', { actualTimeMinutes: 90.5 }],
    ['an unrecognised status', { status: 'maybe_someday' }],
    ['notes longer than the cap', { notes: 'x'.repeat(10_001) }],
  ]

  for (const [what, body] of rejected) {
    it(`rejects ${what} with a 400 and never writes`, async () => {
      const res = await call(body)

      expect(res.status).toBe(400)
      expect(mocks.updateUserFields).not.toHaveBeenCalled()
    })
  }

  const accepted: Array<[string, unknown]> = [
    ['a rating of 0', { rating: 0 }],
    ['a rating of 5', { rating: 5 }],
    ['a measured time of 0', { actualTimeMinutes: 0 }],
    ['a measured time at the 30-day ceiling', { actualTimeMinutes: MAX_REASONABLE_MINUTES }],
    ['an empty note (a clear)', { notes: '' }],
    ['notes at the cap', { notes: 'x'.repeat(10_000) }],
    ['want_to_make', { status: 'want_to_make' }],
  ]

  for (const [what, body] of accepted) {
    it(`accepts ${what}`, async () => {
      const res = await call(body)

      expect(res.status).toBe(200)
      expect(mocks.updateUserFields).toHaveBeenCalledWith({ marker: 'db' }, 'r1', body)
    })
  }

  it('names the offending field so the form can put the message beside it', async () => {
    const res = await call({ rating: 6 })

    expect(await res.json()).toMatchObject({
      error: 'invalid body',
      issues: [{ field: 'rating' }],
    })
  })
})
