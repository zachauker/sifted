import { describe, it, expect, beforeEach, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { createMemoryStore } from '@/lib/storage/memory'
import type { BlobStore } from '@/lib/storage'
import { BlockedError, FetchFailedError, type FetchedPage } from '@/lib/fetch'
import type { LlmClient } from '@/lib/extract/llm-types'
import type { IngestedImage } from '@/lib/images'
import { createJob, getJob } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { extract } from '@/lib/extract'
import { recipes, ingredients, images } from '@/lib/db/schema'

/**
 * `extract` is spied on, not stubbed: the real implementation still runs, so
 * every other test in this file is unaffected. The spy exists for one
 * assertion — that a duplicate is recognised *before* the expensive half of the
 * import, which is the entire value of the dedupe check and is invisible from
 * the outside otherwise.
 */
vi.mock('@/lib/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/extract')>()
  return { ...actual, extract: vi.fn(actual.extract) }
})

const SOURCE_URL = 'https://example.com/recipes/gochujang-noodles?utm_source=text'
const CANONICAL_URL = 'https://example.com/recipes/gochujang-noodles'
const HERO_URL = 'https://cdn.example.com/hero.jpg'

/**
 * A curly apostrophe (U+2019) sits in the title on purpose: it is the one
 * character that makes the windows-1252 bytes below differ from a UTF-8
 * re-encode of `html`, which is exactly what the archive test checks.
 */
const RECIPE_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Grandma’s Gochujang Noodles',
  description: 'Weeknight noodles with a chili-butter sauce.',
  author: { '@type': 'Person', name: 'Eric Kim' },
  image: HERO_URL,
  recipeYield: '4 servings',
  totalTime: 'PT20M',
  recipeIngredient: ['2 Tbsp. gochujang', '8 oz. wheat noodles'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Boil the noodles until barely tender.' },
    { '@type': 'HowToStep', text: 'Toss with the gochujang butter off the heat.' },
  ],
}

function recipeHtml(): string {
  return [
    '<!doctype html><html><head><meta charset="windows-1252">',
    `<title>Grandma’s Gochujang Noodles</title>`,
    `<script type="application/ld+json">${JSON.stringify(RECIPE_JSON_LD)}</script>`,
    '</head><body><article>',
    '<p>The first time I made these noodles I was standing in a kitchen that was',
    'not mine, in a city that was not mine, and the only thing in the fridge was',
    'a tub of gochujang and half a stick of butter. This is the story of what',
    'happened next, and why I have made them every week since.</p>',
    '</article></body></html>',
  ].join(' ')
}

const PLAIN_HTML = '<!doctype html><html><head><title>Just a blog</title></head>' +
  '<body><article><p>No recipe here, only opinions about kitchen renovations.</p>' +
  '</article></body></html>'

/**
 * Encodes the ASCII + U+2019 subset the fixtures use. Real windows-1252 bytes
 * matter here: they are what proves the archive stores what the server sent
 * rather than a UTF-8 re-encode of the decoded string.
 */
function toWindows1252(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x2019) out[i] = 0x92
    else if (code < 0x80) out[i] = code
    else throw new Error(`fixture character U+${code.toString(16)} is not in the encoder`)
  }
  return out
}

function fetchedPage(html: string, overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    html,
    bytes: toWindows1252(html),
    encoding: 'windows-1252',
    finalUrl: SOURCE_URL,
    status: 200,
    ...overrides,
  }
}

function fakeFetch(page: FetchedPage | (() => never)) {
  const calls: string[] = []
  const fn = async (url: string): Promise<FetchedPage> => {
    calls.push(url)
    if (typeof page === 'function') return page()
    return page
  }
  return Object.assign(fn, { calls })
}

const INGESTED: IngestedImage = {
  blobKey: 'recipes/x/hero.webp',
  thumbKey: 'recipes/x/hero-thumb.webp',
  width: 1200,
  height: 800,
}

function fakeIngest(result: IngestedImage | null = INGESTED) {
  const calls: string[] = []
  const fn = async (input: { url: string; recipeId: string; store: BlobStore }) => {
    calls.push(input.url)
    return result
  }
  return Object.assign(fn, { calls })
}

function fakeLlm(overrides: Partial<LlmClient> = {}): LlmClient {
  return {
    async enrich({ ingredientLines }) {
      return {
        description: null,
        tags: [{ facet: 'course', value: 'main' }],
        ingredients: ingredientLines.map((line, position) => ({
          position,
          quantity: position + 1,
          unit: 'tablespoon',
          item: line.replace(/^[\d\s.]+\w+\.?\s*/, '') || line,
          note: null,
        })),
      }
    },
    async extractRecipe() {
      throw new Error('extractRecipe should not have been called')
    },
    ...overrides,
  }
}

let db: TestDb
let store: ReturnType<typeof createMemoryStore>

beforeEach(async () => {
  db = await createTestDb()
  store = createMemoryStore()
  vi.mocked(extract).mockClear()
})

async function newJob(url = SOURCE_URL) {
  return createJob(db, url, null)
}

describe('runImport', () => {
  it('stores the recipe and marks the job done', async () => {
    const jobId = await newJob()
    const fetchPage = fakeFetch(fetchedPage(recipeHtml()))

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage, ingestHeroImage: fakeIngest(),
    })

    const [recipe] = await db.select().from(recipes)
    expect(recipe.title).toBe('Grandma’s Gochujang Noodles')
    expect(recipe.sourceUrl).toBe(CANONICAL_URL)
    expect(recipe.sourceDomain).toBe('example.com')
    expect(recipe.author).toBe('Eric Kim')
    expect(recipe.claimedTimeMinutes).toBe(20)
    expect(recipe.extractionMethod).toBe('jsonld')
    expect(recipe.enrichmentApplied).toBe(true)

    const lines = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipe.id))
    expect(lines).toHaveLength(2)

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('done')
    expect(job?.recipeId).toBe(recipe.id)
    expect(job?.finishedAt).toBeInstanceOf(Date)
    expect(job?.error).toBeNull()
    expect(job?.failureKind).toBeNull()
  })

  it('archives the original bytes gzipped and records the encoding', async () => {
    const jobId = await newJob()
    const page = fetchedPage(recipeHtml())

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(page), ingestHeroImage: fakeIngest(),
    })

    const [recipe] = await db.select().from(recipes)
    expect(recipe.sourceEncoding).toBe('windows-1252')
    expect(recipe.archivedHtmlKey).toBeTruthy()

    const blob = await store.get(recipe.archivedHtmlKey!)
    expect(blob).not.toBeNull()

    const restored = gunzipSync(Buffer.from(blob!))
    expect(Buffer.from(restored)).toEqual(Buffer.from(page.bytes))
    // Guards the point of the exercise: the archive is NOT a re-encode of the
    // decoded string, which for this windows-1252 page would differ.
    expect(Buffer.from(restored)).not.toEqual(Buffer.from(page.html, 'utf8'))
  })

  it('writes an images row for the ingested hero image', async () => {
    const jobId = await newJob()
    const ingest = fakeIngest()

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: ingest,
    })

    expect(ingest.calls).toEqual([HERO_URL])

    const [recipe] = await db.select().from(recipes)
    const rows = await db.select().from(images).where(eq(images.recipeId, recipe.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('source_hero')
    expect(rows[0].blobKey).toBe(INGESTED.blobKey)
    expect(rows[0].thumbKey).toBe(INGESTED.thumbKey)
    expect(rows[0].width).toBe(1200)
    expect(rows[0].height).toBe(800)
  })

  it('marks a blocked publisher as blocked and stores no recipe', async () => {
    const jobId = await newJob()

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(() => { throw new BlockedError(SOURCE_URL, 403) }),
      ingestHeroImage: fakeIngest(),
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    expect(job?.failureKind).toBe('blocked')
    expect(job?.error).toContain('403')
    expect(job?.finishedAt).toBeInstanceOf(Date)
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('marks a broken fetch as fetch_failed', async () => {
    const jobId = await newJob()

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(() => { throw new FetchFailedError(SOURCE_URL, 'HTTP 500') }),
      ingestHeroImage: fakeIngest(),
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    expect(job?.failureKind).toBe('fetch_failed')
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('marks a page with no recipe as no_recipe', async () => {
    const jobId = await newJob()
    const llm = fakeLlm({ async extractRecipe() { return { nothing: true } } })

    await runImport({
      db, store, llm, jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(PLAIN_HTML)), ingestHeroImage: fakeIngest(),
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    expect(job?.failureKind).toBe('no_recipe')
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('short-circuits the fetch entirely when HTML is supplied', async () => {
    const jobId = await newJob()
    const fetchPage = fakeFetch(() => { throw new Error('fetchPage must not be called') })

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      suppliedHtml: recipeHtml(),
      fetchPage, ingestHeroImage: fakeIngest(),
    })

    expect(fetchPage.calls).toEqual([])

    const [recipe] = await db.select().from(recipes)
    expect(recipe.title).toBe('Grandma’s Gochujang Noodles')
    expect(recipe.sourceUrl).toBe(CANONICAL_URL)
    expect((await getJob(db, jobId))?.status).toBe('done')
  })

  it('stores the recipe with enrichmentApplied false when the LLM fails', async () => {
    const jobId = await newJob()
    const llm = fakeLlm({ async enrich() { throw new Error('rate limited') } })

    await runImport({
      db, store, llm, jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: fakeIngest(),
    })

    const [recipe] = await db.select().from(recipes)
    expect(recipe.enrichmentApplied).toBe(false)
    const lines = await db.select().from(ingredients).where(eq(ingredients.recipeId, recipe.id))
    expect(lines.every((l) => l.quantity === null)).toBe(true)
    expect(lines.map((l) => l.rawText)).toEqual(['2 Tbsp. gochujang', '8 oz. wheat noodles'])

    expect((await getJob(db, jobId))?.status).toBe('done')
  })

  it('succeeds without an images row when the hero image cannot be ingested', async () => {
    const jobId = await newJob()

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: fakeIngest(null),
    })

    const [recipe] = await db.select().from(recipes)
    expect(recipe.title).toBe('Grandma’s Gochujang Noodles')
    expect(await db.select().from(images)).toHaveLength(0)
    expect((await getJob(db, jobId))?.status).toBe('done')
  })

  it('stores the post-redirect canonical URL while the job keeps the URL it was given', async () => {
    const requested = 'https://bit.ly/3xyzabc'
    const jobId = await newJob(requested)

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: requested,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())),
      ingestHeroImage: fakeIngest(),
    })

    const [recipe] = await db.select().from(recipes)
    const job = await getJob(db, jobId)
    // The two deliberately differ: the recipe is keyed on where the bytes came
    // from, the job records what the user actually shared. Any dedupe check
    // that runs against the job's URL is therefore checking the wrong key.
    expect(recipe.sourceUrl).toBe(CANONICAL_URL)
    expect(job?.url).toBe(requested)
  })

  it('leaves one recipe and one hero image when the same job is run twice', async () => {
    const jobId = await newJob()
    const args = {
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())),
      ingestHeroImage: fakeIngest(),
    }

    await runImport(args)
    await runImport(args)

    expect(await db.select().from(recipes)).toHaveLength(1)
    // The source hero is replaced, not appended, or a retried import would
    // leave the recipe carrying one image row per attempt.
    expect(await db.select().from(images)).toHaveLength(1)
    expect((await getJob(db, jobId))?.status).toBe('done')
  })

  it('records an unexpected error as internal instead of throwing', async () => {
    const jobId = await newJob()
    const explosion = 'x'.repeat(5000)
    const brokenStore: BlobStore = {
      async put() { throw new Error(explosion) },
      async get() { return null },
      async delete() {},
    }

    const result = await runImport({
      db, store: brokenStore, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: fakeIngest(),
    })

    expect(result).toBeUndefined()

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    expect(job?.failureKind).toBe('internal')
    // Truncated, so one huge stack cannot bloat the row.
    expect(job?.error!.length).toBeLessThanOrEqual(2000)
    expect(await db.select().from(recipes)).toHaveLength(0)
  })
})

describe('runImport: an existing recipe is never traded for worse data', () => {
  it('refuses to overwrite an enriched recipe when this run’s enrichment fails', async () => {
    const jobId = await newJob()
    const shared = {
      db,
      store,
      jobId,
      url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())),
      ingestHeroImage: fakeIngest(),
    }

    await runImport({ ...shared, llm: fakeLlm() })

    const [before] = await db.select().from(recipes)
    expect(before.enrichmentApplied).toBe(true)

    // The same job runs again — a redelivered queue message, say — while the
    // model is rate limited. Nothing about the page changed; only the model
    // went away.
    await runImport({
      ...shared,
      llm: fakeLlm({ async enrich() { throw new Error('429 rate limited') } }),
    })

    const [after] = await db.select().from(recipes)
    expect(after.id).toBe(before.id)
    expect(after.enrichmentApplied).toBe(true)

    // The point of the exercise: the parsed values are still the originals, not
    // the nulls this run would have written.
    const lines = await db
      .select()
      .from(ingredients)
      .where(eq(ingredients.recipeId, after.id))
      .orderBy(ingredients.position)
    expect(lines.map((l) => l.quantity)).toEqual([1, 2])
    expect(lines.map((l) => l.unit)).toEqual(['tablespoon', 'tablespoon'])
    expect(lines.map((l) => l.item)).toEqual(['gochujang', 'wheat noodles'])

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    // Retryable, not permanent: a later run with a working model stores exactly
    // the data we declined to destroy.
    expect(job?.failureKind).toBe('llm_failed')
    expect(job?.error).toMatch(/preserved/)
  })
})

describe('runImport: an unavailable model is not a page without a recipe', () => {
  it('marks a rejected extractRecipe call as llm_failed', async () => {
    const jobId = await newJob()
    const llm = fakeLlm({
      async extractRecipe() { throw new Error('429 rate limited') },
    })

    await runImport({
      db, store, llm, jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(PLAIN_HTML)), ingestHeroImage: fakeIngest(),
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    // `no_recipe` would be a claim about the page that this run cannot make:
    // nothing ever looked at it.
    expect(job?.failureKind).toBe('llm_failed')
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('still marks an answered-but-empty extraction as no_recipe', async () => {
    const jobId = await newJob()
    const llm = fakeLlm({
      async extractRecipe() {
        return {
          title: '   ',
          description: null,
          author: null,
          claimedTimeMinutes: null,
          servings: null,
          yieldText: null,
          ingredients: [],
          steps: [],
        }
      },
    })

    await runImport({
      db, store, llm, jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(PLAIN_HTML)), ingestHeroImage: fakeIngest(),
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    // The model answered and there was nothing there. A retry never helps.
    expect(job?.failureKind).toBe('no_recipe')
    expect(await db.select().from(recipes)).toHaveLength(0)
  })
})

describe('runImport: dedupe happens on the post-redirect canonical URL', () => {
  async function seedExistingRecipe() {
    const jobId = await newJob()
    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: fakeIngest(),
    })
    const [recipe] = await db.select().from(recipes)
    vi.mocked(extract).mockClear()
    return recipe
  }

  it('marks a shortened link that redirects onto an existing recipe as duplicate', async () => {
    const recipe = await seedExistingRecipe()

    const shortened = 'https://bit.ly/3xyzabc'
    const jobId = await newJob(shortened)
    const ingest = fakeIngest()

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: shortened,
      // The bytes come back from the canonical URL, which is the only place the
      // duplicate is visible.
      fetchPage: fakeFetch(fetchedPage(recipeHtml())), ingestHeroImage: ingest,
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('duplicate')
    expect(job?.recipeId).toBe(recipe.id)
    expect(job?.failureKind).toBeNull()
    expect(job?.finishedAt).toBeInstanceOf(Date)

    // Skipping the expensive half is the whole point: no extraction, no model
    // calls, no image download.
    expect(vi.mocked(extract)).not.toHaveBeenCalled()
    expect(ingest.calls).toEqual([])
    expect(await db.select().from(recipes)).toHaveLength(1)
  })

  it('re-extracts an existing recipe when the caller asks for it', async () => {
    const recipe = await seedExistingRecipe()

    const html = recipeHtml().replace(/Grandma’s Gochujang Noodles/g, 'Updated Gochujang Noodles')
    const jobId = await newJob()

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      // What the retry route sets. A failed job has no `recipeId`, so nothing
      // on the row could stand in for this — only the caller knows a human
      // pressed retry.
      allowExistingUpdate: true,
      fetchPage: fakeFetch(fetchedPage(html)), ingestHeroImage: fakeIngest(),
    })

    expect(vi.mocked(extract)).toHaveBeenCalledOnce()

    const rows = await db.select().from(recipes)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(recipe.id)
    expect(rows[0].title).toBe('Updated Gochujang Noodles')

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('done')
    expect(job?.recipeId).toBe(recipe.id)
  })
})

/**
 * The archive is written before extraction, not after, and that ordering is the
 * entire payoff of `archived_html_key`. "Improve the parser, re-run every
 * recipe offline" is void for exactly the pages you would most want to re-run,
 * if a page the parser could not read is the one page whose bytes get thrown
 * away.
 */
describe('runImport: the page is archived before extraction can fail', () => {
  /** The one blob under `archives/`, gunzipped. Fails loudly if there isn't exactly one. */
  async function archivedBytes(): Promise<Buffer> {
    const keys = store.keys().filter((k) => k.startsWith('archives/'))
    expect(keys).toHaveLength(1)
    const blob = await store.get(keys[0])
    expect(blob).not.toBeNull()
    return Buffer.from(gunzipSync(Buffer.from(blob!)))
  }

  it('keeps the archived page when the extraction finds no recipe', async () => {
    const jobId = await newJob()
    const page = fetchedPage(PLAIN_HTML)
    const llm = fakeLlm({ async extractRecipe() { return { nothing: true } } })

    await runImport({
      db, store, llm, jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(page), ingestHeroImage: fakeIngest(),
    })

    const job = await getJob(db, jobId)
    expect(job?.status).toBe('failed')
    expect(job?.failureKind).toBe('no_recipe')
    expect(await db.select().from(recipes)).toHaveLength(0)

    // The point: no recipe row exists to point at this blob, and the bytes are
    // still there anyway. This is the page that becomes the next parser's test
    // fixture, and re-fetching it later may be impossible.
    expect(await archivedBytes()).toEqual(Buffer.from(page.bytes))
  })

  it('keeps the pasted HTML when a recovered blocked job then fails to extract', async () => {
    const jobId = await newJob()
    const llm = fakeLlm({ async extractRecipe() { return { nothing: true } } })

    // The recovery path for a `blocked` publisher: the user captured the page
    // on their phone and pasted it in. There is no second copy anywhere.
    await runImport({
      db, store, llm, jobId, url: SOURCE_URL,
      suppliedHtml: PLAIN_HTML,
      fetchPage: fakeFetch(() => { throw new Error('fetchPage must not be called') }),
      ingestHeroImage: fakeIngest(),
    })

    expect((await getJob(db, jobId))?.failureKind).toBe('no_recipe')
    // Without this the user has to go and paste the same page a second time.
    expect(await archivedBytes()).toEqual(Buffer.from(PLAIN_HTML, 'utf8'))
  })

  it('keeps the archived page when enrichment would regress an existing recipe', async () => {
    const jobId = await newJob()
    const shared = {
      db, store, jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(recipeHtml())),
      ingestHeroImage: fakeIngest(),
    }

    await runImport({ ...shared, llm: fakeLlm() })

    const revised = recipeHtml().replace(/8 oz. wheat noodles/, '8 oz. soba noodles')
    const revisedPage = fetchedPage(revised)

    await runImport({
      ...shared,
      fetchPage: fakeFetch(revisedPage),
      allowExistingUpdate: true,
      llm: fakeLlm({ async enrich() { throw new Error('429 rate limited') } }),
    })

    expect((await getJob(db, jobId))?.failureKind).toBe('llm_failed')
    // The recipe row was correctly left alone, but the newer bytes are kept:
    // they are what a later re-extraction with a working model should read.
    expect(await archivedBytes()).toEqual(Buffer.from(revisedPage.bytes))
  })

  it('does not overwrite an existing archive on the duplicate short-circuit', async () => {
    const jobId = await newJob()
    const original = fetchedPage(recipeHtml())

    await runImport({
      db, store, llm: fakeLlm(), jobId, url: SOURCE_URL,
      fetchPage: fakeFetch(original), ingestHeroImage: fakeIngest(),
    })

    // A re-share of a link we already have, a year later, when the URL now
    // serves a paywall stub. The archive key is a pure function of the
    // canonical URL, so archiving before the dedupe check would replace the
    // article with the stub — and the recipe row's `sourceEncoding` would then
    // describe bytes that are gone.
    const stub = '<!doctype html><html><body><p>Subscribe to continue.</p></body></html>'
    const laterJob = await newJob()

    await runImport({
      db, store, llm: fakeLlm(), jobId: laterJob, url: SOURCE_URL,
      fetchPage: fakeFetch(fetchedPage(stub)), ingestHeroImage: fakeIngest(),
    })

    expect((await getJob(db, laterJob))?.status).toBe('duplicate')
    expect(await archivedBytes()).toEqual(Buffer.from(original.bytes))
  })
})
