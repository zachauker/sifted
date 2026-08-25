import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { createJob, listJobs, markFailed } from '@/lib/db/queries/jobs'

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
