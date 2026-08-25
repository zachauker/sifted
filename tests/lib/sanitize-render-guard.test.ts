import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Structural guard, modelled on `src/lib/extract/purity.test.ts`.
 *
 * `sanitizeNarrative` is only a defence if every render path actually calls it.
 * A single future component that reaches for `dangerouslySetInnerHTML` without it
 * -- or a second one that copies the pattern and forgets -- reopens the hole, and
 * no unit test of the sanitizer would notice. So the boundary is enforced by
 * scanning the source tree instead of by convention:
 *
 *   1. `dangerouslySetInnerHTML` may appear in at most one file,
 *   2. that file must also reference `sanitizeNarrative`,
 *   3. the sanitizer module itself must stay server-side, and
 *   4. no Client Component may import it.
 *
 * Rules 3 and 4 are a bundle-size rule with a security tail. `sanitize-html` is a
 * ~195 KB Node parser; a Client Component that imports `sanitizeNarrative` drags
 * all of it into the browser payload (measured: one `'use client'` file importing
 * the sanitizer produced a 195 KB client chunk). Worse, sanitizing in the browser
 * runs the decision in the same place the attacker's markup already lives, and
 * anything rendered before hydration was never sanitized at all. The sanitized
 * *string* is what should cross to the browser, not the sanitizer.
 *
 * The `server-only` package would enforce rule 4 at build time, but it throws
 * outside a `react-server` condition and would break `src/lib/sanitize.ts` under
 * Vitest. Scanning costs nothing and breaks nothing.
 *
 * Deliberately not enforced: what the narrative component is *called*. The
 * security property is "exactly one raw-HTML sink, and it sanitizes", not a
 * filename.
 *
 * The scan covers all of `src`, not just `src/app` and `src/components`. Where
 * raw HTML reaches the DOM is not a property of which directory a component
 * happens to sit in, and a sink reached via `next/dynamic` from outside those two
 * trees would otherwise be invisible. Directories that do not exist yet are
 * skipped -- the UI is being built alongside this -- so the guard grows teeth as
 * files land rather than blocking on them.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SRC = join(ROOT, 'src')
const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs|mts)$/
const TEST_FILE = /\.test\.(?:tsx?|jsx?|mjs|mts)$/
const SINK = 'dangerouslySetInnerHTML'
const SANITIZER = 'sanitizeNarrative'
const SANITIZER_MODULE = join(SRC, 'lib/sanitize.ts')

/**
 * Matches the sink as *code*, not as a substring: the prop name followed by `=`
 * (JSX: `dangerouslySetInnerHTML={{ __html }}`) or `:` (object literal, as in
 * `createElement('div', { dangerouslySetInnerHTML: ... })`).
 *
 * A bare substring scan is wrong, and demonstrably so -- it fired on
 * `src/lib/extract/jsonld.ts`, whose doc comment warns callers that ingredient
 * `rawText` must be rendered as a text node and "never via
 * `dangerouslySetInnerHTML` or equivalent", and on `src/lib/sanitize.ts`, which
 * documents this very rule. Both are prose telling you *not* to do the thing.
 * A guard that punishes a correct warning teaches people to delete warnings.
 *
 * Comment-stripping was the other option and was rejected: a stripper that
 * mishandles `//` inside a string literal stops seeing real sinks, and this
 * guard must fail safe. Requiring `=` or `:` narrows in the opposite direction
 * -- prose in any form is ignored, while every syntax anyone actually writes a
 * sink in still matches. Prose that happens to be followed by a colon would
 * trip it, which is the harmless direction.
 *
 * Not caught: a computed or aliased prop name. Nothing grep-shaped catches
 * deliberate obfuscation, and the threat model here is an honest mistake.
 */
const SINK_USE = /\bdangerouslySetInnerHTML\s*[=:]/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(full)
  }
  return out
}

function sourceFiles(): string[] {
  return existsSync(SRC) ? walk(SRC) : []
}

/** First non-comment, non-blank line -- where a directive must sit to count. */
function firstStatement(src: string): string {
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
      continue
    }
    return line
  }
  return ''
}

function hasClientDirective(src: string): boolean {
  return /^['"]use client['"]/.test(firstStatement(src))
}

/** `import x from 'y'`, `import 'y'`, `export … from 'y'`, `require('y')`, `import('y')`. */
function importSpecifiers(src: string): string[] {
  const out: string[] = []
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(src)) !== null) out.push(match[1])
  return out
}

/** True if `spec`, written inside `file`, points at src/lib/sanitize.ts. */
function resolvesToSanitizer(file: string, spec: string): boolean {
  let abs: string
  if (spec.startsWith('@/')) abs = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) abs = resolve(dirname(file), spec)
  else return false // a bare package specifier is never our module
  const strip = (p: string) => p.replace(SOURCE_EXT, '')
  return strip(abs) === strip(SANITIZER_MODULE)
}

describe('raw HTML render boundary', () => {
  const files = sourceFiles()

  it('has a source tree to scan', () => {
    // Guards against every rule below passing vacuously because the walker broke.
    expect(existsSync(SRC)).toBe(true)
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain(SANITIZER_MODULE)
  })

  it('detects the sink by code shape, not by prose mention', () => {
    // A guard whose detector is never itself tested is a guard that can rot into
    // matching nothing at all while staying green.
    expect(SINK_USE.test(`<div ${SINK}={{ __html: clean }} />`)).toBe(true)
    expect(SINK_USE.test(`createElement('div', { ${SINK}: { __html: clean } })`)).toBe(true)
    expect(SINK_USE.test(`never via \`${SINK}\` or equivalent.`)).toBe(false)
    expect(SINK_USE.test(` * exactly that: one \`${SINK}\` in the codebase, and it`)).toBe(false)
  })

  const sinks = files.filter((f) => SINK_USE.test(readFileSync(f, 'utf8')))

  it(`uses ${SINK} in at most one component`, () => {
    const found = sinks.map((f) => relative(ROOT, f))
    expect(
      found.length,
      `${SINK} is the app's only raw-HTML sink and belongs in exactly one narrative ` +
        `component, so there is a single place to audit. Found it in ${found.length} ` +
        `file(s): ${found.join(', ')}`,
    ).toBeLessThanOrEqual(1)
  })

  for (const file of sinks) {
    const rel = relative(ROOT, file)
    it(`${rel} sanitizes what it injects`, () => {
      const src = readFileSync(file, 'utf8')
      expect(
        src,
        `${rel} uses ${SINK} without referencing ${SANITIZER}. Stored narrativeHtml ` +
          `is third-party HTML from arbitrary blogs; render it through ` +
          `sanitizeNarrative() from @/lib/sanitize.`,
      ).toContain(SANITIZER)
    })
  }

  it('src/lib/sanitize.ts stays a server module', () => {
    expect(
      hasClientDirective(readFileSync(SANITIZER_MODULE, 'utf8')),
      `src/lib/sanitize.ts must not carry a 'use client' directive: it would ship ` +
        `sanitize-html's ~195 KB parser to every browser and move the security ` +
        `decision into the same runtime as the markup it is defending against.`,
    ).toBe(false)
  })

  it('is not imported by any Client Component', () => {
    const offenders = files
      .filter((f) => f !== SANITIZER_MODULE) // cannot import itself
      .flatMap((file) => {
        const src = readFileSync(file, 'utf8')
        if (!hasClientDirective(src)) return []
        return importSpecifiers(src)
          .filter((spec) => resolvesToSanitizer(file, spec))
          .map((spec) => `${relative(ROOT, file)} (imports '${spec}')`)
      })

    expect(
      offenders,
      `A Client Component importing ${SANITIZER} pulls sanitize-html into the ` +
        `browser bundle -- measured at 195 KB of client payload for a function ` +
        `whose entire output is a string. Sanitize in the Server Component that ` +
        `renders the narrative and pass the clean string down as a prop; markup ` +
        `rendered before hydration would never have been sanitized anyway. ` +
        `Offending file(s): ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
