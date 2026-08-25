import { eq } from 'drizzle-orm'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { importJobs } from '@/lib/db/schema'
import {
  createJob,
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
