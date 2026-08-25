import { describe, it, expect, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  backoffDelayMs,
  classifyOneRow,
  classifyRow,
  createThrottledLlm,
  decideAction,
  forEachWithConcurrency,
  isRateLimitError,
  isTerminal,
  looksLikeLostIngredient,
  narrativeParagraphs,
  parseArgs,
  parseResumeFile,
  printSummary,
  processRow,
  renderReport,
  type DryRunDeps,
  type DryRunRow,
  type RowResult,
  type Runtime,
} from '../../scripts/migrate-notion'
import { mapNotionRow, type MigrationInput } from '@/lib/notion/map'
import { BlockedError, FetchFailedError, type FetchedPage } from '@/lib/fetch'
import type { NotionRecipeBody, NotionRecipeRow } from '@/lib/notion/types'
import type { LlmClient } from '@/lib/extract/llm-types'
import { createTestDb, type TestDb } from '../helpers/db'
import { createMemoryStore } from '@/lib/storage/memory'
import { createJob, getJob } from '@/lib/db/queries/jobs'
import {
  applyNotionMetadata,
  findBySourceUrl,
  upsertRecipe,
} from '@/lib/db/queries/recipes'
import { runImport } from '@/lib/import/run-import'
import * as schema from '@/lib/db/schema'

const anyEnrich = { title: 't', ingredientLines: [], rawTags: [] }
import structuredBody from './fixtures/body-structured.json'
import unstructuredBody from './fixtures/body-unstructured.json'

const input = (over: Partial<MigrationInput> = {}): MigrationInput => ({
  pageId: 'p1',
  notionTitle: 'Cast-Iron Green Chile Tamale Pie',
  publisher: 'Fine Cooking',
  author: null,
  sourceUrl: 'https://finecooking.com/recipe/tamale-pie',
  sourceDomain: 'finecooking.com',
  rating: 5,
  status: 'made_it',
  tags: [],
  createdAt: new Date('2019-11-09T15:04:05.000Z'),
  ...over,
})

const failed = (kind: string) => ({ status: 'failed', failureKind: kind })

describe('decideAction — before anything has been attempted', () => {
  it('imports a row that has a source url', () => {
    expect(decideAction(input(), null)).toEqual({ kind: 'import' })
  })

  it('sends a row with no link straight to its Notion body', () => {
    expect(decideAction(input({ sourceUrl: null, sourceDomain: null }), null)).toEqual({
      kind: 'notion-body',
    })
  })
})

describe('decideAction — after an import attempt', () => {
  it('falls back to the Notion body when the publisher blocked us', () => {
    expect(decideAction(input(), failed('blocked'))).toEqual({ kind: 'notion-body' })
  })

  it('falls back to the Notion body when the fetch failed', () => {
    expect(decideAction(input(), failed('fetch_failed'))).toEqual({ kind: 'notion-body' })
  })

  it('falls back to the Notion body when the page held no recipe', () => {
    expect(decideAction(input(), failed('no_recipe'))).toEqual({ kind: 'notion-body' })
  })

  it('skips retryably when the model failed, rather than downgrading to the body', () => {
    // The page is fine and the model was not. Falling back here would store a
    // permanently worse copy of a recipe we could have had properly, in
    // exchange for nothing: the model will be back in an hour and the resume
    // file brings this row round again.
    const action = decideAction(input(), failed('llm_failed'))
    expect(action.kind).toBe('skip')
    expect(action).toMatchObject({ retryable: true })
    if (action.kind === 'skip') expect(action.reason).toMatch(/model/i)
  })

  it('does not fall back to the body on an internal failure either', () => {
    const action = decideAction(input(), failed('internal'))
    expect(action).toMatchObject({ kind: 'skip', retryable: true })
  })

  it('treats an unrecognized failure kind as a retryable skip', () => {
    const action = decideAction(input(), failed('something_new'))
    expect(action).toMatchObject({ kind: 'skip', retryable: true })
  })

  it('needs no further action once the import is done', () => {
    const action = decideAction(input(), { status: 'done', failureKind: null })
    expect(action).toMatchObject({ kind: 'skip', retryable: false })
  })

  it('needs no further action when the recipe was already in the library', () => {
    const action = decideAction(input(), { status: 'duplicate', failureKind: null })
    expect(action).toMatchObject({ kind: 'skip', retryable: false })
  })

  it('skips retryably when the job never reached a conclusion', () => {
    for (const status of ['queued', 'running', 'missing']) {
      expect(decideAction(input(), { status, failureKind: null })).toMatchObject({
        kind: 'skip',
        retryable: true,
      })
    }
  })

  it('routes a linkless row to the body even if a stray outcome says blocked', () => {
    expect(decideAction(input({ sourceUrl: null }), failed('blocked'))).toEqual({
      kind: 'notion-body',
    })
  })
})

describe('classifyRow', () => {
  it('classifies a reachable page with structured data', () => {
    expect(classifyRow({ hasUrl: true, fetchOutcome: 'structured', bodyRecovered: false })).toBe(
      'structured',
    )
  })

  it('classifies a reachable page with no structured data as needing the model', () => {
    expect(classifyRow({ hasUrl: true, fetchOutcome: 'unstructured', bodyRecovered: false })).toBe(
      'needs-llm',
    )
  })

  it('prefers the Notion body over reporting a blocked or dead url', () => {
    // What the real run will do with the row is the thing worth counting, and
    // a blocked row its body can rescue still ends with a recipe.
    expect(classifyRow({ hasUrl: true, fetchOutcome: 'blocked', bodyRecovered: true })).toBe(
      'notion-body-only',
    )
    expect(classifyRow({ hasUrl: true, fetchOutcome: 'fetch-failed', bodyRecovered: true })).toBe(
      'notion-body-only',
    )
  })

  it('reports blocked and dead only when the body cannot rescue the row', () => {
    expect(classifyRow({ hasUrl: true, fetchOutcome: 'blocked', bodyRecovered: false })).toBe(
      'blocked',
    )
    expect(classifyRow({ hasUrl: true, fetchOutcome: 'fetch-failed', bodyRecovered: false })).toBe(
      'dead',
    )
  })

  it('classifies a row with no url anywhere by whether its body holds a recipe', () => {
    expect(classifyRow({ hasUrl: false, fetchOutcome: null, bodyRecovered: true })).toBe('no-link')
    expect(classifyRow({ hasUrl: false, fetchOutcome: null, bodyRecovered: false })).toBe(
      'unrecoverable',
    )
  })
})

describe('narrativeParagraphs', () => {
  it('recovers the lines the body parser set aside as prose', () => {
    expect(narrativeParagraphs('<p>We should try this.</p>\n<p>Grandma&amp;s recipe.</p>')).toEqual([
      'We should try this.',
      'Grandma&s recipe.',
    ])
  })

  it('unescapes the entities the body module wrote', () => {
    expect(narrativeParagraphs('<p>Salt &lt; pepper &gt; sugar</p>')).toEqual([
      'Salt < pepper > sugar',
    ])
  })

  it('returns nothing for a row with no narrative at all', () => {
    expect(narrativeParagraphs(null)).toEqual([])
    expect(narrativeParagraphs('')).toEqual([])
  })
})

describe('looksLikeLostIngredient', () => {
  it('flags a discarded line that carries a quantity', () => {
    // The failure this screen exists for: a quantityless-looking ingredient
    // written as a sentence, long enough that salvage called it prose.
    expect(looksLikeLostIngredient('Add 2 cups of buttermilk, warmed to room temperature.')).toBe(
      true,
    )
    expect(looksLikeLostIngredient('A pinch of saffron, if you have it lying about.')).toBe(true)
    expect(looksLikeLostIngredient('½ head of cabbage, cored and shredded very finely')).toBe(true)
  })

  it('leaves ordinary prose alone', () => {
    expect(looksLikeLostIngredient('This was my grandmother recipe and we make it every autumn.')).toBe(
      false,
    )
  })
})

describe('isRateLimitError', () => {
  it('recognizes the statuses that mean wait and try again', () => {
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true)
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 529 }))).toBe(true)
    expect(isRateLimitError(Object.assign(new Error('x'), { statusCode: 429 }))).toBe(true)
    expect(isRateLimitError(Object.assign(new Error('x'), { name: 'RateLimitError' }))).toBe(true)
    expect(isRateLimitError(new Error('rate limit exceeded, retry after 30s'))).toBe(true)
    expect(isRateLimitError(new Error('Overloaded'))).toBe(true)
  })

  it('does not mistake a genuine failure for one', () => {
    expect(isRateLimitError(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false)
    expect(isRateLimitError(new Error('invalid tool input'))).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError('429')).toBe(false)
  })
})

describe('backoffDelayMs', () => {
  it('doubles each attempt and then caps', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, 2_000))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000,
    ])
    expect(backoffDelayMs(10, 2_000)).toBe(60_000)
  })
})

describe('isTerminal', () => {
  const result = (outcome: RowResult['outcome']): RowResult => ({
    pageId: 'p',
    title: 't',
    outcome,
    via: null,
    recipeId: null,
    sourceUrl: null,
    rowSourceUrl: null,
    reason: null,
    at: '2026-08-25T00:00:00.000Z',
  })

  it('will not redo a row that landed', () => {
    expect(isTerminal(result('imported'))).toBe(true)
    expect(isTerminal(result('duplicate'))).toBe(true)
    expect(isTerminal(result('body-recovered'))).toBe(true)
    expect(isTerminal(result('unrecoverable'))).toBe(true)
  })

  it('retries a skip, which is the whole reason it is recorded', () => {
    expect(isTerminal(result('skipped'))).toBe(false)
  })

  it('treats an unrecorded row as unfinished', () => {
    expect(isTerminal(undefined)).toBe(false)
  })
})

describe('parseArgs', () => {
  it('defaults to the real run at concurrency 2', () => {
    const opts = parseArgs([])
    expect(opts.dryRun).toBe(false)
    expect(opts.concurrency).toBe(2)
    expect(opts.limit).toBeNull()
    expect(opts.resumePath).toBe('.migration-resume.json')
  })

  it('raises concurrency for the dry run, which is network-bound not model-bound', () => {
    expect(parseArgs(['--dry-run']).concurrency).toBe(3)
    expect(parseArgs(['--dry-run']).dryRun).toBe(true)
  })

  it('reads the overrides', () => {
    const opts = parseArgs([
      '--dry-run',
      '--limit=5',
      '--concurrency=1',
      '--model-interval=3000',
      '--resume=/tmp/r.json',
      '--report=/tmp/report.md',
      '--fresh',
    ])
    expect(opts).toMatchObject({
      limit: 5,
      concurrency: 1,
      modelIntervalMs: 3000,
      resumePath: '/tmp/r.json',
      reportPath: '/tmp/report.md',
      fresh: true,
    })
  })
})

describe('forEachWithConcurrency', () => {
  it('never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)

    await forEachWithConcurrency(items, 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
    })

    expect(peak).toBeLessThanOrEqual(3)
  })

  it('visits every item exactly once', async () => {
    const seen: number[] = []
    await forEachWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item)
    })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('stops scheduling once the run is told to stop', async () => {
    // The hard stop on an exhausted model rate limit. Rows in flight finish and
    // are recorded; nothing new starts.
    const seen: number[] = []
    let stop = false
    await forEachWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      1,
      async (item) => {
        seen.push(item)
        if (item === 4) stop = true
      },
      () => stop,
    )
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })
})

/* -------------------------------------------------------------------------- */
/* The dry run, driven from the committed fixtures                             */
/* -------------------------------------------------------------------------- */

const JSONLD_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Oatmeal Raisin Cookies',
  recipeIngredient: ['1 cup rolled oats', '1/2 cup raisins'],
  recipeInstructions: ['Mix everything.', 'Bake for 12 minutes.'],
})}</script></head><body><p>A cookie.</p></body></html>`

const PLAIN_PAGE = '<html><body><h1>Cookies</h1><p>We really like cookies here.</p></body></html>'

const page = (html: string, url = 'https://food.com/recipe/1'): FetchedPage => ({
  html,
  bytes: new TextEncoder().encode(html),
  encoding: 'utf-8',
  finalUrl: url,
  status: 200,
})

const notionRow = (over: Partial<NotionRecipeRow> = {}): NotionRecipeRow => ({
  pageId: 'p1',
  title: 'Oatmeal Raisin Cookies',
  link: 'https://www.food.com/recipe/oatmeal-raisin-cookies-35813',
  publisher: 'Food.com',
  author: null,
  rating: 4,
  cookingStatus: 'Made It',
  tags: ['Dessert'],
  createdTime: '2020-12-20 00:59:34Z',
  ...over,
})

const deps = (over: Partial<DryRunDeps> = {}): DryRunDeps => ({
  fetchPage: async () => page(JSONLD_PAGE),
  fetchBody: async () => ({ pageId: 'p1', markdown: '' }),
  ...over,
})

const classify = (row: NotionRecipeRow, d: Partial<DryRunDeps> = {}) =>
  classifyOneRow(row, mapNotionRow(row), deps(d))

describe('the dry run classifier', () => {
  it('costs nothing on a page with JSON-LD, and predicts one model call', async () => {
    const result = await classify(notionRow())
    expect(result.klass).toBe('structured')
    // Extraction is free; the real run still pays for one enrichment call.
    expect(result.modelCalls).toBe(1)
    expect(result.detail).toContain('jsonld')
  })

  it('predicts two model calls for a reachable page with no structured data', async () => {
    const result = await classify(notionRow(), { fetchPage: async () => page(PLAIN_PAGE) })
    expect(result.klass).toBe('needs-llm')
    // One to extract, one to enrich. The no-op model can only observe the
    // first, so the second is added back deliberately.
    expect(result.modelCalls).toBe(2)
  })

  it('recovers a blocked row from its Notion body', async () => {
    const result = await classify(notionRow({ title: 'Ham Pot Pie' }), {
      fetchPage: async (url) => {
        throw new BlockedError(url, 403)
      },
      fetchBody: async () => unstructuredBody as NotionRecipeBody,
    })
    expect(result.klass).toBe('notion-body-only')
    expect(result.fetchOutcome).toBe('blocked')
    expect(result.detail).toContain('HTTP 403')
    expect(result.bodyIngredients).toBeGreaterThan(0)
  })

  it('calls a dead link dead when nothing can rescue it', async () => {
    const result = await classify(notionRow(), {
      fetchPage: async (url) => {
        throw new FetchFailedError(url, 'getaddrinfo ENOTFOUND')
      },
      fetchBody: async () => ({ pageId: 'p1', markdown: 'We should try making this sometime.\n' }),
    })
    expect(result.klass).toBe('dead')
    expect(result.detail).toContain('ENOTFOUND')
  })

  it('finds the source url a row hid in its page body, and imports that instead', async () => {
    // The Tamale Pie row: an empty `Link` property, its URL in the first line
    // of the body. A row that looks unrecoverable is often importable.
    const seen: string[] = []
    const result = await classify(notionRow({ title: 'Tamale Pie', link: null }), {
      fetchBody: async () => structuredBody as NotionRecipeBody,
      fetchPage: async (url) => {
        seen.push(url)
        return page(JSONLD_PAGE, url)
      },
    })
    expect(result.urlFromBody).toBe(true)
    expect(result.url).toContain('finecooking.com')
    expect(seen).toHaveLength(1)
    expect(result.klass).toBe('structured')
  })

  it('models the real run\u2019s retry: a dead link whose body names a live URL', async () => {
    // The real runner consults the page body for a source URL on *every*
    // failure path, not only when the row has no link. The dry run used to
    // consult it only for a row with an empty `Link`, so a row this report
    // called `notion-body-only` could in fact be imported from a body URL off a
    // page nobody had looked at \u2014 and the report is the checkpoint an
    // operator is told to read before spending anything.
    const seen: string[] = []
    const body: NotionRecipeBody = {
      pageId: 'p1',
      markdown: ['[Jump to Recipe](https://seriouseats.com/other)', '', '## Ingredients', '', '- cabbage'].join('\n'),
    }

    const result = await classify(notionRow({ title: 'Charred Cabbage' }), {
      fetchBody: async () => body,
      fetchPage: async (url) => {
        seen.push(url)
        if (url === 'https://seriouseats.com/other') return page(JSONLD_PAGE, url)
        throw new FetchFailedError(url, 'getaddrinfo ENOTFOUND')
      },
    })

    expect(seen).toHaveLength(2)
    expect(result.klass).toBe('structured')
    expect(result.urlFromBody).toBe(true)
    expect(result.url).toBe('https://seriouseats.com/other')
    expect(result.rowUrl).toBe('https://food.com/recipe/oatmeal-raisin-cookies-35813')
    expect(result.detail).toContain('the page body names https://seriouseats.com/other, which works')
  })

  it('still calls a row notion-body-only when the body URL is no better', async () => {
    const body: NotionRecipeBody = {
      pageId: 'p1',
      markdown: [
        '[Jump to Recipe](https://seriouseats.com/other)',
        '',
        '## Ingredients',
        '',
        '- 2 cups flour',
        '',
        '## Instructions',
        '',
        '1. Bake it.',
      ].join('\n'),
    }
    const result = await classify(notionRow(), {
      fetchBody: async () => body,
      fetchPage: async (url) => {
        throw new BlockedError(url, 403)
      },
    })
    expect(result.klass).toBe('notion-body-only')
    expect(result.urlFromBody).toBe(false)
    expect(result.detail).toContain('is no better')
  })

  it('reports a titleless, bodyless row as unrecoverable instead of crashing', async () => {
    const result = await classify(notionRow({ title: null, link: null }))
    expect(result.klass).toBe('unrecoverable')
    expect(result.title).toBe('(untitled)')
    expect(result.modelCalls).toBe(0)
  })

  it('surfaces the lines the body parser threw away as narrative', async () => {
    // The Task 3 finding this dry run exists to check: a long quantityless
    // ingredient written as a sentence is dropped by `looksLikeNarrative` with
    // no trace. The report has to show it to a human.
    const lost = 'Enough good buttermilk to bring the dough together, plus more for brushing.'
    const alsoLost = 'Roughly a cup of lard, or shortening if that is what you have to hand.'
    const prose = 'Grandma made this every autumn and nobody ever wrote it down properly.'
    const markdown = [lost, alsoLost, prose, '2 cups flour', '1 tsp salt'].join('\n')

    const result = await classify(notionRow({ title: 'Biscuits', link: null }), {
      fetchBody: async () => ({ pageId: 'p1', markdown }),
    })

    expect(result.klass).toBe('no-link')
    expect(result.narrative).toEqual([lost, alsoLost, prose])

    // The REVIEW screen is a convenience, not a filter: it catches the line
    // carrying a unit word and misses the quantityless one — which is the very
    // case the audit exists for. That is why the report prints every narrative
    // line rather than only the flagged ones.
    expect(result.narrative.filter(looksLikeLostIngredient)).toEqual([alsoLost])
  })
})

describe('renderReport', () => {
  const row = (over: Partial<DryRunRow>): DryRunRow => ({
    pageId: 'p',
    title: 'A recipe',
    publisher: 'Bon Appétit',
    klass: 'structured',
    fetchOutcome: 'structured',
    url: 'https://bonappetit.com/r/1',
    rowUrl: 'https://bonappetit.com/r/1',
    urlFromBody: false,
    detail: 'jsonld, 10 ingredients, 4 steps',
    modelCalls: 1,
    bodyIngredients: 0,
    bodySteps: 0,
    narrative: [],
    ...over,
  })

  const report = renderReport(
    [
      row({}),
      row({ title: 'Plain page', klass: 'needs-llm', fetchOutcome: 'unstructured', modelCalls: 2 }),
      row({
        title: 'Ham Pot Pie',
        publisher: 'Homemade',
        klass: 'no-link',
        fetchOutcome: null,
        url: null,
        modelCalls: 2,
        bodyIngredients: 11,
        narrative: ['Add 2 cups of warm buttermilk to loosen it.', 'Grandma made this.'],
      }),
    ],
    { generatedAt: '2026-08-25T00:00:00.000Z', elapsedMs: 60_000 },
  )

  it('accounts for every row', () => {
    expect(report).toContain('| **total** | **3** |')
  })

  it('states the classification precedence, since the classes overlap in English', () => {
    expect(report).toContain('## How a row is classified')
    expect(report).toContain('`notion-body-only`')
  })

  it('estimates the spend', () => {
    expect(report).toContain('**5**, counted rather than guessed')
  })

  it('breaks the library down by publisher', () => {
    expect(report).toContain('## By publisher')
    expect(report).toContain('| Bon Appétit | 2 |')
  })

  it('lists everything that is not structured', () => {
    expect(report).toContain('## Everything that is not `structured`')
    expect(report).toContain('**Ham Pot Pie**')
    expect(report).not.toContain('**A recipe**')
  })

  it('names every row whose source URL came from the page body, with both URLs', () => {
    const text = renderReport(
      [
        row({
          title: 'Charred Cabbage',
          url: 'https://seriouseats.com/other',
          rowUrl: 'https://dead.example/gone',
          urlFromBody: true,
        }),
      ],
      { generatedAt: '2026-08-25T00:00:00.000Z', elapsedMs: 1000 },
    )
    expect(text).toContain('## Rows importing from a URL found in the page body')
    expect(text).toContain('row link: `https://dead.example/gone`')
    expect(text).toContain('will import: `https://seriouseats.com/other`')
  })

  it('flags a discarded narrative line that carries a quantity', () => {
    expect(report).toContain('**REVIEW** _Ham Pot Pie_ — Add 2 cups of warm buttermilk')
    expect(report).toContain('1 flagged for review')
  })
})

describe('parseResumeFile', () => {
  const good = JSON.stringify({
    version: 1,
    dataSourceId: 'ds-1',
    startedAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    rows: { p1: { pageId: 'p1', outcome: 'imported' } },
  })

  it('accepts a file this script wrote', () => {
    const result = parseResumeFile(good, 'ds-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.file.rows)).toEqual(['p1'])
  })

  // Every case below must be refused rather than treated as an empty file.
  // Silently starting over would re-insert every recipe recovered from a Notion
  // body with no source URL — the ones that exist nowhere else and have nothing
  // to dedupe against.
  it('refuses a truncated file rather than starting over', () => {
    expect(parseResumeFile('{"version":1,"rows":{', 'ds-1')).toMatchObject({ ok: false })
  })

  it('refuses something that is not an object', () => {
    expect(parseResumeFile('[]', 'ds-1')).toMatchObject({ ok: false })
    expect(parseResumeFile('"hello"', 'ds-1')).toMatchObject({ ok: false })
    expect(parseResumeFile('null', 'ds-1')).toMatchObject({ ok: false })
  })

  it('refuses a file from an older version of this script', () => {
    const result = parseResumeFile(JSON.stringify({ version: 0, rows: {} }), 'ds-1')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toContain('version')
  })

  it('refuses a file with no rows object', () => {
    expect(parseResumeFile(JSON.stringify({ version: 1 }), 'ds-1')).toMatchObject({ ok: false })
    expect(parseResumeFile(JSON.stringify({ version: 1, rows: [] }), 'ds-1')).toMatchObject({
      ok: false,
    })
  })

  it('refuses a file written for a different Notion database', () => {
    const result = parseResumeFile(good, 'ds-2')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.why).toContain('ds-1')
  })
})

describe('createThrottledLlm', () => {
  const rateLimited = () => Object.assign(new Error('rate_limit_error'), { status: 429 })

  it('spaces calls apart, however many are in flight', async () => {
    const inner: LlmClient = { enrich: async () => null, extractRecipe: async () => null }
    const llm = createThrottledLlm(inner, 20, 1)

    const started = Date.now()
    await Promise.all([llm.enrich(anyEnrich), llm.enrich(anyEnrich), llm.enrich(anyEnrich)])

    // Three calls, spaced: at least two gaps. Concurrency cannot outrun this,
    // which is the point — the model's limit is per minute, not per worker.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(llm.calls).toBe(3)
  })

  it('retries a rate limit with backoff and then succeeds', async () => {
    let attempts = 0
    const inner: LlmClient = {
      enrich: async () => {
        attempts++
        if (attempts < 3) throw rateLimited()
        return { ok: true }
      },
      extractRecipe: async () => null,
    }
    const llm = createThrottledLlm(inner, 0, 1)

    await expect(llm.enrich(anyEnrich)).resolves.toEqual({ ok: true })
    expect(attempts).toBe(3)
    expect(llm.retries).toBe(2)
    expect(llm.exhausted).toBe(false)
  })

  it('does not retry a real failure', async () => {
    let attempts = 0
    const inner: LlmClient = {
      enrich: async () => {
        attempts++
        throw Object.assign(new Error('invalid request'), { status: 400 })
      },
      extractRecipe: async () => null,
    }
    const llm = createThrottledLlm(inner, 0, 1)

    await expect(llm.enrich(anyEnrich)).rejects.toThrow('invalid request')
    expect(attempts).toBe(1)
    expect(llm.exhausted).toBe(false)
  })

  it('gives up, sticks, and then fails fast without calling the model again', async () => {
    // Exhaustion has to be sticky and observable. `applyEnrichment` swallows
    // every error it is handed by design, so the thrown error does not survive
    // the trip back to the runner — the flag is the only thing that does, and
    // it is what stops the run instead of importing 100 more tagless recipes.
    let attempts = 0
    const inner: LlmClient = {
      enrich: async () => {
        attempts++
        throw rateLimited()
      },
      extractRecipe: async () => null,
    }
    const llm = createThrottledLlm(inner, 0, 1)

    await expect(llm.enrich(anyEnrich)).rejects.toThrow(/rate limited after/)
    expect(attempts).toBe(6)
    expect(llm.exhausted).toBe(true)
    expect(llm.exhaustionDetail).toContain('enrich')

    await expect(llm.extractRecipe({ url: 'u', text: 't' })).rejects.toThrow(
      /stopped calling it/,
    )
    expect(attempts).toBe(6)
  })
})

/* -------------------------------------------------------------------------- */
/* processRow — the composition root                                          */
/*                                                                            */
/* Everything above this line tests a pure function. `processRow` is where     */
/* every module in this repo is actually wired together — the Notion mapping,  */
/* `runImport`, the body salvage, enrichment, `upsertRecipe`, the metadata     */
/* pass and the image ingest — and it is the only part of the migration that   */
/* can destroy data. It ran against a real database for the first time here.   */
/* -------------------------------------------------------------------------- */

const noopLlm: LlmClient = {
  async enrich() {
    return null
  },
  async extractRecipe() {
    return null
  },
}

/**
 * A model that answers. Enrichment landing is what `enrichment_applied` means,
 * and the difference between an enriched recipe and an unenriched one is the
 * whole subject of the first defect below.
 */
function enrichingLlm(log: string[] = []): LlmClient {
  return {
    async enrich({ ingredientLines }) {
      log.push('enrich')
      return {
        description: null,
        tags: [{ facet: 'course', value: 'main' }],
        ingredients: ingredientLines.map((line, position) => ({
          position,
          quantity: 1,
          unit: 'cup',
          item: line.replace(/^[\d\s]+/, ''),
          note: null,
        })),
      }
    },
    async extractRecipe() {
      log.push('extractRecipe')
      return null
    },
  }
}

const CABBAGE_JSONLD = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Charred Cabbage with Miso Butter',
  recipeIngredient: ['1 head green cabbage', '2 Tbsp. white miso'],
  recipeInstructions: ['Char the cabbage.', 'Whisk the miso butter.'],
})}</script></head><body><p>Cabbage.</p></body></html>`

// Canonical form: `normalizeSourceUrl` strips `www.` and tracking parameters,
// and it is the canonical URL that both `upsertRecipe` and the guard below key
// on.
const BONAPPETIT_URL = 'https://bonappetit.com/recipe/charred-cabbage'
const BONAPPETIT_LINK = 'https://www.bonappetit.com/recipe/charred-cabbage'

/** A Notion body that parses by headings alone, so no model call is needed. */
const CABBAGE_BODY: NotionRecipeBody = {
  pageId: 'p-b',
  markdown: ['# Charred Cabbage', '', '## Ingredients', '', '- cabbage', '', '## Instructions', '', '1. Char it.'].join('\n'),
}

function runtime(db: TestDb, over: Partial<Runtime> = {}): Runtime {
  return {
    db: db as unknown as Runtime['db'],
    createJob,
    getJob,
    upsertRecipe,
    findBySourceUrl,
    applyNotionMetadata,
    runImport,
    store: createMemoryStore(),
    ingestHeroImage: async () => null,
    anthropic: noopLlm,
    schema,
    eq,
    and,
    fetchPage: async (url) => {
      throw new FetchFailedError(url, 'the test did not stub this URL')
    },
    ...over,
  }
}

const noBody = async (): Promise<NotionRecipeBody> => ({ pageId: 'p', markdown: '' })

async function readRecipe(db: TestDb, id: string) {
  const [recipe] = await db.select().from(schema.recipes).where(eq(schema.recipes.id, id))
  const ings = await db
    .select()
    .from(schema.ingredients)
    .where(eq(schema.ingredients.recipeId, id))
    .orderBy(schema.ingredients.position)
  const tags = await db.select().from(schema.recipeTags).where(eq(schema.recipeTags.recipeId, id))
  return { recipe, ingredients: ings, tags }
}

describe('processRow — the ordinary import path', () => {
  it('imports, enriches, and stamps the row with what only Notion knew', async () => {
    const db = await createTestDb()
    const rt = runtime(db, { fetchPage: async (url) => page(CABBAGE_JSONLD, url) })

    const result = await processRow(
      notionRow({
        pageId: 'p-a',
        title: 'Charred Cabbage',
        link: `${BONAPPETIT_LINK}?utm_source=newsletter`,
        rating: 5,
        tags: ['Dinner'],
        createdTime: '2019-11-09 15:04:05Z',
      }),
      rt,
      enrichingLlm(),
      noBody,
    )

    expect(result.outcome).toBe('imported')
    expect(result.via).toBe('import')
    expect(result.sourceUrl).toBe(BONAPPETIT_URL)
    expect(result.rowSourceUrl).toBe(BONAPPETIT_URL)

    const stored = await readRecipe(db, result.recipeId!)
    expect(stored.recipe.extractionMethod).toBe('jsonld')
    expect(stored.recipe.enrichmentApplied).toBe(true)
    expect(stored.ingredients).toHaveLength(2)
    expect(stored.ingredients[0].item).not.toBeNull()
    expect(stored.tags.length).toBeGreaterThan(0)
    // The seven years of history the library *is*, preserved.
    expect(stored.recipe.createdAt.toISOString()).toBe('2019-11-09T15:04:05.000Z')
    expect(stored.recipe.rating).toBe(5)
    expect(stored.recipe.status).toBe('made_it')
  })
})

describe('processRow — a Notion-body recovery must not overwrite a good recipe', () => {
  /**
   * The verified data-loss path, in full.
   *
   * Row A imports `bonappetit.com/charred-cabbage` cleanly: enriched, two
   * parsed ingredients, tags. Row B is a second Notion row pointing at the same
   * canonical URL, and the publisher answers it with a 403. `runImport` fetches
   * *before* it dedupes, so the 403 throws first, the job records `blocked`, and
   * `decideAction` routes row B to the Notion body — which called `upsertRecipe`
   * directly, bypassing `EnrichmentRegressionError`, the guard built for exactly
   * this. `upsertRecipe` then found row A's recipe by `sourceUrl` and updated it
   * in place, replacing its children wholesale.
   *
   * Before the fix this test recorded: outcome `body-recovered` on row A's own
   * recipe id, `extractionMethod` 'notion', `enrichmentApplied` false, a single
   * ingredient `cabbage` with a null quantity and item, and zero tags. A working
   * recipe traded for a lossy Notion copy, with no error anywhere.
   */
  async function seedEnrichedRecipe(db: TestDb) {
    const rt = runtime(db, { fetchPage: async (url) => page(CABBAGE_JSONLD, url) })
    const first = await processRow(
      notionRow({ pageId: 'p-a', title: 'Charred Cabbage', link: BONAPPETIT_LINK, tags: [] }),
      rt,
      enrichingLlm(),
      noBody,
    )
    expect(first.outcome).toBe('imported')
    return first.recipeId!
  }

  it('refuses the downgrade and leaves the enriched recipe exactly as it was', async () => {
    const db = await createTestDb()
    const recipeId = await seedEnrichedRecipe(db)
    const before = await readRecipe(db, recipeId)

    const blocked = runtime(db, {
      fetchPage: async (url) => {
        throw new BlockedError(url, 403)
      },
    })
    const result = await processRow(
      notionRow({ pageId: 'p-b', title: 'Cabbage (again)', link: BONAPPETIT_LINK, tags: [] }),
      blocked,
      // No model: the body copy lands unenriched, which is the condition
      // `EnrichmentRegressionError` fires on.
      noopLlm,
      async () => CABBAGE_BODY,
    )

    expect(result.outcome).toBe('skipped')
    expect(result.recipeId).toBeNull()
    expect(result.reason).toMatch(/preserved and nothing was overwritten/)

    const after = await readRecipe(db, recipeId)
    expect(after.recipe.extractionMethod).toBe('jsonld')
    expect(after.recipe.enrichmentApplied).toBe(true)
    expect(after.ingredients.map((i) => i.rawText)).toEqual(
      before.ingredients.map((i) => i.rawText),
    )
    expect(after.ingredients.every((i) => i.item !== null)).toBe(true)
    expect(after.tags.length).toBe(before.tags.length)
    expect(after.tags.length).toBeGreaterThan(0)

    // And no second copy was inserted instead.
    const all = await db.select().from(schema.recipes)
    expect(all).toHaveLength(1)
  })

  it('is retryable rather than terminal, so a later run with a model can finish it', async () => {
    const db = await createTestDb()
    await seedEnrichedRecipe(db)
    const result = await processRow(
      notionRow({ pageId: 'p-b', title: 'Cabbage (again)', link: BONAPPETIT_LINK, tags: [] }),
      runtime(db, {
        fetchPage: async (url) => {
          throw new BlockedError(url, 403)
        },
      }),
      noopLlm,
      async () => CABBAGE_BODY,
    )
    expect(isTerminal(result)).toBe(false)
  })

  it('still stores a body recovery when nothing enriched is in its way', async () => {
    // The guard must not become a refusal to migrate. A dead URL with no
    // existing recipe behind it is exactly what the body path is for.
    const db = await createTestDb()
    const result = await processRow(
      notionRow({ pageId: 'p-c', title: 'Ham Pot Pie', link: 'https://getpocket.com/gone' }),
      runtime(db, {
        fetchPage: async (url) => {
          throw new FetchFailedError(url, 'getaddrinfo ENOTFOUND')
        },
      }),
      noopLlm,
      async () => CABBAGE_BODY,
    )

    expect(result.outcome).toBe('body-recovered')
    const stored = await readRecipe(db, result.recipeId!)
    expect(stored.recipe.extractionMethod).toBe('notion')
    // The dead URL is kept: it is the recipe's provenance and it is what makes
    // this path idempotent.
    expect(stored.recipe.sourceUrl).toBe('https://getpocket.com/gone')
  })

  it('does not block a body recovery over an existing recipe that was never enriched', async () => {
    const db = await createTestDb()
    const url = 'https://example.com/half-a-recipe'
    await upsertRecipe(db, {
      extracted: {
        title: 'Half a recipe',
        description: null,
        author: null,
        publisher: null,
        claimedTimeMinutes: null,
        servings: null,
        yieldText: null,
        ingredients: [],
        steps: [],
        tags: [],
        heroImageUrl: null,
        narrativeHtml: null,
        extractionMethod: 'jsonld',
      },
      sourceUrl: url,
      sourceDomain: 'example.com',
      enrichmentApplied: false,
    })

    const result = await processRow(
      notionRow({ pageId: 'p-d', title: 'Half a recipe', link: url }),
      runtime(db, {
        fetchPage: async (u) => {
          throw new BlockedError(u, 403)
        },
      }),
      noopLlm,
      async () => CABBAGE_BODY,
    )
    expect(result.outcome).toBe('body-recovered')
  })
})

describe('processRow — a body-derived source URL is never silent', () => {
  const JUMP_TO_RECIPE = 'https://seriouseats.com/some-other-recipe'

  /** A Notion clip whose first whole-line link is not this recipe at all. */
  const CLIPPED_BODY: NotionRecipeBody = {
    pageId: 'p-e',
    markdown: [`[Jump to Recipe](${JUMP_TO_RECIPE})`, '', '## Ingredients', '', '- cabbage'].join('\n'),
  }

  it('carries both URLs on the result, so the swap survives into the resume file', async () => {
    const db = await createTestDb()
    const result = await processRow(
      notionRow({ pageId: 'p-e', title: 'Charred Cabbage', link: 'https://dead.example/gone' }),
      runtime(db, {
        fetchPage: async (url) => {
          if (url === JUMP_TO_RECIPE) return page(CABBAGE_JSONLD, url)
          throw new FetchFailedError(url, 'getaddrinfo ENOTFOUND')
        },
      }),
      enrichingLlm(),
      async () => CLIPPED_BODY,
    )

    expect(result.outcome).toBe('imported')
    expect(result.via).toBe('body-url')
    expect(result.sourceUrl).toBe(JUMP_TO_RECIPE)
    expect(result.rowSourceUrl).toBe('https://dead.example/gone')
    expect(result.reason).toContain(JUMP_TO_RECIPE)
    expect(result.reason).toContain('https://dead.example/gone')
  })

  it('says so in the summary, with both URLs', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    try {
      printSummary({
        results: [
          {
            pageId: 'p-e',
            title: 'Charred Cabbage',
            outcome: 'imported',
            via: 'body-url',
            recipeId: 'r1',
            sourceUrl: JUMP_TO_RECIPE,
            rowSourceUrl: 'https://dead.example/gone',
            reason: 'source URL recovered from the Notion page body',
            at: '2026-08-25T00:00:00.000Z',
          },
        ],
        rows: [notionRow({ pageId: 'p-e' })],
        alreadyDone: 0,
        llm: createThrottledLlm(noopLlm, 0),
        elapsedMs: 1000,
        opts: parseArgs([]),
      })
    } finally {
      spy.mockRestore()
    }

    const text = lines.join('\n')
    expect(text).toContain('imported from a URL found in the page body')
    expect(text).toContain('https://dead.example/gone')
    expect(text).toContain(JUMP_TO_RECIPE)
  })
})

describe('processRow — the hero image is captured before anything throttled', () => {
  const NOTION_FILE_URL = 'https://prod-files.notion-static.com/hero.jpg?X-Amz-Expires=300'
  const BODY_WITH_IMAGE: NotionRecipeBody = {
    pageId: 'p-img',
    markdown: [
      `![hero](${NOTION_FILE_URL})`,
      '',
      // A link in the preamble, so the body path also makes an import attempt
      // of its own — one of the two things that used to sit between the body
      // arriving and the picture being fetched.
      '[Jump to Recipe](https://alsodead.example/recipe)',
      '',
      '## Ingredients',
      '',
      '- cabbage',
    ].join('\n'),
  }

  it('ingests it first, not after an import attempt and an enrichment call', async () => {
    const db = await createTestDb()
    const order: string[] = []
    const llm = enrichingLlm(order)

    const result = await processRow(
      notionRow({ pageId: 'p-img', title: 'Ham Pot Pie', link: 'https://dead.example/gone' }),
      runtime(db, {
        fetchPage: async (url) => {
          order.push(`fetchPage ${url}`)
          throw new FetchFailedError(url, 'getaddrinfo ENOTFOUND')
        },
        ingestHeroImage: async ({ recipeId, store }) => {
          order.push('ingestHeroImage')
          await store.put(`recipes/${recipeId}/hero.webp`, new Uint8Array([1, 2]), 'image/webp')
          await store.put(`recipes/${recipeId}/hero-thumb.webp`, new Uint8Array([3]), 'image/webp')
          return {
            blobKey: `recipes/${recipeId}/hero.webp`,
            thumbKey: `recipes/${recipeId}/hero-thumb.webp`,
            width: 800,
            height: 600,
          }
        },
      }),
      llm,
      async () => BODY_WITH_IMAGE,
    )

    expect(result.outcome).toBe('body-recovered')

    // The signature on a Notion file URL is good for five minutes. Nothing
    // throttled may run between the body arriving and those bytes being
    // fetched. The row's own link is attempted before the body is fetched at
    // all, so it is allowed to come first; everything after the body is not.
    expect(order).toEqual([
      'fetchPage https://dead.example/gone',
      'ingestHeroImage',
      'fetchPage https://alsodead.example/recipe',
      'enrich',
    ])
  })

  it('files the blobs under the real recipe id, not the placeholder it was captured with', async () => {
    const db = await createTestDb()
    const store = createMemoryStore()
    const result = await processRow(
      notionRow({ pageId: 'p-img', title: 'Ham Pot Pie', link: null }),
      runtime(db, {
        store,
        ingestHeroImage: async ({ recipeId, store: s }) => {
          await s.put(`recipes/${recipeId}/hero.webp`, new Uint8Array([1, 2]), 'image/webp')
          return {
            blobKey: `recipes/${recipeId}/hero.webp`,
            thumbKey: `recipes/${recipeId}/hero-thumb.webp`,
            width: 800,
            height: 600,
          }
        },
      }),
      noopLlm,
      async () => BODY_WITH_IMAGE,
    )

    const recipeId = result.recipeId!
    expect(store.keys()).toEqual([`recipes/${recipeId}/hero.webp`])
    const [image] = await db
      .select()
      .from(schema.images)
      .where(eq(schema.images.recipeId, recipeId))
    expect(image.blobKey).toBe(`recipes/${recipeId}/hero.webp`)
    expect(image.role).toBe('source_hero')
  })
})
