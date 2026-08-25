import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

/**
 * Real database, only `auth` mocked — same reasoning as
 * `tests/api/search-route.test.ts`: the interesting behavior here is
 * `upsertRecipe` plus SQLite's actual handling of a nullable-but-unique
 * `source_url`, and a test that mocked `upsertRecipe` would prove nothing
 * about either.
 */
const mocks = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db')
  return { db: await createTestDb() }
})

const { db } = await import('@/lib/db')
const { POST } = await import('@/app/api/recipes/manual/route')
const { recipes, ingredients, steps, users } = await import('@/lib/db/schema')

function makeRequest(body: unknown) {
  return new Request('https://app.example.com/api/recipes/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let userId: string

beforeEach(async () => {
  vi.clearAllMocks()
  // `recipes.added_by` is a foreign key into `users`, so the session's
  // `user.id` has to be a real row, not just a plausible-looking string.
  const [user] = await db.insert(users)
    .values({ name: 'Zach', email: `manual-route-${Math.random()}@example.com`, passwordHash: 'x' })
    .returning()
  userId = user.id
  mocks.auth.mockResolvedValue({ user: { id: userId } })
})

describe('POST /api/recipes/manual', () => {
  it('returns 401 when the caller is anonymous', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await POST(makeRequest({ title: 'Ham Pot Pie' }))
    expect(res.status).toBe(401)
  })

  it('saves a manual recipe with a null sourceUrl, extractionMethod manual', async () => {
    const res = await POST(
      makeRequest({
        title: 'Ham Pot Pie',
        ingredients: 'leftover ham\npie crust',
        steps: 'Assemble.\nBake at 375 for 45 minutes.',
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { recipeId: string; slug: string }
    expect(body.recipeId).toEqual(expect.any(String))
    expect(body.slug).toEqual(expect.any(String))

    const row = await db.select().from(recipes).where(eq(recipes.id, body.recipeId)).get()
    expect(row?.sourceUrl).toBeNull()
    expect(row?.extractionMethod).toBe('manual')
    expect(row?.title).toBe('Ham Pot Pie')
    expect(row?.addedBy).toBe(userId)
  })

  it('requires a title', async () => {
    const res = await POST(makeRequest({ title: '' }))
    expect(res.status).toBe(400)

    const res2 = await POST(makeRequest({}))
    expect(res2.status).toBe(400)
  })

  it('is accepted with ingredients and no steps at all — a real recipe shape', async () => {
    const res = await POST(
      makeRequest({ title: 'Just a spice mix', ingredients: 'paprika\ncumin\nsalt' }),
    )
    expect(res.status).toBe(201)
    const { recipeId } = (await res.json()) as { recipeId: string }

    const stepRows = await db.select().from(steps).where(eq(steps.recipeId, recipeId))
    expect(stepRows).toHaveLength(0)
    const ingredientRows = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipeId))
    expect(ingredientRows).toHaveLength(3)
  })

  it('stores ingredient lines verbatim in rawText, with quantity/unit/item/note null', async () => {
    const res = await POST(
      makeRequest({
        title: 'Verbatim test',
        ingredients: '2 cups flour, sifted\na pinch of salt',
      }),
    )
    const { recipeId } = (await res.json()) as { recipeId: string }
    const rows = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipeId))
    const byText = rows.sort((a, b) => a.position - b.position)
    expect(byText.map((r) => r.rawText)).toEqual(['2 cups flour, sifted', 'a pinch of salt'])
    for (const row of byText) {
      expect(row.quantity).toBeNull()
      expect(row.unit).toBeNull()
      expect(row.item).toBeNull()
      expect(row.note).toBeNull()
    }
  })

  it('skips blank lines between ingredients rather than storing them as empty rows', async () => {
    const res = await POST(
      makeRequest({
        title: 'Blank line test',
        ingredients: 'flour\n\n   \nsugar\n',
      }),
    )
    const { recipeId } = (await res.json()) as { recipeId: string }
    const rows = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipeId))
    expect(rows.map((r) => r.rawText).sort()).toEqual(['flour', 'sugar'])
  })

  it('handles Windows \\r\\n line endings the same as \\n, with no stray \\r left in rawText', async () => {
    const res = await POST(
      makeRequest({
        title: 'CRLF test',
        ingredients: 'flour\r\nsugar\r\nsalt\r\n',
        steps: 'Mix.\r\nBake.\r\n',
      }),
    )
    const { recipeId } = (await res.json()) as { recipeId: string }
    const ingredientRows = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipeId))
    expect(ingredientRows).toHaveLength(3)
    for (const row of ingredientRows) {
      expect(row.rawText).not.toContain('\r')
    }
    const stepRows = await db.select().from(steps).where(eq(steps.recipeId, recipeId))
    expect(stepRows).toHaveLength(2)
    for (const row of stepRows) {
      expect(row.text).not.toContain('\r')
    }
  })

  it('holds up with 40 ingredients pasted at once, preserving order via position', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `ingredient ${i + 1}`)
    const res = await POST(
      makeRequest({ title: 'Forty ingredients', ingredients: lines.join('\r\n') }),
    )
    expect(res.status).toBe(201)
    const { recipeId } = (await res.json()) as { recipeId: string }
    const rows = (await db.select().from(ingredients).where(eq(ingredients.recipeId, recipeId)))
      .sort((a, b) => a.position - b.position)
    expect(rows).toHaveLength(40)
    expect(rows.map((r) => r.rawText)).toEqual(lines)
  })

  it('saves optional claimedTimeMinutes and servings when provided', async () => {
    const res = await POST(
      makeRequest({ title: 'Timed recipe', claimedTimeMinutes: 45, servings: 6 }),
    )
    const { recipeId } = (await res.json()) as { recipeId: string }
    const row = await db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
    expect(row?.claimedTimeMinutes).toBe(45)
    expect(row?.servings).toBe(6)
  })

  it('leaves claimedTimeMinutes and servings null when omitted', async () => {
    const res = await POST(makeRequest({ title: 'Untimed recipe' }))
    const { recipeId } = (await res.json()) as { recipeId: string }
    const row = await db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
    expect(row?.claimedTimeMinutes).toBeNull()
    expect(row?.servings).toBeNull()
  })

  // The self-review probe: `recipes.source_url` is UNIQUE but nullable
  // (`src/lib/db/schema.ts`). Two manual recipes both have a null
  // source_url, and this proves SQLite treats each NULL as distinct for a
  // UNIQUE constraint rather than colliding on it — the behavior manual
  // entry depends on, verified against the real database rather than
  // assumed.
  it('lets two manual recipes with no source URL coexist', async () => {
    const first = await POST(makeRequest({ title: 'Ham Pot Pie' }))
    expect(first.status).toBe(201)
    const second = await POST(makeRequest({ title: 'Grandma’s Chili' }))
    expect(second.status).toBe(201)

    const firstBody = (await first.json()) as { recipeId: string }
    const secondBody = (await second.json()) as { recipeId: string }
    expect(firstBody.recipeId).not.toBe(secondBody.recipeId)

    // A direct `WHERE source_url = NULL` never matches in SQL (NULL isn't
    // equal to anything, including itself) — select everything and filter
    // in JS instead, which is the point of this assertion: both rows
    // genuinely carry a null `source_url` and both exist side by side,
    // proving SQLite's UNIQUE constraint treats each NULL as distinct
    // rather than colliding on it.
    const nullSourced = (await db.select().from(recipes)).filter((r) => r.sourceUrl === null)
    expect(nullSourced.map((r) => r.id)).toEqual(
      expect.arrayContaining([firstBody.recipeId, secondBody.recipeId]),
    )
  })
})
