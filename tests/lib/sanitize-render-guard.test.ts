import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Structural guard, modelled on `src/lib/extract/purity.test.ts`.
 *
 * `sanitizeNarrative` is only a defence if every render path actually calls it.
 * A single future component that reaches for `dangerouslySetInnerHTML` without it
 * -- or a second one that copies the pattern and forgets -- reopens the hole, and
 * no unit test of the sanitizer would notice. So the render boundary is enforced
 * by scanning the source tree instead of by convention:
 *
 *   1. `dangerouslySetInnerHTML` may appear in at most one file, and
 *   2. that file must also reference `sanitizeNarrative`.
 *
 * Deliberately not enforced: what the component is *called*. The security
 * property is "exactly one raw-HTML sink, and it sanitizes", not a filename.
 *
 * `src/components` may not exist yet -- the UI is being built alongside this --
 * so a missing directory is skipped rather than treated as a failure. The guard
 * still has teeth the moment the first component lands.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCAN_DIRS = ['src/app', 'src/components']
const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs|mts)$/
const SINK = 'dangerouslySetInnerHTML'
const SANITIZER = 'sanitizeNarrative'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(entry)) out.push(full)
  }
  return out
}

function sourceFiles(): string[] {
  return SCAN_DIRS.flatMap((d) => {
    const abs = join(ROOT, d)
    return existsSync(abs) ? walk(abs) : []
  })
}

describe('raw HTML render boundary', () => {
  const files = sourceFiles()

  it('has a source tree to scan', () => {
    // Guards against the scan silently passing because the walker broke.
    expect(existsSync(join(ROOT, 'src/app'))).toBe(true)
    expect(files.length).toBeGreaterThan(0)
  })

  const sinks = files.filter((f) => readFileSync(f, 'utf8').includes(SINK))

  it(`uses ${SINK} in at most one component`, () => {
    const found = sinks.map((f) => relative(ROOT, f))
    expect(
      found.length,
      `${SINK} is the app's only raw-HTML sink and belongs in exactly one narrative ` +
        `component, so there is a single place to audit. Found it in ${found.length} ` +
        `file(s): ${found.join(', ')}`,
    ).toBeLessThanOrEqual(1)
  })

  it('src/lib/sanitize.ts stays a server module', () => {
    // `sanitize-html` is a Node library. A client directive at the top of the
    // sanitizer would drag the whole parser into the browser bundle and move the
    // security decision to a place the attacker's markup is already running.
    const src = readFileSync(join(ROOT, 'src/lib/sanitize.ts'), 'utf8')
    const firstStatement = src
      .split('\n')
      .find((line) => line.trim() !== '' && !line.trim().startsWith('/*') && !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    expect(firstStatement?.trim()).not.toMatch(/^['"]use client['"]/)
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
})
