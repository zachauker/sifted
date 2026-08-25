import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve, sep } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * `src/lib/notion/` exists only to support the one-time Notion migration
 * (`scripts/migrate-notion.ts`). Once that migration is run and verified, the
 * whole directory can be deleted — see `docs/migration-notes.md`. Nothing in
 * the running app (`src/app/`, or `src/lib/` outside this directory) may
 * depend on it, or deleting it later becomes a breaking change instead of the
 * cleanup it's supposed to be.
 *
 * Modeled on `src/lib/extract/purity.test.ts`, which guards a different
 * boundary the same way: read the source text of every file that must stay
 * clean and fail loudly if it isn't.
 *
 * This test was verified to actually fail: a temporary
 * `import '@/lib/notion/client'` was added to `src/lib/db/index.ts`, the test
 * was confirmed to fail with a listing of the offending file and import, and
 * the import was then removed. A guard that has never been seen to fail is
 * worthless — see the task report for the captured failure output.
 */

const notionDir = fileURLToPath(new URL('.', import.meta.url))
const srcDir = resolve(notionDir, '..', '..') // src/lib/notion -> src

const SCAN_ROOTS = ['app', 'lib'] as const

const SOURCE_EXTENSIONS = ['.ts', '.tsx']

// Specifiers that name this directory directly, regardless of how deep the
// importing file is nested — `@/lib/notion`, `@/lib/notion/client`, etc.
const ALIAS_PREFIX = '@/lib/notion'

type Violation = { file: string; specifier: string }

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full))
      continue
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    out.push(full)
  }
  return out
}

// Matches the specifier string out of `import ... from '...'`, bare
// `import '...'`, dynamic `import('...')`, and `require('...')` — enough
// forms to catch how imports are actually written in this codebase, without
// needing a full parser for a boundary check.
const IMPORT_SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*|^import\s+)['"]([^'"]+)['"]/gm

function findViolations(file: string): Violation[] {
  const src = readFileSync(file, 'utf8')
  const violations: Violation[] = []

  for (const match of src.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]

    if (specifier.startsWith(ALIAS_PREFIX)) {
      violations.push({ file, specifier })
      continue
    }

    // A relative import (`./notion`, `../lib/notion/client`, …) — resolve it
    // against the importing file's own directory and check whether it lands
    // inside src/lib/notion, however deep the relative path is.
    if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(file), specifier)
      const notionDirWithSep = notionDir.endsWith(sep) ? notionDir : notionDir + sep
      if (resolved === notionDir.replace(/\/$/, '') || resolved.startsWith(notionDirWithSep)) {
        violations.push({ file, specifier })
      }
    }
  }

  return violations
}

describe('src/lib/notion is not depended on by the running app', () => {
  // Files inside src/lib/notion itself are excluded from the scan: an import
  // from client.ts to types.ts is internal, not a boundary crossing. Only
  // files *outside* the directory count.
  const filesToCheck = SCAN_ROOTS
    .flatMap((root) => listSourceFiles(join(srcDir, root)))
    .filter((f) => !f.startsWith(notionDir))

  it('has files to check', () => {
    expect(filesToCheck.length).toBeGreaterThan(5)
  })

  it('excludes src/lib/notion itself from the scan', () => {
    expect(filesToCheck.some((f) => f.startsWith(notionDir))).toBe(false)
  })

  for (const file of filesToCheck) {
    const label = file.slice(srcDir.length + 1)
    it(`${label} does not import from src/lib/notion`, () => {
      const violations = findViolations(file)
      expect(
        violations,
        violations
          .map((v) => `${label} imports '${v.specifier}', which reaches into src/lib/notion`)
          .join('\n'),
      ).toEqual([])
    })
  }
})
