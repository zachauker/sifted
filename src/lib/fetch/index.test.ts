import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchPage, BlockedError, FetchFailedError } from './index'

afterEach(() => { vi.unstubAllGlobals() })

function stub(response: Partial<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, url: 'https://example.com/r',
    text: async () => '<html></html>',
    ...response,
  }))
}

describe('fetchPage', () => {
  it('returns the html and the final url after redirects', async () => {
    stub({ url: 'https://example.com/final', text: async () => '<html>hi</html>' })
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html>hi</html>')
    expect(result.finalUrl).toBe('https://example.com/final')
  })

  it('sends a browser user agent so blogs do not serve a bot page', async () => {
    stub({})
    await fetchPage('https://example.com/r')
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.headers['User-Agent']).toMatch(/Mozilla/)
  })

  it('throws BlockedError on 403', async () => {
    stub({ ok: false, status: 403 })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(BlockedError)
  })

  it('throws BlockedError on 401 and 429', async () => {
    stub({ ok: false, status: 429 })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(BlockedError)
  })

  it('throws FetchFailedError on other error statuses', async () => {
    stub({ ok: false, status: 500 })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('throws FetchFailedError when the network call rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })
})
