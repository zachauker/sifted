import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Route modules are imported *after* the mocks below are registered, per
 * project convention: a top-level `await import` runs after `vi.mock` calls
 * are hoisted, so the route sees the mocked modules rather than the real
 * ones (which would try to hit a database, Vercel Blob, and Anthropic).
 */
const mocks = vi.hoisted(() => ({
  authenticateBearer: vi.fn(),
  findBySourceUrl: vi.fn(),
  createJob: vi.fn(),
  markDuplicate: vi.fn(),
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
  markDuplicate: mocks.markDuplicate,
}))
vi.mock('@/lib/import/run-import', () => ({ runImport: mocks.runImport }))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: mocks.createVercelBlobStore }))
vi.mock('@/lib/llm/anthropic-client', () => ({ createAnthropicClient: mocks.createAnthropicClient }))
vi.mock('@/lib/fetch', () => ({ fetchPage: mocks.fetchPage }))
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
  mocks.runImport.mockResolvedValue(undefined)
  mocks.createVercelBlobStore.mockReturnValue({ store: true })
  mocks.createAnthropicClient.mockReturnValue({ llm: true })
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

  it('returns 413 when html exceeds 5MB', async () => {
    const bigHtml = 'a'.repeat(5 * 1024 * 1024 + 1)
    const res = await POST(makeRequest({ url: 'https://example.com/korma', html: bigHtml }))
    expect(res.status).toBe(413)
    expect(mocks.createJob).not.toHaveBeenCalled()
    expect(mocks.runImport).not.toHaveBeenCalled()
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
})
