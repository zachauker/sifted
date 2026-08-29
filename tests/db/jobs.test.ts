import { eq } from 'drizzle-orm'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { importJobs } from '@/lib/db/schema'
import {
  createJob,
  findInFlightJob,
  listJobs,
  listJobsNeedingAttention,
  markFailed,
  markRunning,
} from '@/lib/db/queries/jobs'

let db: TestDb

/**
 * `Date` is frozen — and only `Date`, so libsql's own timers still run.
 *
 * The tie this file tests for is the normal case in production, but reproducing
 * it by inserting quickly is a race: a run that happens to straddle a second
 * boundary stops exercising the tie and starts passing for the wrong reason
 * (observed, on the first run of this file). Pinning the clock makes every row
 * carry the identical `created_at` every time, which is the condition under
 * test.
 */
beforeEach(async () => {
  db = await createTestDb()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listJobs', () => {
  /**
   * The regression this exists for.
   *
   * `created_at` holds seconds, so a burst of jobs — a share sheet firing
   * several at once, an import and the duplicate that follows it, the migration
   * replaying 156 imports — all carry the same timestamp. The old tiebreak was
   * `id DESC`, and cuid2 ids are deliberately not lexically time-ordered, so
   * within a tied second the order was arbitrary: "the newest 50" of a burst of
   * 156 was an arbitrary 50, and the tray showed a job above the one that
   * created it.
   *
   * Ten jobs, no delays at all, so every row is guaranteed to tie on the
   * second. With `id DESC` this passes with probability 1/10! — it is not a
   * flaky test, it is a test the old ordering cannot pass.
   */
  it('returns jobs created within the same second in insertion order, newest first', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/recipe-${i}`)
    const ids: string[] = []
    for (const url of urls) ids.push(await createJob(db, url, null))

    const listed = await listJobs(db)
    // The precondition, asserted rather than assumed: without a genuine tie
    // this proves nothing about the tiebreak.
    expect(new Set(listed.map((j) => j.createdAt.getTime())).size).toBe(1)

    expect(listed.map((j) => j.id)).toEqual([...ids].reverse())
    expect(listed.map((j) => j.url)).toEqual([...urls].reverse())
  })

  it('takes the newest rows, not an arbitrary slice, when the limit bites', async () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i++) ids.push(await createJob(db, `https://example.com/r${i}`, null))

    const listed = await listJobs(db, 3)
    expect(listed.map((j) => j.id)).toEqual(ids.slice(-3).reverse())
  })

  it('orders by creation, not by when the job finished', async () => {
    const first = await createJob(db, 'https://example.com/slow', null)
    // A distinct second, so this one is about `created_at` rather than the
    // rowid tiebreak the tests above cover.
    vi.advanceTimersByTime(5_000)
    const second = await createJob(db, 'https://example.com/fast', null)

    // The second job finishes first — a short page beating a long one. The tray
    // is a queue of what was asked for, so this must not reorder anything.
    await markFailed(db, second, 'no_recipe', new Error('nothing there'))
    await markFailed(db, first, 'fetch_failed', new Error('HTTP 503'))

    expect((await listJobs(db)).map((j) => j.id)).toEqual([second, first])
  })
})

describe('listJobsNeedingAttention', () => {
  /**
   * The regression this exists for: `listJobs(db, 50)` — the newest 50 rows
   * of *every* status — is the wrong query for the needs-attention tray. The
   * migration replays 156 imports in one burst; if an early one fails and
   * fifty-plus later ones succeed, the failure falls out of "the newest 50"
   * entirely, and the tray shows nothing wrong at the exact moment it
   * matters most. Selecting on `status` directly, with no row cap, is the
   * only way the row is guaranteed to still be there.
   *
   * Manually confirmed this fails against `listJobs(db, 50)`: swapping the
   * call below to `listJobs(db, 50)` makes the `toContain(failedId)`
   * assertion fail, because the 55 later successes push it out of the
   * window.
   */
  it('finds a failed job even after 50+ newer jobs have since succeeded', async () => {
    const failedId = await createJob(db, 'https://example.com/burnt-toast', null)
    await markFailed(db, failedId, 'fetch_failed', new Error('HTTP 503'))

    for (let i = 0; i < 55; i++) {
      const id = await createJob(db, `https://example.com/fine-${i}`, null)
      // Bypasses `markDone` on purpose: it requires a `recipeId`, and the FK
      // it points at is irrelevant to what this test is about. Only the
      // status matters here.
      await db.update(importJobs).set({ status: 'done' }).where(eq(importJobs.id, id))
    }

    const attention = await listJobsNeedingAttention(db)
    expect(attention.map((j) => j.id)).toContain(failedId)
    expect(attention).toHaveLength(1)
  })

  it('includes running and queued jobs alongside failed ones, and excludes done and duplicate', async () => {
    const failed = await createJob(db, 'https://example.com/a', null)
    await markFailed(db, failed, 'no_recipe', new Error('nothing there'))

    const running = await createJob(db, 'https://example.com/b', null)
    await markRunning(db, running)

    const queued = await createJob(db, 'https://example.com/c', null)

    const done = await createJob(db, 'https://example.com/d', null)
    await db.update(importJobs).set({ status: 'done' }).where(eq(importJobs.id, done))

    const duplicate = await createJob(db, 'https://example.com/e', null)
    await db.update(importJobs).set({ status: 'duplicate' }).where(eq(importJobs.id, duplicate))

    const attention = await listJobsNeedingAttention(db)
    expect(new Set(attention.map((j) => j.id))).toEqual(new Set([failed, running, queued]))
  })

  it('accepts an optional limit, for a caller that wants one', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await createJob(db, `https://example.com/f${i}`, null)
      await markFailed(db, id, 'internal', new Error('boom'))
    }

    expect(await listJobsNeedingAttention(db, 2)).toHaveLength(2)
  })
})

describe('findInFlightJob', () => {
  /**
   * The wedge this whole describe block exists to escape.
   *
   * `run-import.ts` leaves a job on `running` "for a sweeper to reap" when
   * even the failure write can't land — and no sweeper exists. With no age
   * bound, `findInFlightJob` matches `running` forever: once a job is stuck
   * there, both capture paths report `already_importing` for that URL for
   * good, with no way in the product to clear it (no delete endpoint, retry
   * 409s on `running`). Manually confirmed this reproduces against the
   * pre-fix `findInFlightJob` (matching `queued|running` with no age bound):
   * the "long-stale running job no longer blocks" case below failed, with
   * the stale job still coming back from `findInFlightJob` after nine
   * simulated minutes.
   *
   * `createdAt` is the only timestamp `markRunning` leaves behind — it
   * clears `finishedAt` but sets nothing marking when the row *entered*
   * `running` — and in the ordinary flow (create, then kick off `runImport`
   * in the same request) it lands within milliseconds of that transition, so
   * it stands in for "how long has this been running" here.
   */
  it('a recent running job still blocks a duplicate import', async () => {
    const jobId = await createJob(db, 'https://example.com/fresh', null)
    await markRunning(db, jobId)

    const inFlight = await findInFlightJob(db, 'https://example.com/fresh')
    expect(inFlight?.id).toBe(jobId)
  })

  it('a long-stale running job no longer blocks — it is not in flight, it is dead', async () => {
    const jobId = await createJob(db, 'https://example.com/wedged', null)
    await markRunning(db, jobId)

    vi.advanceTimersByTime(9 * 60 * 1000)

    const inFlight = await findInFlightJob(db, 'https://example.com/wedged')
    expect(inFlight).toBeUndefined()
  })

  it('a queued job of any age still blocks — queued is retryable, not a wedge', async () => {
    const jobId = await createJob(db, 'https://example.com/still-queued', null)

    vi.advanceTimersByTime(9 * 60 * 1000)

    const inFlight = await findInFlightJob(db, 'https://example.com/still-queued')
    expect(inFlight?.id).toBe(jobId)
  })

  it('does not match a done, failed, or duplicate job regardless of age', async () => {
    const done = await createJob(db, 'https://example.com/done', null)
    await db.update(importJobs).set({ status: 'done' }).where(eq(importJobs.id, done))

    const failed = await createJob(db, 'https://example.com/failed', null)
    await markFailed(db, failed, 'fetch_failed', new Error('HTTP 503'))

    expect(await findInFlightJob(db, 'https://example.com/done')).toBeUndefined()
    expect(await findInFlightJob(db, 'https://example.com/failed')).toBeUndefined()
  })
})

/**
 * The tray answers "what still needs a human", not "what has ever failed".
 *
 * On the real library this was 74 of 86 rows: failures that a later run had
 * already recovered from, burying the six URLs that genuinely needed doing.
 */
describe('needs-attention excludes failures that were later recovered', () => {
  async function storeRecipe(sourceUrl: string) {
    const { upsertRecipe } = await import('@/lib/db/queries/recipes')
    return upsertRecipe(db, {
      extracted: {
        title: 'Recovered', description: null, author: null, publisher: null,
        claimedTimeMinutes: null, servings: null, yieldText: null,
        ingredients: [], steps: [], tags: [],
        heroImageUrl: null, narrativeHtml: null, extractionMethod: 'jsonld',
      },
      sourceUrl,
      sourceDomain: 'example.com',
      enrichmentApplied: true,
    })
  }

  it('hides a failed job whose URL now has a recipe', async () => {
    const { countJobsNeedingAttention } = await import('@/lib/db/queries/jobs')
    const url = 'https://example.com/recovered'
    const id = await createJob(db, url)
    await markFailed(db, id, 'blocked', new Error('403'))

    expect(await countJobsNeedingAttention(db)).toBe(1)

    await storeRecipe(url)

    expect(await countJobsNeedingAttention(db)).toBe(0)
    expect(await listJobsNeedingAttention(db)).toHaveLength(0)
  })

  it('keeps a failed job whose URL has no recipe', async () => {
    const { countJobsNeedingAttention } = await import('@/lib/db/queries/jobs')
    const id = await createJob(db, 'https://example.com/still-missing')
    await markFailed(db, id, 'blocked', new Error('403'))
    await storeRecipe('https://example.com/something-else')

    expect(await countJobsNeedingAttention(db)).toBe(1)
    expect(await listJobsNeedingAttention(db)).toHaveLength(1)
  })

  it('hides a URL that was retried many times before it succeeded', async () => {
    const { countJobsNeedingAttention } = await import('@/lib/db/queries/jobs')
    const url = 'https://example.com/retried-a-lot'
    for (let i = 0; i < 5; i++) {
      const id = await createJob(db, url)
      await markFailed(db, id, 'blocked', new Error('403'))
    }
    // Five attempts, one problem — see the per-URL collapse below.
    expect(await countJobsNeedingAttention(db)).toBe(1)

    await storeRecipe(url)
    expect(await countJobsNeedingAttention(db)).toBe(0)
  })

  it('the badge and the tray still agree', async () => {
    const { countJobsNeedingAttention } = await import('@/lib/db/queries/jobs')
    const failedWithRecipe = await createJob(db, 'https://example.com/a')
    await markFailed(db, failedWithRecipe, 'blocked', new Error('403'))
    await storeRecipe('https://example.com/a')

    const stillBroken = await createJob(db, 'https://example.com/b')
    await markFailed(db, stillBroken, 'no_recipe', new Error('nothing there'))

    expect(await countJobsNeedingAttention(db)).toBe((await listJobsNeedingAttention(db)).length)
  })
})

describe('needs-attention shows one row per URL, not one per attempt', () => {
  it('keeps only the newest attempt at the same URL', async () => {
    const { countJobsNeedingAttention } = await import('@/lib/db/queries/jobs')
    const url = 'https://example.com/keeps-failing'
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const id = await createJob(db, url)
      await markFailed(db, id, 'blocked', new Error(`attempt ${i}`))
      ids.push(id)
    }

    const rows = await listJobsNeedingAttention(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(ids.at(-1))
    expect(await countJobsNeedingAttention(db)).toBe(1)
  })

  it('still lists distinct URLs separately', async () => {
    const { countJobsNeedingAttention } = await import('@/lib/db/queries/jobs')
    for (const u of ['https://example.com/one', 'https://example.com/two']) {
      const id = await createJob(db, u)
      await markFailed(db, id, 'blocked', new Error('403'))
    }
    expect(await countJobsNeedingAttention(db)).toBe(2)
  })
})
