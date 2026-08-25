// @vitest-environment jsdom
//
// Regression coverage for the header badge in `src/app/(app)/layout.tsx`.
// No test rendered this layout at all before this file: the badge's count
// was computed with `listJobs(db)` — the newest 50 rows of *every* status —
// filtered client-side for `status === 'failed'`. `listJobs` caps at 50 and
// carries no status filter, so a failed job sitting behind 50+ newer
// successes (exactly the shape of the 156-recipe migration burst — see
// `tests/db/jobs.test.ts`) falls out of that window entirely, and the badge
// reads 0 while `/needs-attention` still lists the failure. This asserts the
// badge instead reflects `countJobsNeedingAttention`, which shares its
// status filter with `listJobsNeedingAttention` (what the tray actually
// renders) and has no row cap to fall out of.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
  listJobs: vi.fn(),
  countJobsNeedingAttention: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth, signOut: mocks.signOut }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/jobs', () => ({
  listJobs: mocks.listJobs,
  countJobsNeedingAttention: mocks.countJobsNeedingAttention,
}))

const { default: AppLayout } = await import('@/app/(app)/layout')

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1', name: 'Zach' } })
})

describe('AppLayout needs-attention badge', () => {
  it('shows a nonzero badge for a failed job even when 50+ newer jobs have since succeeded', async () => {
    // Simulates the burst from `tests/db/jobs.test.ts`: `listJobs`'s
    // newest-50-of-every-status window is entirely successes — the failed
    // job has already fallen out of it — but the tray (and so the badge)
    // still has exactly one thing needing attention.
    mocks.listJobs.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ id: `done-${i}`, status: 'done' })),
    )
    mocks.countJobsNeedingAttention.mockResolvedValue(1)

    render(await AppLayout({ children: <div /> }))

    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('shows no badge when nothing needs attention', async () => {
    mocks.listJobs.mockResolvedValue([])
    mocks.countJobsNeedingAttention.mockResolvedValue(0)

    render(await AppLayout({ children: <div /> }))

    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('shows the badge for an in-flight job too, matching what the tray lists', async () => {
    mocks.listJobs.mockResolvedValue([])
    mocks.countJobsNeedingAttention.mockResolvedValue(2)

    render(await AppLayout({ children: <div /> }))

    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
