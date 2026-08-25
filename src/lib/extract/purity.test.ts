import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const dir = fileURLToPath(new URL('.', import.meta.url))

const FORBIDDEN = [
  ['@anthropic-ai/sdk', 'network SDK'],
  ['@/lib/db', 'database'],
  ['@/lib/fetch', 'network boundary'],
  ['@/lib/storage', 'blob storage'],
  ['@/lib/images', 'image pipeline'],
] as const

describe('lib/extract stays pure', () => {
  const sources = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  )

  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  for (const file of sources) {
    it(`${file} imports nothing impure`, () => {
      const src = readFileSync(join(dir, file), 'utf8')
      for (const [needle, why] of FORBIDDEN) {
        expect(src, `${file} must not import ${needle} (${why})`).not.toContain(needle)
      }
    })
  }
})
