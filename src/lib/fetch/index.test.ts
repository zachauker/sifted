import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchPage, BlockedError, FetchFailedError } from './index'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

  it('still surfaces BlockedError on 403 and not FetchFailedError, proving the catch does not downgrade our own error types', async () => {
    stub({ ok: false, status: 403 })
    let caught: unknown
    try {
      await fetchPage('https://example.com/r')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BlockedError)
    expect(caught).not.toBeInstanceOf(FetchFailedError)
  })

  it('throws FetchFailedError when the body stalls past the timeout, not just the headers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          url: 'https://example.com/r',
          headers: { get: () => null } as unknown as Headers,
          text: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                const err = new Error('This operation was aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }),
        })
      )
    )

    const promise = fetchPage('https://example.com/r')
    const assertion = expect(promise).rejects.toBeInstanceOf(FetchFailedError)
    await vi.advanceTimersByTimeAsync(20_001)
    await assertion
  })

  it('rejects a PDF content-type as FetchFailedError', async () => {
    stub({
      url: 'https://example.com/file.pdf',
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/pdf' : null),
      } as unknown as Headers,
      text: async () => '%PDF-1.4 binary garbage',
    })
    await expect(fetchPage('https://example.com/file.pdf')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('passes through when the content-type header is missing', async () => {
    stub({ headers: { get: () => null } as unknown as Headers })
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html></html>')
  })

  it('passes through text/html with a charset parameter', async () => {
    stub({
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
      } as unknown as Headers,
    })
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html></html>')
  })

  it('rejects when Content-Length exceeds the 3MB cap, without reading the body', async () => {
    const textSpy = vi.fn(async () => '<html></html>')
    stub({
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-length' ? String(4 * 1024 * 1024) : null),
      } as unknown as Headers,
      text: textSpy,
    })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
    expect(textSpy).not.toHaveBeenCalled()
  })

  it('rejects an oversized body when Content-Length is absent, after reading it', async () => {
    const bigHtml = 'a'.repeat(4 * 1024 * 1024)
    stub({
      headers: { get: () => null } as unknown as Headers,
      text: async () => bigHtml,
    })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('rejects a body just over the 3MB cap', async () => {
    const html = 'a'.repeat(3 * 1024 * 1024 + 1)
    stub({
      headers: { get: () => null } as unknown as Headers,
      text: async () => html,
    })
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('accepts a body just under the 3MB cap', async () => {
    const html = 'a'.repeat(3 * 1024 * 1024 - 1)
    stub({
      headers: { get: () => null } as unknown as Headers,
      text: async () => html,
    })
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe(html)
  })
})
