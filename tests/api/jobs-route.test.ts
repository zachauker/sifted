import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  runImport: vi.fn(),
  createVercelBlobStore: vi.fn(() => ({ store: true })),
  createAnthropicClient: vi.fn(() => ({ llm: true })),
  fetchPage: vi.fn(),
  ingestHeroImage: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/jobs', () => ({
  listJobs: mocks.listJobs,
  getJob: mocks.getJob,
}))
vi.mock('@/lib/import/run-import', () => ({ runImport: mocks.runImport }))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: mocks.createVercelBlobStore }))
vi.mock('@/lib/llm/anthropic-client', () => ({ createAnthropicClient: mocks.createAnthropicClient }))
vi.mock('@/lib/fetch', () => ({ fetchPage: mocks.fetchPage }))
vi.mock('@/lib/images', () => ({ ingestHeroImage: mocks.ingestHeroImage }))

// Route modules are imported after the mocks above are registered so they
// resolve against the mocked modules rather than the real db/auth/etc.
const { GET } = await import('@/app/api/jobs/route')
const { POST: retry } = await import('@/app/api/jobs/[id]/retry/route')

function makeRetryRequest(body?: unknown, opts: { raw?: string; empty?: boolean } = {}) {
  if (opts.empty) {
    return new Request('https://app.example.com/api/jobs/job-1/retry', { method: 'POST' })
  }
  return new Request('https://app.example.com/api/jobs/job-1/retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(body ?? {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.listJobs.mockResolvedValue([{ id: 'job-1', status: 'queued' }])
  mocks.getJob.mockResolvedValue({ id: 'job-1', status: 'failed', url: 'https://example.com/korma' })
  mocks.runImport.mockResolvedValue(undefined)
  mocks.createVercelBlobStore.mockReturnValue({ store: true })
  mocks.createAnthropicClient.mockReturnValue({ llm: true })
})

describe('GET /api/jobs', () => {
  it('returns jobs for an authenticated session', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobs: [{ id: 'job-1', status: 'queued' }] })
  })

  it('returns 401 when the caller is anonymous', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(mocks.listJobs).not.toHaveBeenCalled()
  })
})

describe('POST /api/jobs/[id]/retry', () => {
  it('re-queues the job and responds 202', async () => {
    const res = await retry(makeRetryRequest(), { params: Promise.resolve({ id: 'job-1' }) })
    expect(res.status).toBe(202)
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', url: 'https://example.com/korma' }),
    )
  })

  it('accepts pasted html in the request body', async () => {
    const res = await retry(
      makeRetryRequest({ html: '<html>pasted</html>' }),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(202)
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ suppliedHtml: '<html>pasted</html>' }),
    )
  })

  it('works with no request body at all', async () => {
    const res = await retry(
      makeRetryRequest(undefined, { empty: true }),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(202)
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ suppliedHtml: null }),
    )
  })

  it('returns 404 for an unknown job', async () => {
    mocks.getJob.mockResolvedValue(undefined)
    const res = await retry(makeRetryRequest(), { params: Promise.resolve({ id: 'missing' }) })
    expect(res.status).toBe(404)
    expect(mocks.runImport).not.toHaveBeenCalled()
  })

  it('returns 409 when the job is already running, and does not fan out a second run', async () => {
    mocks.getJob.mockResolvedValue({ id: 'job-1', status: 'running', url: 'https://example.com/korma' })
    const res = await retry(makeRetryRequest(), { params: Promise.resolve({ id: 'job-1' }) })
    expect(res.status).toBe(409)
    expect(mocks.runImport).not.toHaveBeenCalled()
  })

  it('returns 401 when the caller is anonymous, before looking up the job', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await retry(makeRetryRequest(), { params: Promise.resolve({ id: 'job-1' }) })
    expect(res.status).toBe(401)
    expect(mocks.getJob).not.toHaveBeenCalled()
  })

  it('returns 413 when pasted html exceeds 5MB', async () => {
    const bigHtml = 'a'.repeat(5 * 1024 * 1024 + 1)
    const res = await retry(
      makeRetryRequest({ html: bigHtml }),
      { params: Promise.resolve({ id: 'job-1' }) },
    )
    expect(res.status).toBe(413)
    expect(mocks.runImport).not.toHaveBeenCalled()
  })
})

describe('POST /api/jobs/[id]/retry — deliberate update', () => {
  it('tells runImport that a human asked, so an existing recipe is re-extracted', async () => {
    // Without allowExistingUpdate, runImport marks a URL that already has a
    // recipe as `duplicate` and returns before extracting — the retry button
    // would silently do nothing. This asserts the intent is actually passed,
    // because this suite mocks runImport and cannot otherwise catch it.
    mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.getJob.mockResolvedValue({
      id: 'job-1', url: 'https://example.com/korma', status: 'failed', requestedBy: 'user-1',
    })

    const response = await retry(makeRetryRequest({ empty: true }), {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(response.status).toBe(202)
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ allowExistingUpdate: true }),
    )
  })
})
