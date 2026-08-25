import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchPage, BlockedError, FetchFailedError } from './index'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/**
 * Stubs `fetch` with a REAL `Response` built from REAL bytes.
 *
 * The previous version of this file stubbed an object literal whose `text`
 * was `async () => '<html></html>'` — a plain closure. Nothing about decoding
 * was ever executed, which is precisely why a charset bug survived the suite:
 * the mock handed back an already-decoded string, so the one step that was
 * broken was the one step never run. Everything here goes through a genuine
 * `Response`, so `arrayBuffer()` and `TextDecoder` do real work.
 */
function stubFetch(response: Response, finalUrl = 'https://example.com/r'): Response {
  Object.defineProperty(response, 'url', { value: finalUrl, configurable: true })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  return response
}

function htmlResponse(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers })
}

// The 0x80-0x9F block is the whole reason windows-1252 and ISO-8859-1 are not
// the same encoding: ISO-8859-1 puts C1 control codes there, windows-1252 puts
// printable punctuation. Only the characters these tests actually use.
const CP1252_HIGH: Record<string, number> = {
  '€': 0x80, // euro
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85, // ellipsis
  '‘': 0x91,
  '’': 0x92, // curly apostrophe
  '“': 0x93,
  '”': 0x94,
  '•': 0x95, // bullet
  '–': 0x96, // en dash
  '—': 0x97, // em dash
  '™': 0x99,
}

/**
 * Encodes text as windows-1252. Throws on anything unencodable so a test
 * cannot quietly assert against bytes that are not what the name claims.
 */
function windows1252(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const code = char.charCodeAt(0)
    if (code <= 0xff) {
      bytes[i] = code
      continue
    }
    const mapped = CP1252_HIGH[char]
    if (mapped === undefined) {
      throw new Error(`U+${code.toString(16).toUpperCase()} is not encodable as windows-1252`)
    }
    bytes[i] = mapped
  }
  return bytes
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function concatBytes(...chunks: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// The accented vocabulary a recipe library is actually full of. If the decode
// is wrong, every one of these turns into U+FFFD.
const ACCENTED = 'Sautéed Crème Brûlée Café — 1 cup crème fraîche, jalapeño, pâté'

function recipeHtml(metaTag = ''): string {
  return `<!DOCTYPE html><html><head>${metaTag}<title>${ACCENTED}</title></head><body><p>${ACCENTED}</p></body></html>`
}

describe('fetchPage', () => {
  it('returns the html and the final url after redirects', async () => {
    stubFetch(htmlResponse(utf8('<html>hi</html>')), 'https://example.com/final')
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html>hi</html>')
    expect(result.finalUrl).toBe('https://example.com/final')
  })

  it('sends a browser user agent so blogs do not serve a bot page', async () => {
    stubFetch(htmlResponse(utf8('<html></html>')))
    await fetchPage('https://example.com/r')
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.headers['User-Agent']).toMatch(/Mozilla/)
  })

  it('throws BlockedError on 403', async () => {
    stubFetch(new Response(utf8('nope'), { status: 403 }))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(BlockedError)
  })

  it('throws BlockedError on 401 and 429', async () => {
    stubFetch(new Response(utf8('nope'), { status: 429 }))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(BlockedError)
  })

  it('throws FetchFailedError on other error statuses', async () => {
    stubFetch(new Response(utf8('boom'), { status: 500 }))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('throws FetchFailedError when the network call rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('still surfaces BlockedError on 403 and not FetchFailedError, proving the catch does not downgrade our own error types', async () => {
    stubFetch(new Response(utf8('nope'), { status: 403 }))
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
    // Hand-rolled rather than a real Response: a constructed Response is not
    // wired to our AbortController the way a live undici body is, so the only
    // way to exercise "the timeout covers the body read" is to model a body
    // that rejects on abort.
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          url: 'https://example.com/r',
          headers: { get: () => null } as unknown as Headers,
          arrayBuffer: () =>
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
    stubFetch(
      htmlResponse(utf8('%PDF-1.4 binary garbage'), { 'content-type': 'application/pdf' }),
      'https://example.com/file.pdf'
    )
    await expect(fetchPage('https://example.com/file.pdf')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('passes through when the content-type header is missing', async () => {
    stubFetch(htmlResponse(utf8('<html></html>')))
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html></html>')
  })

  it('passes through text/html with a charset parameter', async () => {
    stubFetch(htmlResponse(utf8('<html></html>'), { 'content-type': 'text/html; charset=utf-8' }))
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html></html>')
  })

  it('rejects when Content-Length exceeds the 3MB cap, without reading the body', async () => {
    const response = htmlResponse(utf8('<html></html>'), {
      'content-length': String(4 * 1024 * 1024),
    })
    const bodySpy = vi.spyOn(response, 'arrayBuffer')
    stubFetch(response)
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
    expect(bodySpy).not.toHaveBeenCalled()
  })

  it('rejects an oversized body when Content-Length is absent, after reading it', async () => {
    stubFetch(htmlResponse(new Uint8Array(4 * 1024 * 1024).fill(0x61)))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('rejects a body just over the 3MB cap', async () => {
    stubFetch(htmlResponse(new Uint8Array(3 * 1024 * 1024 + 1).fill(0x61)))
    await expect(fetchPage('https://example.com/r')).rejects.toBeInstanceOf(FetchFailedError)
  })

  it('accepts a body just under the 3MB cap', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 - 1).fill(0x61)
    stubFetch(htmlResponse(bytes))
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('a'.repeat(3 * 1024 * 1024 - 1))
  })

  it('caps on byte length, not decoded string length, so a multi-byte body under 3MB of bytes is still accepted', async () => {
    // 1.5M copies of a 2-byte character: 3 MB - 2 bytes on the wire, but only
    // ~1.5M UTF-16 code units once decoded. The old string-length cap and the
    // byte cap disagree here; the byte cap is the one that bounds memory.
    const text = 'é'.repeat(1024 * 1024 + 512 * 1024 - 1)
    const bytes = utf8(text)
    expect(bytes.byteLength).toBeLessThan(3 * 1024 * 1024)
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=utf-8' }))
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe(text)
  })
})

describe('fetchPage character encoding', () => {
  it('decodes a windows-1252 body declared in the Content-Type header', async () => {
    const bytes = windows1252(recipeHtml())
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=windows-1252' }))

    const result = await fetchPage('https://example.com/r')

    // Exact equality: the round trip is lossless, em dash and all.
    expect(result.html).toBe(recipeHtml())
    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.html).toContain('1 cup crème fraîche')
    expect(result.html).not.toContain('�')
    expect(result.encoding).toBe('windows-1252')
  })

  it('decodes ISO-8859-1 declared in the header (the label TextDecoder folds into windows-1252)', async () => {
    const bytes = windows1252(recipeHtml())
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=ISO-8859-1' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.html).not.toContain('�')
  })

  it('accepts a quoted charset parameter', async () => {
    const bytes = windows1252(recipeHtml())
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset="windows-1252"' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Crème Brûlée')
    expect(result.encoding).toBe('windows-1252')
  })

  it('decodes a windows-1252 body declared only in <meta charset>, with no charset in the header', async () => {
    const bytes = windows1252(recipeHtml('<meta charset="windows-1252">'))
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.html).toContain('1 cup crème fraîche')
    expect(result.html).not.toContain('�')
    expect(result.encoding).toBe('windows-1252')
  })

  it('decodes a windows-1252 body declared only in <meta http-equiv="Content-Type">', async () => {
    const meta = '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'
    const bytes = windows1252(recipeHtml(meta))
    stubFetch(htmlResponse(bytes))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.html).not.toContain('�')
    expect(result.encoding).toBe('windows-1252')
  })

  it('prefers the header charset over a conflicting <meta charset>', async () => {
    // Header says the truth, meta lies. The header wins, so the page decodes.
    const bytes = windows1252(recipeHtml('<meta charset="utf-8">'))
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=windows-1252' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.html).not.toContain('�')
    expect(result.encoding).toBe('windows-1252')
  })

  it('falls back to windows-1252 for an undeclared body that cannot be UTF-8', async () => {
    // Documented no-declaration behavior: strict UTF-8 first; a body that
    // fails strict UTF-8 was never UTF-8, so it is read as windows-1252
    // rather than deliberately mangled into replacement characters.
    const bytes = windows1252(recipeHtml())
    stubFetch(htmlResponse(bytes))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.html).toContain('1 cup crème fraîche')
    expect(result.html).not.toContain('�')
    expect(result.encoding).toBe('windows-1252')
  })

  it('decodes an undeclared UTF-8 body as UTF-8 — the common case must not regress', async () => {
    const text = recipeHtml()
    stubFetch(htmlResponse(utf8(text)))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toBe(text)
    expect(result.html).not.toContain('�')
    expect(result.encoding).toBe('utf-8')
  })

  it('decodes an undeclared pure-ASCII body as UTF-8', async () => {
    stubFetch(htmlResponse(utf8('<html><body>plain ascii</body></html>')))
    const result = await fetchPage('https://example.com/r')
    expect(result.html).toBe('<html><body>plain ascii</body></html>')
    expect(result.encoding).toBe('utf-8')
  })

  it('strips a UTF-8 BOM and decodes correctly', async () => {
    const text = recipeHtml()
    const bytes = concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(text))
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=utf-8' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toBe(text)
    expect(result.html.charCodeAt(0)).not.toBe(0xfeff)
    expect(result.encoding).toBe('utf-8')
  })

  it('lets a BOM override a conflicting declared charset', async () => {
    // Bytes are UTF-8 with a BOM; the header lies and says windows-1252.
    // Without BOM precedence this decodes to double-encoded mojibake.
    const text = recipeHtml()
    const bytes = concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(text))
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=windows-1252' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toBe(text)
    expect(result.encoding).toBe('utf-8')
  })

  it('decodes a UTF-16LE body from its BOM', async () => {
    const text = recipeHtml()
    const units = new Uint8Array(2 + text.length * 2)
    units[0] = 0xff
    units[1] = 0xfe
    const view = new DataView(units.buffer)
    for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true)
    stubFetch(htmlResponse(units, { 'content-type': 'text/html' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toBe(text)
    expect(result.encoding).toBe('utf-16le')
  })

  it('falls back instead of throwing when the declared charset label is unknown', async () => {
    const text = recipeHtml()
    stubFetch(htmlResponse(utf8(text), { 'content-type': 'text/html; charset=x-totally-not-real' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toBe(text)
    expect(result.encoding).toBe('utf-8')
  })

  it('falls back to the next candidate when the header charset is garbage but the meta tag is good', async () => {
    const bytes = windows1252(recipeHtml('<meta charset="windows-1252">'))
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=????' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.encoding).toBe('windows-1252')
  })

  it('ignores a <meta charset> that appears past the sniff window', async () => {
    // Sanity check that the prescan is bounded: a declaration buried under
    // 4 KB of filler is not consulted, and the undeclared fallback handles it.
    const filler = `<!--${'x'.repeat(4096)}-->`
    const bytes = windows1252(
      `<!DOCTYPE html><html><head>${filler}<meta charset="windows-1252"><title>${ACCENTED}</title></head></html>`
    )
    stubFetch(htmlResponse(bytes))

    const result = await fetchPage('https://example.com/r')

    // Still correct, but by way of the undeclared fallback rather than the meta.
    expect(result.html).toContain('Sautéed Crème Brûlée Café')
    expect(result.encoding).toBe('windows-1252')
  })

  it('carries the raw response bytes through byte-identically', async () => {
    const sent = windows1252(recipeHtml())
    stubFetch(htmlResponse(sent, { 'content-type': 'text/html; charset=windows-1252' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.bytes).toBeInstanceOf(Uint8Array)
    expect(result.bytes.byteLength).toBe(sent.byteLength)
    expect(Array.from(result.bytes)).toEqual(Array.from(sent))
  })

  it('decodes the windows-1252 0x80-0x9F punctuation block per the standard, not as C1 controls', async () => {
    // Node's own TextDecoder gets this range wrong (it hands back U+0092 for a
    // curly apostrophe), and it is the range blog prose lives in. Every byte
    // here is a character a recipe page really contains.
    const bytes = new Uint8Array([
      0x93, 0x47, 0x72, 0x61, 0x6e, 0x92, 0x73, 0x94, 0x20, 0x97, 0x20, 0x96, 0x20, 0x85, 0x20,
      0x80, 0x20, 0x95, 0x20, 0x99, 0x20, 0x8c, 0x20, 0x9c, 0x20, 0xe9,
    ])
    stubFetch(htmlResponse(bytes, { 'content-type': 'text/html; charset=windows-1252' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toBe('“Gran’s” — – … € • ™ Œ œ é')
    // The failure mode this guards is invisible: C1 controls, not U+FFFD.
    expect(/[\u0080-\u009f]/.test(result.html)).toBe(false)
  })

  it('decodes every windows-1252 byte to a character, never to U+FFFD', async () => {
    const allBytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) allBytes[i] = i
    stubFetch(htmlResponse(allBytes, { 'content-type': 'text/html; charset=windows-1252' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toHaveLength(256)
    expect(result.html).not.toContain('�')
  })

  it('archives bytes that are lossless even when html would not be', async () => {
    // The archive must be able to outlive a bad decode. Here the server lies
    // (declares utf-8, sends windows-1252) so `html` genuinely is mojibake —
    // but `bytes` still holds the original, so a fixed parser can re-run.
    const sent = windows1252(recipeHtml())
    stubFetch(htmlResponse(sent, { 'content-type': 'text/html; charset=utf-8' }))

    const result = await fetchPage('https://example.com/r')

    expect(result.html).toContain('�')
    expect(Array.from(result.bytes)).toEqual(Array.from(sent))
    expect(new TextDecoder('windows-1252').decode(result.bytes)).toContain('Sautéed Crème Brûlée Café')
  })
})
