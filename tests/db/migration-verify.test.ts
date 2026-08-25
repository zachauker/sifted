import { describe, it, expect, beforeAll } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe, applyNotionMetadata } from '@/lib/db/queries/recipes'
import { images } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'
import {
  buildVerificationReport,
  formatReport,
  EXPECTED_TOTAL_RECIPES,
} from '../../scripts/migration-verify'

function extracted(overrides: Partial<ExtractedRecipe>): ExtractedRecipe {
  return {
    title: 'Untitled',
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
    ...overrides,
  }
}

let db: TestDb

// Four recipes standing in for the shapes the real migration produces:
//
// 1. Flatbread   — a fully-populated, cleanly-imported recipe. The baseline.
// 2. Casserole   — the failure the migration is most likely to produce: a
//                  rate-limited import that stores fine, reports success, but
//                  has zero tags and enrichment_applied = false.
// 3. Ham Pot Pie — recovered from a Notion page body: no source URL, no
//                  steps (a hand-typed family recipe with no instructions),
//                  extractionMethod 'notion'.
// 4. Blank Page  — an edge case that somehow landed with neither ingredients
//                  nor steps, to prove the "always suspect" detector fires.
beforeAll(async () => {
  db = await createTestDb()

  const flatbreadId = await upsertRecipe(db, {
    extracted: extracted({
      title: 'Homemade Flatbread',
      ingredients: [{ position: 0, section: null, rawText: '3 cups flour', quantity: 3, unit: 'cup', item: 'flour', note: null }],
      steps: [{ position: 0, section: null, text: 'Knead and bake.' }],
      tags: [{ facet: 'course', value: 'bread' }],
      narrativeHtml: '<p>A weeknight staple.</p>',
      extractionMethod: 'jsonld',
    }),
    sourceUrl: 'https://example.com/flatbread',
    sourceDomain: 'example.com',
    archivedHtmlKey: 'blobs/flatbread.html.gz',
    enrichmentApplied: true,
    createdAt: new Date('2019-11-09T15:04:05.000Z'), // the oldest recipe in the source
  })
  await db.insert(images).values({
    recipeId: flatbreadId, role: 'source_hero',
    blobKey: 'blobs/flatbread-hero.jpg', thumbKey: 'blobs/flatbread-hero-thumb.jpg',
    width: 800, height: 600,
  })
  await applyNotionMetadata(db, flatbreadId, { rating: 5, status: 'made_it', tags: [] })

  await upsertRecipe(db, {
    extracted: extracted({
      title: 'Rate-Limited Casserole',
      // Import wrote raw ingredient/step text, but the enrichment pass never
      // ran (or was rate-limited), so nothing was parsed and no tags exist.
      ingredients: [{ position: 0, section: null, rawText: '1 can cream of mushroom soup', quantity: null, unit: null, item: null, note: null }],
      steps: [{ position: 0, section: null, text: 'Bake at 350F for 30 minutes.' }],
      tags: [],
      extractionMethod: 'jsonld',
    }),
    sourceUrl: 'https://example.com/casserole',
    sourceDomain: 'example.com',
    enrichmentApplied: false,
    createdAt: new Date('2021-06-15T12:00:00.000Z'), // between the other three
  })

  const hamPotPieId = await upsertRecipe(db, {
    extracted: extracted({
      title: 'Ham Pot Pie',
      // Recovered from the Notion page body: verbatim, unenriched ingredient
      // lines, and no steps at all — the source body had no instructions.
      ingredients: [
        { position: 0, section: null, rawText: 'Ham', quantity: null, unit: null, item: null, note: null },
        { position: 1, section: null, rawText: 'Garlic', quantity: null, unit: null, item: null, note: null },
      ],
      steps: [],
      extractionMethod: 'notion',
    }),
    sourceUrl: null,
    sourceDomain: null,
    enrichmentApplied: false,
    createdAt: new Date('2022-01-30T00:02:00.000Z'),
  })
  await applyNotionMetadata(db, hamPotPieId, {
    rating: 5, status: 'made_it', tags: [{ facet: 'ingredient', value: 'pork' }],
  })

  const blankPageId = await upsertRecipe(db, {
    extracted: extracted({
      title: 'Blank Page',
      ingredients: [],
      steps: [],
      extractionMethod: 'llm',
    }),
    sourceUrl: 'https://example.com/blank',
    sourceDomain: 'example.com',
    enrichmentApplied: true,
    createdAt: new Date('2026-08-23T09:00:00.000Z'), // the newest recipe in the source
  })
  await applyNotionMetadata(db, blankPageId, { rating: null, status: 'want_to_make', tags: [] })
})

describe('buildVerificationReport', () => {
  it('counts the total', async () => {
    const report = await buildVerificationReport(db)
    expect(report.totalRecipes).toBe(4)
    // The real migration expects 156; this fixture set intentionally
    // doesn't match, which is exactly what the pass/fail line is for.
    expect(EXPECTED_TOTAL_RECIPES).toBe(156)
  })

  it('counts source URL, hero image, narrative, and archived-source coverage', async () => {
    const report = await buildVerificationReport(db)
    expect(report.withSourceUrl).toBe(3) // all but Ham Pot Pie
    expect(report.withHeroImage).toBe(1) // only Flatbread
    expect(report.withNarrative).toBe(1) // only Flatbread
    expect(report.withArchivedSource).toBe(1) // only Flatbread
  })

  it('flags zero-tag and unenriched recipes as the headline failure', async () => {
    const report = await buildVerificationReport(db)
    // Casserole and Blank Page both have zero tags.
    expect(report.zeroTags).toBe(2)
    // Casserole and Ham Pot Pie were stored with enrichment_applied = false.
    expect(report.unenriched).toBe(2)
    // Only Casserole is repairable by re-import (it has a source URL); Ham
    // Pot Pie does not, so it must not appear in the repairable list.
    expect(report.unenrichedWithSourceUrl.map((r) => r.title)).toEqual(['Rate-Limited Casserole'])
  })

  it('builds the facet distribution', async () => {
    const report = await buildVerificationReport(db)
    expect(report.facetDistribution).toEqual([
      { facet: 'course', value: 'bread', count: 1 },
      { facet: 'ingredient', value: 'pork', count: 1 },
    ])
  })

  it('counts rating and status', async () => {
    const report = await buildVerificationReport(db)
    expect(report.rated).toBe(2) // Flatbread, Ham Pot Pie
    expect(report.madeIt).toBe(2) // Flatbread, Ham Pot Pie
    expect(report.wantToMake).toBe(1) // Blank Page
    expect(report.blankStatus).toBe(1) // Casserole
  })

  it('finds the oldest and newest created_at', async () => {
    const report = await buildVerificationReport(db)
    expect(report.oldestCreatedAt?.toISOString()).toBe('2019-11-09T15:04:05.000Z')
    expect(report.newestCreatedAt?.toISOString()).toBe('2026-08-23T09:00:00.000Z')
  })

  it('flags recipes with no ingredients and recipes with no steps', async () => {
    const report = await buildVerificationReport(db)
    expect(report.noIngredients.map((r) => r.title)).toEqual(['Blank Page'])
    expect(report.noSteps.map((r) => r.title).sort()).toEqual(['Blank Page', 'Ham Pot Pie'])
  })

  it('breaks down extraction method, surfacing how many came from a Notion body', async () => {
    const report = await buildVerificationReport(db)
    expect(report.extractionMethodBreakdown).toEqual([
      { method: 'jsonld', count: 2 },
      { method: 'llm', count: 1 },
      { method: 'notion', count: 1 },
    ])
  })
})

describe('formatReport', () => {
  it('produces a loud FAIL line when the total does not match 156', async () => {
    const report = await buildVerificationReport(db)
    const text = formatReport(report)
    expect(text).toContain('[FAIL] total recipes: 4 (expected 156)')
    expect(text).toContain('DISCREPANCY')
  })

  it('lists unenriched, repairable recipes by name', async () => {
    const report = await buildVerificationReport(db)
    const text = formatReport(report)
    expect(text).toContain('Rate-Limited Casserole')
  })

  it('does not crash on an empty database', async () => {
    const empty = await createTestDb()
    const report = await buildVerificationReport(empty)
    const text = formatReport(report)
    expect(report.oldestCreatedAt).toBeNull()
    expect(text).toContain('no recipes in the database')
  })
})

/**
 * The body-recovered recipes the migration actually produces keep their source
 * URL. `processRow` stores the row's original URL on a body-recovered recipe on
 * purpose — it is the recipe's true provenance, it is what a later repair pass
 * would retry, and it is what makes that path idempotent — but that URL is
 * exactly the one that was dead, blocked or wrong, which is why the body was
 * used at all.
 *
 * The Ham Pot Pie above has `sourceUrl: null`, so the fixture set never saw
 * this. `unenrichedWithSourceUrl` filtered on `sourceUrl !== null` alone, which
 * meant every body-recovered recipe was reported as repairable by re-import,
 * counted into the hard failures in `main`, and `npm run migrate:verify` exited
 * 1 forever with nothing an operator could do to satisfy it.
 */
describe('unenriched recipes recovered from a Notion body', () => {
  let bodyDb: TestDb

  beforeAll(async () => {
    bodyDb = await createTestDb()

    // What the migration writes for a blocked publisher: the dead URL kept for
    // provenance, `extractionMethod` 'notion', enrichment never applied.
    await upsertRecipe(bodyDb, {
      extracted: extracted({
        title: 'Clipped Ham Pot Pie',
        ingredients: [
          { position: 0, section: null, rawText: 'Ham', quantity: null, unit: null, item: null, note: null },
        ],
        extractionMethod: 'notion',
      }),
      sourceUrl: 'https://getpocket.com/gone',
      sourceDomain: 'getpocket.com',
      enrichmentApplied: false,
      createdAt: new Date('2020-03-01T00:00:00.000Z'),
    })

    // A genuinely repairable recipe, for contrast: imported from a live URL,
    // enrichment lost to a rate limit.
    await upsertRecipe(bodyDb, {
      extracted: extracted({
        title: 'Rate-Limited Casserole',
        ingredients: [
          { position: 0, section: null, rawText: '1 can soup', quantity: null, unit: null, item: null, note: null },
        ],
        extractionMethod: 'jsonld',
      }),
      sourceUrl: 'https://example.com/casserole',
      sourceDomain: 'example.com',
      enrichmentApplied: false,
      createdAt: new Date('2021-06-15T12:00:00.000Z'),
    })
  })

  it('does not call a body-recovered recipe repairable by re-import', async () => {
    const report = await buildVerificationReport(bodyDb)
    expect(report.unenriched).toBe(2)
    expect(report.unenrichedWithSourceUrl.map((r) => r.title)).toEqual(['Rate-Limited Casserole'])
  })

  it('reports it separately instead, so the two populations stay distinct', async () => {
    const report = await buildVerificationReport(bodyDb)
    expect(report.unenrichedFromNotionBody.map((r) => r.title)).toEqual(['Clipped Ham Pot Pie'])

    const text = formatReport(report)
    expect(text).toContain('not repairable by re-import): 1')
    expect(text).toContain('Clipped Ham Pot Pie')
  })

  it('leaves a library whose only unenriched recipes came from Notion bodies passable', async () => {
    // The whole point: with nothing to repair, the repairable count is zero and
    // the check can be satisfied. It never could be before.
    const onlyBodies = await createTestDb()
    await upsertRecipe(onlyBodies, {
      extracted: extracted({ title: 'Grandma’s Biscuits', extractionMethod: 'notion' }),
      sourceUrl: 'https://getpocket.com/also-gone',
      sourceDomain: 'getpocket.com',
      enrichmentApplied: false,
    })
    const report = await buildVerificationReport(onlyBodies)
    expect(report.unenriched).toBe(1)
    expect(report.unenrichedWithSourceUrl).toEqual([])
  })
})
