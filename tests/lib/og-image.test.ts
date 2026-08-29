/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { findOgImage } from '@/lib/extract/og-image'

const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`

describe('findOgImage', () => {
  it('reads og:image', () => {
    expect(findOgImage(page('<meta property="og:image" content="https://cdn.example.com/hero.jpg">'), 'https://example.com/r'))
      .toBe('https://cdn.example.com/hero.jpg')
  })

  it('resolves a relative URL against the page', () => {
    expect(findOgImage(page('<meta property="og:image" content="/img/hero.jpg">'), 'https://example.com/recipes/x'))
      .toBe('https://example.com/img/hero.jpg')
  })

  it('prefers og:image over twitter:image', () => {
    const html = page(
      '<meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">' +
      '<meta property="og:image" content="https://cdn.example.com/og.jpg">',
    )
    expect(findOgImage(html, 'https://example.com/r')).toBe('https://cdn.example.com/og.jpg')
  })

  it('falls back to twitter:image, then link rel=image_src', () => {
    expect(findOgImage(page('<meta name="twitter:image" content="https://cdn.example.com/t.jpg">'), 'https://e.com/'))
      .toBe('https://cdn.example.com/t.jpg')
    expect(findOgImage(page('<link rel="image_src" href="https://cdn.example.com/l.jpg">'), 'https://e.com/'))
      .toBe('https://cdn.example.com/l.jpg')
  })

  it('refuses a non-http scheme rather than storing an unfetchable hero', () => {
    expect(findOgImage(page('<meta property="og:image" content="javascript:alert(1)">'), 'https://e.com/')).toBeNull()
    expect(findOgImage(page('<meta property="og:image" content="file:///etc/passwd">'), 'https://e.com/')).toBeNull()
  })

  it('skips an empty value and takes the next candidate', () => {
    const html = page(
      '<meta property="og:image" content="   ">' +
      '<meta name="twitter:image" content="https://cdn.example.com/t.jpg">',
    )
    expect(findOgImage(html, 'https://e.com/')).toBe('https://cdn.example.com/t.jpg')
  })

  it('returns null when the page advertises nothing', () => {
    expect(findOgImage(page('<title>No picture</title>'), 'https://e.com/')).toBeNull()
  })
})
