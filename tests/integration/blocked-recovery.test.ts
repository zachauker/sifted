import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { gunzipSync } from 'node:zlib'
import { createMemoryStore } from '@/lib/storage/memory'
import type { LlmClient } from '@/lib/extract/llm-types'
import type { IngestedImage } from '@/lib/images'
import { recipes, ingredients, steps, recipeTags, images, users } from '@/lib/db/schema'
import { issueToken } from '@/lib/db/queries/tokens'

/**
 * The blocked → paste-HTML recovery round trip, driven through the real routes
 * and the real `runImport`, against a real migrated database.
 *
 * Every other test in this branch stops at one side of the route/pipeline seam.
 * The route tests replace `runImport` with `vi.fn()` and assert the shape of
 * the arguments it was handed; the pipeline tests build that argument object
 * themselves. Nothing has ever checked that the two agree. `job.url`,
 * `job.requestedBy`, `suppliedHtml`, `allowExistingUpdate` and both dependency
 * constructions cross that seam and are authored solely by the route, so a
 * wrong value there is invisible to both suites — which is exactly how the
 * `allowExistingUpdate` bug survived: its regression test inspects a mock's
 * arguments rather than observing that a retry actually stores a recipe.
 *
 * This is also the documented recovery path for publishers that refuse our
 * datacenter IP, which is a real slice of the 156-recipe migration. If it is
 * broken, the only way to find out is to try it by hand.
 *
 * What is faked, and nothing else: the network (`fetchPage`), the image
 * pipeline (`ingestHeroImage`), the blob store, the Anthropic client, and the
 * browser session that a retry needs. `runImport`, both route handlers, the
 * extractor, every query and the database are real.
 */

const h = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  ingestHeroImage: vi.fn(),
  auth: vi.fn(),
  /** Whatever `createVercelBlobStore()` should hand back this test. */
  store: null as ReturnType<typeof createMemoryStore> | null,
  /** Whatever `createAnthropicClient()` should hand back this test. */
  llm: null as LlmClient | null,
  /**
   * Background work the routes handed to `waitUntil`.
   *
   * Both routes return 202 the instant the job row exists and finish the import
   * detached, so there is nothing to await through the HTTP response — awaiting
   * `POST(...)` proves only that a job was queued. Capturing the promise here is
   * the smallest honest way to join it: the route's real control flow is
   * untouched (it still returns before the work completes, and a bug that
   * forgot to hand the promise over would leave `tasks` empty and fail the
   * assertions), while the test can wait for the work to settle before looking
   * at the database. Polling the job row instead would test the same thing more
   * slowly and flakily.
   */
  tasks: [] as Promise<unknown>[],
}))

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    h.tasks.push(promise)
  },
}))

/**
 * One real, migrated database for the whole file, shared by the test and by
 * every module under test. It has to be built inside the factory because the
 * route modules capture `db` at import time, and that import happens before any
 * hook runs.
 */
vi.mock('@/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db')
  return { db: await createTestDb() }
})

// `BlockedError` and `FetchFailedError` are spread through from the real
// module: `runImport` classifies failures with `instanceof`, so a stubbed
// module would turn a blocked publisher into `internal` and quietly invalidate
// the entire test.
vi.mock('@/lib/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/fetch')>()),
  fetchPage: h.fetchPage,
}))

vi.mock('@/lib/images', () => ({ ingestHeroImage: h.ingestHeroImage }))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: () => h.store }))
vi.mock('@/lib/llm/anthropic-client', () => ({ createAnthropicClient: () => h.llm }))

// The only thing a browser session gives the retry route is "a human is signed
// in". There is no way to mint a real NextAuth session in-process, and nothing
// downstream of the check reads the session.
vi.mock('@/lib/auth', () => ({ auth: h.auth }))

const { db } = await import('@/lib/db')
const { POST: importRoute } = await import('@/app/api/import/route')
const { POST: retryRoute } = await import('@/app/api/jobs/[id]/retry/route')
const { getJob, listJobs } = await import('@/lib/db/queries/jobs')
const { BlockedError } = await import('@/lib/fetch')

/* -------------------------------------------------------------------------- */

/**
 * A publisher that refuses datacenter IPs. Tracking params and the `www.` are
 * on the shared URL because the route strips both before anything else sees it.
 */
const SHARED_URL = 'https://www.bonappetit.com/recipe/gochujang-buttered-noodles?utm_source=text'
const CANONICAL_URL = 'https://bonappetit.com/recipe/gochujang-buttered-noodles'
const HERO_URL = 'https://assets.bonappetit.com/hero.jpg'

/** A second recipe, for the test that must not collide with the first. */
const DOUBLE_TAP_URL = 'https://www.bonappetit.com/recipe/miso-butter-radishes'
const DOUBLE_TAP_CANONICAL = 'https://bonappetit.com/recipe/miso-butter-radishes'

function recipeJsonLd(name: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name,
    description: 'Weeknight noodles with a chili-butter sauce.',
    author: { '@type': 'Person', name: 'Eric Kim' },
    image: HERO_URL,
    recipeYield: '4 servings',
    totalTime: 'PT20M',
    recipeIngredient: ['2 Tbsp. gochujang', '8 oz. wheat noodles', '4 Tbsp. unsalted butter'],
    recipeInstructions: [
      { '@type': 'HowToStep', text: 'Boil the noodles until barely tender.' },
      { '@type': 'HowToStep', text: 'Toss with the gochujang butter off the heat.' },
    ],
  }
}

/** What the user's phone captures from the page and pastes into the retry. */
function pastedHtml(name = 'Gochujang Buttered Noodles'): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${name}</title>`,
    `<script type="application/ld+json">${JSON.stringify(recipeJsonLd(name))}</script>`,
    '</head><body><article>',
    '<p>The first time I made these noodles I was standing in a kitchen that was',
    'not mine, in a city that was not mine, and the only thing in the fridge was',
    'a tub of gochujang and half a stick of butter. This is the story of what',
    'happened next, and why I have made them every week since.</p>',
    '</article></body></html>',
  ].join(' ')
}

const PASTED_HTML = pastedHtml()

const INGESTED: IngestedImage = {
  blobKey: 'recipes/x/hero.webp',
  thumbKey: 'recipes/x/hero-thumb.webp',
  blobUrl: 'memory://recipes/x/hero.webp',
  thumbUrl: 'memory://recipes/x/hero-thumb.webp',
  width: 1200,
  height: 800,
}

/**
 * A working model. `enrich` returns parsed quantities and tags, which is what
 * makes `enrichmentApplied` true and the recipe visible to faceted filtering.
 */
function workingLlm(): LlmClient {
  return {
    async enrich({ ingredientLines }) {
      return {
        description: null,
        tags: [
          { facet: 'course', value: 'main' },
          { facet: 'cuisine', value: 'korean' },
        ],
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
      throw new Error('extractRecipe should not be reached: this page has JSON-LD')
    },
  }
}

/** Drains the work the routes detached, including anything it queued in turn. */
async function settleBackgroundWork() {
  while (h.tasks.length > 0) {
    await Promise.all(h.tasks.splice(0))
  }
}

let bearerToken: string
let userId: string

beforeAll(async () => {
  // A real user and a real API token, so the bearer path through
  // `authenticateBearer` and `verifyToken` is the real one and `requestedBy`
  // carries a genuine foreign key rather than a made-up string.
  const [user] = await db
    .insert(users)
    .values({ name: 'Zach', email: 'zach@example.com', passwordHash: 'not-used-here' })
    .returning({ id: users.id })
  userId = user.id
  bearerToken = (await issueToken(db, userId, 'Zach’s iPhone')).token
})

beforeEach(() => {
  h.tasks.length = 0
  h.fetchPage.mockReset()
  h.ingestHeroImage.mockReset()
  h.auth.mockReset()
  h.store = createMemoryStore()
  h.llm = workingLlm()
  h.ingestHeroImage.mockResolvedValue(INGESTED)
  h.auth.mockResolvedValue({ user: { email: 'zach@example.com' } })
})

function importRequest(body: unknown) {
  return new Request('https://app.example.com/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify(body),
  })
}

function retryRequest(jobId: string, body?: unknown) {
  return [
    new Request(`https://app.example.com/api/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: jobId }) },
  ] as const
}

describe('blocked publisher → pasted HTML recovery, through the real routes', () => {
  it('fails the first import as blocked, then stores the recipe from pasted HTML', async () => {
    /* --- 1. The share sheet. The publisher refuses our datacenter IP. ------ */

    h.fetchPage.mockRejectedValue(new BlockedError(CANONICAL_URL, 403))

    const queued = await importRoute(importRequest({ url: SHARED_URL }))
    expect(queued.status).toBe(202)
    const { jobId, status } = (await queued.json()) as { jobId: string; status: string }
    expect(status).toBe('queued')

    // The route answered before the work ran — that is the contract with a
    // share sheet on cellular, and the reason this test has to join the
    // background promise at all.
    expect((await getJob(db, jobId))?.status).not.toBe('failed')

    await settleBackgroundWork()

    const blocked = await getJob(db, jobId)
    expect(blocked?.status).toBe('failed')
    expect(blocked?.failureKind).toBe('blocked')
    expect(blocked?.error).toContain('403')
    expect(blocked?.finishedAt).toBeInstanceOf(Date)
    expect(blocked?.recipeId).toBeNull()

    // The URL the pipeline was told to fetch is the canonical one the route
    // derived, not the tracking-laden string the phone sent. Only the route
    // authors this, and no other test observes it.
    expect(h.fetchPage.mock.calls).toEqual([[CANONICAL_URL]])
    expect(blocked?.url).toBe(CANONICAL_URL)
    expect(blocked?.requestedBy).toBe(userId)

    expect(await db.select().from(recipes)).toHaveLength(0)

    /* --- 2. The user opens the page on their phone and pastes the HTML. --- */

    // If anything reaches the network on this path the recovery is a fiction:
    // the publisher would refuse us a second time.
    h.fetchPage.mockRejectedValue(new Error('the network must not be touched on a paste'))

    const retried = await retryRoute(...retryRequest(jobId, { html: PASTED_HTML }))
    expect(retried.status).toBe(202)
    expect(await retried.json()).toEqual({ status: 'queued', jobId })

    await settleBackgroundWork()

    expect(h.fetchPage).toHaveBeenCalledTimes(1) // still just the blocked attempt

    /* --- 3. The recipe is really there. ---------------------------------- */

    const stored = await db.select().from(recipes)
    expect(stored).toHaveLength(1)
    const recipe = stored[0]

    expect(recipe.title).toBe('Gochujang Buttered Noodles')
    // Keyed on the canonical URL the *job* carried, which is the value the
    // retry route reads off the row and hands to the pipeline. A retry that
    // read the wrong field would store the recipe under the wrong URL, or fail
    // to store it at all.
    expect(recipe.sourceUrl).toBe(CANONICAL_URL)
    expect(recipe.sourceDomain).toBe('bonappetit.com')
    expect(recipe.author).toBe('Eric Kim')
    expect(recipe.claimedTimeMinutes).toBe(20)
    expect(recipe.extractionMethod).toBe('jsonld')
    expect(recipe.enrichmentApplied).toBe(true)

    // The attribution the retry route carries across from `job.requestedBy` —
    // the original sharer, not the person who happened to press retry.
    expect(recipe.addedBy).toBe(userId)

    const lines = await db
      .select()
      .from(ingredients)
      .where(eq(ingredients.recipeId, recipe.id))
      .orderBy(ingredients.position)
    expect(lines.map((l) => l.rawText)).toEqual([
      '2 Tbsp. gochujang',
      '8 oz. wheat noodles',
      '4 Tbsp. unsalted butter',
    ])
    expect(lines.every((l) => l.quantity !== null)).toBe(true)

    const instructions = await db
      .select()
      .from(steps)
      .where(eq(steps.recipeId, recipe.id))
      .orderBy(steps.position)
    expect(instructions.map((s) => s.text)).toEqual([
      'Boil the noodles until barely tender.',
      'Toss with the gochujang butter off the heat.',
    ])

    const tags = await db.select().from(recipeTags).where(eq(recipeTags.recipeId, recipe.id))
    expect(tags.map((t) => t.value).sort()).toEqual(['korean', 'main'])

    // The blob store the route constructed is the one the pipeline wrote to.
    expect(recipe.archivedHtmlKey).toBeTruthy()
    const archived = await h.store!.get(recipe.archivedHtmlKey!)
    expect(archived).not.toBeNull()
    expect(gunzipSync(Buffer.from(archived!)).toString('utf8')).toBe(PASTED_HTML)

    // The image pipeline the route constructed, likewise.
    expect(h.ingestHeroImage.mock.calls[0][0]).toMatchObject({ url: HERO_URL })
    const heroRows = await db.select().from(images).where(eq(images.recipeId, recipe.id))
    expect(heroRows).toHaveLength(1)
    expect(heroRows[0].blobKey).toBe(INGESTED.blobKey)

    /* --- 4. And the job says so. ----------------------------------------- */

    const done = await getJob(db, jobId)
    expect(done?.status).toBe('done')
    expect(done?.recipeId).toBe(recipe.id)
    // The previous attempt's blocked message must not survive onto a job that
    // now reads as successful.
    expect(done?.error).toBeNull()
    expect(done?.failureKind).toBeNull()

    // One job, start to finish. The recovery reuses the row rather than
    // stacking a second entry in the tray for the same import.
    const tray = await listJobs(db)
    expect(tray.filter((j) => j.url === CANONICAL_URL)).toHaveLength(1)
  })

  /**
   * The behavioural test for `allowExistingUpdate`.
   *
   * The existing regression test for that flag reads it back off a `vi.fn()`'s
   * arguments, which proves the route passes a boolean and nothing about what
   * the boolean does. This one never mentions the flag: it presses retry on a
   * red job whose URL has since acquired a recipe, and requires the recipe to
   * change. Delete `allowExistingUpdate: true` from the retry route and the
   * pipeline reports `duplicate` instead — the button silently does nothing,
   * the job stays unrepaired, and this fails.
   *
   * The setup is the double tap, which is how this actually happens: an import
   * takes 5-20 seconds and the share sheet gives no feedback, so the user taps
   * share again. Both jobs are created before either has written a recipe —
   * the API's own pre-check cannot see a row that does not exist yet — and both
   * then fail against a blocking publisher. Recovering the first one leaves the
   * second sitting in the tray, red, with a URL that now has a recipe and a
   * `recipeId` of its own that is still null.
   */
  it('re-extracts on retry when the URL acquired a recipe while the job sat failed', async () => {
    h.fetchPage.mockRejectedValue(new BlockedError(DOUBLE_TAP_CANONICAL, 403))

    // Two taps. Nothing runs in between, because the routes detach their work
    // and this test is holding both promises — which is exactly the real
    // interleaving, not a contrivance.
    const first = await importRoute(importRequest({ url: DOUBLE_TAP_URL }))
    const second = await importRoute(importRequest({ url: DOUBLE_TAP_URL }))
    expect([first.status, second.status]).toEqual([202, 202])

    const jobA = ((await first.json()) as { jobId: string }).jobId
    const jobB = ((await second.json()) as { jobId: string }).jobId
    expect(jobA).not.toBe(jobB)

    await settleBackgroundWork()
    expect((await getJob(db, jobA))?.failureKind).toBe('blocked')
    expect((await getJob(db, jobB))?.failureKind).toBe('blocked')

    h.fetchPage.mockRejectedValue(new Error('the network must not be touched on a paste'))

    // Recover the first one. Now a recipe exists at the canonical URL.
    await retryRoute(...retryRequest(jobA, { html: pastedHtml('Miso-Butter Radishes') }))
    await settleBackgroundWork()

    const before = await db
      .select()
      .from(recipes)
      .where(eq(recipes.sourceUrl, DOUBLE_TAP_CANONICAL))
      .get()
    expect(before?.title).toBe('Miso-Butter Radishes')

    // The second job is still red in the tray, and still points at nothing.
    const stale = await getJob(db, jobB)
    expect(stale?.status).toBe('failed')
    expect(stale?.recipeId).toBeNull()

    // The user presses retry on it, pasting a fresher capture of the page.
    await retryRoute(...retryRequest(jobB, { html: pastedHtml('Miso-Butter Radishes, Revised') }))
    await settleBackgroundWork()

    const repaired = await getJob(db, jobB)
    // `duplicate` here would mean the retry button did nothing at all.
    expect(repaired?.status).toBe('done')
    expect(repaired?.recipeId).toBe(before!.id)

    const after = await db.select().from(recipes).where(eq(recipes.id, before!.id)).get()
    // The observable difference between "re-extracted" and "silently skipped".
    expect(after?.title).toBe('Miso-Butter Radishes, Revised')

    // In place, not alongside: the UNIQUE constraint on `source_url` means a
    // second row was never possible, so a bug here shows up as a lost update
    // rather than a duplicate row. Asserted anyway.
    const rows = await db
      .select()
      .from(recipes)
      .where(eq(recipes.sourceUrl, DOUBLE_TAP_CANONICAL))
    expect(rows).toHaveLength(1)
  })
})
