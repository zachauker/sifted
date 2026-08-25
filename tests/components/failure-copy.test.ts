import { describe, it, expect } from 'vitest'
import { explainFailure, FAILURE_COPY } from '@/components/jobs/failure-copy'
import type { FailureKind } from '@/lib/db/queries/jobs'

const job = (overrides: Partial<Parameters<typeof explainFailure>[0]> = {}) => ({
  url: 'https://example.com/recipe',
  error: null,
  failureKind: null as FailureKind | null,
  ...overrides,
})

/**
 * Reproduced at runtime before this fix: `explainFailure` did
 * `FAILURE_COPY[job.failureKind](job)` with no existence check.
 * `import_jobs.failure_kind` is plain `text` with no `CHECK` constraint —
 * Drizzle's `FailureKind` union is TypeScript-only — so a value outside the
 * five keys (e.g. `'timeout'`, from a hand-edited row or a future kind added
 * to the enum without a matching migration) is storable. Calling that up as
 * `FAILURE_COPY['timeout']` returned `undefined`, and `undefined(job)` threw
 * `TypeError: FAILURE_COPY.timeout is not a function` — a whole-page 500 on
 * the needs-attention tray, the app's own recovery surface.
 */
describe('explainFailure: unrecognized failureKind', () => {
  it('renders a fallback explanation instead of throwing', () => {
    expect(() =>
      explainFailure(job({ failureKind: 'timeout' as unknown as FailureKind })),
    ).not.toThrow()
  })

  it('shows the stored error text and offers a retry, the same as the null-kind fallback', () => {
    const explanation = explainFailure(
      job({ failureKind: 'timeout' as unknown as FailureKind, error: 'ETIMEDOUT after 30s' }),
    )
    expect(explanation.heading).toBe('Import failed')
    expect(explanation.body).toContain('ETIMEDOUT after 30s')
    expect(explanation.action).toBe('retry')
    expect(explanation.retryLabel).toBe('Retry')
  })

  it('matches the wording used when failureKind is null (same fallback, either way)', () => {
    const unrecognized = explainFailure(job({ failureKind: 'timeout' as unknown as FailureKind }))
    const missing = explainFailure(job({ failureKind: null }))
    expect(unrecognized).toEqual(missing)
  })
})

describe('explainFailure: the five known kinds are unchanged', () => {
  const kinds = Object.keys(FAILURE_COPY) as FailureKind[]

  it('covers exactly the five documented kinds', () => {
    expect(kinds.sort()).toEqual(
      ['blocked', 'fetch_failed', 'internal', 'llm_failed', 'no_recipe'].sort(),
    )
  })

  it.each(kinds)('%s still resolves through its own copy, not the fallback', (kind) => {
    const explanation = explainFailure(job({ failureKind: kind }))
    expect(explanation).toEqual(FAILURE_COPY[kind](job({ failureKind: kind })))
    expect(explanation.heading).not.toBe('Import failed')
  })
})
