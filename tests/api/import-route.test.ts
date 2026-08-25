import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_BYTES } from '@/lib/fetch'

/**
 * Route modules are imported *after* the mocks below are registered, per
 * project convention: a top-level `await import` runs after `vi.mock` calls
 * are hoisted, so the route sees the mocked modules rather than the real
 * ones (which would try to hit a database, Vercel Blob, and Anthropic).
 */
const mocks = vi.hoisted(() => ({
  findInFlightJob: vi.fn(),
  authenticateBearer: vi.fn(),
  findBySourceUrl: vi.fn(),
  createJob: vi.fn(),
  markDuplicate: vi.fn(),
  markFailed: vi.fn(),
  runImport: vi.fn(),
  createVercelBlobStore: vi.fn(() => ({ store: true })),
  createAnthropicClient: vi.fn(() => ({ llm: true })),
  fetchPage: vi.fn(),
  ingestHeroImage: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({ authenticateBearer: mocks.authenticateBearer }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/recipes', () => ({ findBySourceUrl: mocks.findBySourceUrl }))
vi.mock('@/lib/db/queries/jobs', () => ({
  createJob: mocks.createJob,
  findInFlightJob: mocks.findInFlightJob,
  markDuplicate: mocks.markDuplicate,
  markFailed: mocks.markFailed,
}))
vi.mock('@/lib/import/run-import', () => ({ runImport: mocks.runImport }))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: mocks.createVercelBlobStore }))
vi.mock('@/lib/llm/anthropic-client', () => ({ createAnthropicClient: mocks.createAnthropicClient }))
// Preserve the real `MAX_BYTES` export (the route imports it to derive its
// own HTML cap) while still mocking `fetchPage` so the suite never touches
// the network.
vi.mock('@/lib/fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fetch')>()
  return { ...actual, fetchPage: mocks.fetchPage }
})
vi.mock('@/lib/images', () => ({ ingestHeroImage: mocks.ingestHeroImage }))

const { POST } = await import('@/app/api/import/route')

function makeRequest(body?: unknown, opts: { auth?: boolean; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.auth !== false) headers.authorization = 'Bearer test-token'
  return new Request('https://app.example.com/api/import', {
    method: 'POST',
    headers,
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(body ?? {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticateBearer.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
  mocks.createJob.mockResolvedValue('job-1')
  mocks.findBySourceUrl.mockResolvedValue(undefined)
  mocks.findInFlightJob.mockResolvedValue(undefined)
  mocks.runImport.mockResolvedValue(undefined)
  mocks.createVercelBlobStore.mockReturnValue({ store: true })
  mocks.createAnthropicClient.mockReturnValue({ llm: true })
  mocks.markFailed.mockResolvedValue(undefined)
})

describe('POST /api/import', () => {
  it('returns 401 when there is no valid bearer token', async () => {
    mocks.authenticateBearer.mockResolvedValue(null)
    const res = await POST(makeRequest({ url: 'https://example.com/korma' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(mocks.createJob).not.toHaveBeenCalled()
  })

  it('returns 202 with a queued status and jobId', async () => {
    const res = await POST(makeRequest({ url: 'https://example.com/korma' }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'queued', jobId: 'job-1' })
  })

  it('returns 400 when url is missing', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
    expect(mocks.createJob).not.toHaveBeenCalled()
  })

  it('returns 400 when url does not parse', async () => {
    const res = await POST(makeRequest({ url: 'this is not a url' }))
    expect(res.status).toBe(400)
    expect(mocks.createJob).not.toHaveBeenCalled()
  })

  it('returns 400 on malformed JSON without throwing', async () => {
    const res = await POST(makeRequest(undefined, { raw: '{not valid json' }))
    expect(res.status).toBe(400)
    expect(mocks.createJob).not.toHaveBeenCalled()
  })

  it('canonicalizes the url before creating the job and invoking runImport', async () => {
    await POST(makeRequest({ url: 'https://www.example.com/korma/?utm_source=x#jump' }))
    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.com/korma',
      'user-1',
    )
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/korma', jobId: 'job-1' }),
    )
  })

  it('checks for an existing recipe by the canonical url, not the raw one', async () => {
    await POST(makeRequest({ url: 'https://www.example.com/korma/?utm_source=x#jump' }))
    expect(mocks.findBySourceUrl).toHaveBeenCalledWith(expect.anything(), 'https://example.com/korma')
  })

  it('responds 200 duplicate and never calls runImport when the recipe already exists', async () => {
    mocks.findBySourceUrl.mockResolvedValue({ id: 'recipe-1' })
    const res = await POST(makeRequest({ url: 'https://example.com/korma' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'duplicate', jobId: 'job-1', recipeId: 'recipe-1' })
    expect(mocks.markDuplicate).toHaveBeenCalledWith(expect.anything(), 'job-1', 'recipe-1')
    expect(mocks.runImport).not.toHaveBeenCalled()
  })

  it('passes supplied html through to runImport', async () => {
    await POST(makeRequest({ url: 'https://example.com/korma', html: '<html>hi</html>' }))
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ suppliedHtml: '<html>hi</html>' }),
    )
  })

  it('treats an empty html string as no supplied html, not as supplied html', async () => {
    await POST(makeRequest({ url: 'https://example.com/korma', html: '' }))
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ suppliedHtml: null }),
    )
  })

  it('treats a null html as no supplied html', async () => {
    await POST(makeRequest({ url: 'https://example.com/korma', html: null }))
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({ suppliedHtml: null }),
    )
  })

  it('returns 413 when supplied html exceeds the cap', async () => {
    const bigHtml = 'a'.repeat(MAX_BYTES + 1)
    const res = await POST(makeRequest({ url: 'https://example.com/korma', html: bigHtml }))
    expect(res.status).toBe(413)
    expect(mocks.createJob).not.toHaveBeenCalled()
    expect(mocks.runImport).not.toHaveBeenCalled()
  })

  // Regression test for the two caps drifting apart: supplied/pasted HTML
  // skips `fetchPage` and goes straight into the same JSDOM parses a fetched
  // page does, so the route's cap must be exactly the fetch layer's cap, not
  // an independently maintained number that can quietly diverge from it. If
  // the route ever redeclares its own constant instead of importing
  // `MAX_BYTES`, one of these two assertions will fail the moment the two
  // numbers disagree.
  it("caps supplied html at exactly the fetch layer's MAX_BYTES, not an independent number", async () => {
    const atCap = 'a'.repeat(MAX_BYTES)
    const overCap = 'a'.repeat(MAX_BYTES + 1)

    const atCapRes = await POST(makeRequest({ url: 'https://example.com/korma', html: atCap }))
    expect(atCapRes.status).not.toBe(413)

    const overCapRes = await POST(makeRequest({ url: 'https://example.com/korma-2', html: overCap }))
    expect(overCapRes.status).toBe(413)
  })

  it('wires db, store, llm, fetchPage and ingestHeroImage into runImport', async () => {
    await POST(makeRequest({ url: 'https://example.com/korma' }))
    expect(mocks.createVercelBlobStore).toHaveBeenCalled()
    expect(mocks.createAnthropicClient).toHaveBeenCalled()
    expect(mocks.runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        db: { marker: 'db' },
        store: { store: true },
        llm: { llm: true },
        fetchPage: mocks.fetchPage,
        ingestHeroImage: mocks.ingestHeroImage,
        addedBy: 'user-1',
      }),
    )
  })

  it('sends the 202 response before the background runImport finishes', async () => {
    let resolveRunImport: () => void = () => {}
    mocks.runImport.mockImplementation(
      () => new Promise<void>((resolve) => { resolveRunImport = resolve }),
    )

    const res = await POST(makeRequest({ url: 'https://example.com/korma' }))

    // If the route awaited runImport before responding, this line would never
    // be reached: runImport's promise is deliberately left hanging above.
    expect(res.status).toBe(202)
    expect(mocks.runImport).toHaveBeenCalled()

    resolveRunImport()
  })

  it('marks the job failed, rather than leaving it queued, when the blob store cannot be constructed', async () => {
    const constructionError = new Error('BLOB_READ_WRITE_TOKEN is not set')
    mocks.createVercelBlobStore.mockImplementation(() => {
      throw constructionError
    })

    const res = await POST(makeRequest({ url: 'https://example.com/korma' }))

    // The job row was already created before the dependency construction ran,
    // so it must be resolved one way or another — never left sitting on
    // `queued` with nothing to explain why the import never started.
    expect(mocks.runImport).not.toHaveBeenCalled()
    expect(mocks.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      'internal',
      constructionError,
    )
    // Still 202: the job row already reflects the failure by the time this
    // responds, which is exactly what a 202 means for this endpoint — see the
    // comment in the route for the full reasoning.
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'queued', jobId: 'job-1' })
  })

  it('marks the job failed, rather than leaving it queued, when the Anthropic client cannot be constructed', async () => {
    const constructionError = new Error('ANTHROPIC_API_KEY is not set')
    mocks.createAnthropicClient.mockImplementation(() => {
      throw constructionError
    })

    const res = await POST(makeRequest({ url: 'https://example.com/korma' }))

    expect(mocks.runImport).not.toHaveBeenCalled()
    expect(mocks.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      'internal',
      constructionError,
    )
    expect(res.status).toBe(202)
  })
})

describe('POST /api/import — an import already under way', () => {
  it('does not start a second import for a url already queued or running', async () => {
    // Sharing the same link twice in quick succession — a double tap on the
    // share sheet, or both phones at once — would otherwise fetch the page
    // twice and pay for the model twice. The existing-recipe check cannot see
    // this, because the first import has not written a recipe yet.
    mocks.findInFlightJob.mockResolvedValue({ id: 'job-already-running' })

    const response = await POST(makeRequest({ url: 'https://example.com/korma' }))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      status: 'already_importing',
      jobId: 'job-already-running',
    })
    expect(mocks.createJob).not.toHaveBeenCalled()
    expect(mocks.runImport).not.toHaveBeenCalled()
  })
})
