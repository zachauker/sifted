import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { createMemoryStore } from '@/lib/storage/memory'
import type { LlmClient } from '@/lib/extract/llm-types'
import type { FetchedPage } from '@/lib/fetch'
import { createJob, getJob } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { recipes } from '@/lib/db/schema'

const SOURCE_URL = 'https://example.com/recipes/pathological'

/** Enough flat blocks that a single JSDOM parse of the document costs far more
 *  than the 50ms budget the test sets. The document is perfectly valid HTML and
 *  carries a real JSON-LD recipe, so the only reason the import fails is the
 *  budget — without it, this page would import fine, just slowly. */
const BLOCK_COUNT = 40_000

const RECIPE_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'A Recipe Nobody Will See',
  recipeIngredient: ['1 cup patience'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Wait.' }],
})

function pathologicalHtml(): string {
  const block = '<p>Flat block of prose that exists only to be parsed.</p>'
  return [
    '<!doctype html><html><head>',
    `<script type="application/ld+json">${RECIPE_JSON_LD}</script>`,
    '</head><body>',
    block.repeat(BLOCK_COUNT),
    '</body></html>',
  ].join('')
}

/**
 * `llm.enrich` yields a macrotask, exactly as a real network call to Anthropic
 * does. This is what lets the budget timer fire at all: `extract()` is
 * synchronous CPU work between its await points, so the timer callback cannot
 * run until the event loop reaches the timers phase. A fake that resolved
 * synchronously would keep the loop in the microtask queue and the timer would
 * never get a turn — see the comment on `withExtractionBudget`.
 */
const llm: LlmClient = {
  async enrich() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { description: null, tags: [], ingredients: [] }
  },
  async extractRecipe() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    return null
  },
}

let db: TestDb

beforeEach(async () => { db = await createTestDb() })

describe('runImport extraction budget', () => {
  // Generous, because the parse the budget abandons still runs to completion:
  // the timer converts a silent hang into a recorded failure, it does not stop
  // the CPU work.
  it('fails the job when extraction outruns its budget', async () => {
    const jobId = await createJob(db, SOURCE_URL, null)

    await runImport({
      db,
      store: createMemoryStore(),
      llm,
      jobId,
      url: SOURCE_URL,
      suppliedHtml: pathologicalHtml(),
      extractBudgetMs: 50,
      fetchPage: async (): Promise<FetchedPage> => { throw new Error('not used') },
      ingestHeroImage: async () => null,
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    expect(job?.failureKind).toBe('internal')
    expect(job?.error).toMatch(/50\s?ms/)
    expect(await db.select().from(recipes)).toHaveLength(0)
  }, 120_000)
})
