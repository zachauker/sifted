#!/usr/bin/env tsx
/**
 * Post-migration verification.
 *
 * `buildVerificationReport` is a pure function of database contents: it reads
 * every recipe, tag, ingredient, step and hero image and returns a plain data
 * structure. `formatReport` turns that structure into the text a human reads.
 * `main` is the only impure part — it opens the real database connection and
 * prints. That split exists so the report can be unit-tested against an
 * in-memory database (see `tests/db/migration-verify.test.ts`) without a
 * network, a token, or a provisioned Turso database — none of which exist in
 * this environment. See `docs/migration-notes.md` for what running this for
 * real still requires.
 *
 * Usage:
 *   npm run migrate:verify
 *
 * The headline number is `zeroTags` cross-referenced with `unenriched`: a
 * rate-limited migration burst stores recipes that look fine — a title, a
 * source URL, ingredients as raw text — but carry no parsed quantities and no
 * tags, while every import job still reports success. Faceted filtering is
 * the entire reason this app exists, so a recipe with zero tags is invisible
 * to it. `enrichment_applied = false` is the flag that names the cause;
 * `npm run unenriched` is the existing repair tool for it.
 *
 * "156 in means 156 accounted for": every one of the source's 156 rows must
 * end up imported, recovered from a Notion page body, or explicitly listed as
 * unrecoverable (with a reason) in the migration's own report/resume file.
 * This script only sees what actually landed in the database, so a total
 * below 156 is not automatically a bug — it might mean some rows are still
 * sitting in the "unrecoverable" list. But it must never be silently
 * accepted: reconcile it against `docs/migration-report.md` and the runner's
 * resume file before calling the migration done.
 */
import { eq } from 'drizzle-orm'
import { pathToFileURL } from 'node:url'
import type { Db } from '../src/lib/db'
import { recipes, recipeTags, ingredients, steps, images } from '../src/lib/db/schema'
import type { Facet } from '../src/lib/taxonomy'

/* -------------------------------------------------------------------------- */
/* Measured facts, from the plan's "Measured facts about the source data"     */
/* -------------------------------------------------------------------------- */

export const EXPECTED_TOTAL_RECIPES = 156
export const EXPECTED_RATED = 74
export const EXPECTED_MADE_IT = 76
export const EXPECTED_WANT_TO_MAKE = 69
export const EXPECTED_BLANK_STATUS = 11
// Calendar dates (UTC), compared against createdAt with time stripped.
export const EXPECTED_OLDEST_DATE = '2019-11-09'
export const EXPECTED_NEWEST_DATE = '2026-08-23'

/* -------------------------------------------------------------------------- */
/* Report shape                                                               */
/* -------------------------------------------------------------------------- */

export type FacetCount = { facet: Facet; value: string; count: number }
export type ExtractionMethodCount = { method: string; count: number }
export type RecipeRef = { id: string; title: string }

export type VerificationReport = {
  totalRecipes: number

  withSourceUrl: number
  withHeroImage: number
  withNarrative: number
  withArchivedSource: number

  /** Recipes with no tags at all — the headline failure. */
  zeroTags: number
  /** Recipes stored with `enrichment_applied = false`. */
  unenriched: number
  /**
   * Of the unenriched recipes, those a re-import can actually repair: they have
   * a source URL *and* they were built from it.
   *
   * Recipes recovered from a Notion page body are deliberately excluded, even
   * though most of them do carry a source URL. The migration stores the row's
   * original URL on a body-recovered recipe on purpose — it is the recipe's
   * true provenance and it is what makes that path idempotent — but that URL is
   * exactly the one that was dead, blocked or wrong, which is why the body was
   * used at all. Counting those here made this a check that could never pass:
   * every body-recovered recipe was reported as repairable, folded into the
   * hard-failure test in `main`, and `npm run migrate:verify` exited 1 forever
   * with nothing an operator could do about it. A report that cannot be
   * satisfied stops being read.
   */
  unenrichedWithSourceUrl: RecipeRef[]
  /**
   * Of the unenriched recipes, those recovered from a Notion page body.
   *
   * Genuinely unenriched and genuinely not repairable by re-import, so they are
   * reported and not counted as failures. Conflating "needs repair" with
   * "cannot be repaired" is what made the number above untrustworthy.
   */
  unenrichedFromNotionBody: RecipeRef[]

  facetDistribution: FacetCount[]

  rated: number
  madeIt: number
  wantToMake: number
  blankStatus: number

  oldestCreatedAt: Date | null
  newestCreatedAt: Date | null

  noIngredients: RecipeRef[]
  noSteps: RecipeRef[]

  extractionMethodBreakdown: ExtractionMethodCount[]
}

/* -------------------------------------------------------------------------- */
/* The pure report builder                                                    */
/* -------------------------------------------------------------------------- */

export async function buildVerificationReport(db: Db): Promise<VerificationReport> {
  const [allRecipes, allTags, allIngredients, allSteps, heroImages] = await Promise.all([
    db.select().from(recipes),
    db.select().from(recipeTags),
    db.select({ recipeId: ingredients.recipeId }).from(ingredients),
    db.select({ recipeId: steps.recipeId }).from(steps),
    db.select({ recipeId: images.recipeId }).from(images).where(eq(images.role, 'source_hero')),
  ])

  const tagCountByRecipe = new Map<string, number>()
  const facetCounts = new Map<string, FacetCount>()
  for (const t of allTags) {
    tagCountByRecipe.set(t.recipeId, (tagCountByRecipe.get(t.recipeId) ?? 0) + 1)
    const key = `${t.facet}:${t.value}`
    const existing = facetCounts.get(key)
    if (existing) existing.count += 1
    else facetCounts.set(key, { facet: t.facet, value: t.value, count: 1 })
  }
  const facetDistribution = [...facetCounts.values()].sort(
    (a, b) => a.facet.localeCompare(b.facet) || b.count - a.count || a.value.localeCompare(b.value),
  )

  const ingredientRecipeIds = new Set(allIngredients.map((i) => i.recipeId))
  const stepRecipeIds = new Set(allSteps.map((s) => s.recipeId))
  const heroImageRecipeIds = new Set(heroImages.map((i) => i.recipeId))

  const extractionCounts = new Map<string, number>()
  for (const r of allRecipes) {
    extractionCounts.set(r.extractionMethod, (extractionCounts.get(r.extractionMethod) ?? 0) + 1)
  }
  const extractionMethodBreakdown = [...extractionCounts.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count || a.method.localeCompare(b.method))

  const noIngredients = allRecipes
    .filter((r) => !ingredientRecipeIds.has(r.id))
    .map((r) => ({ id: r.id, title: r.title }))
  const noSteps = allRecipes
    .filter((r) => !stepRecipeIds.has(r.id))
    .map((r) => ({ id: r.id, title: r.title }))

  const unenrichedRecipes = allRecipes.filter((r) => !r.enrichmentApplied)
  const unenrichedWithSourceUrl = unenrichedRecipes
    .filter((r) => r.sourceUrl !== null && r.extractionMethod !== 'notion')
    .map((r) => ({ id: r.id, title: r.title }))
  const unenrichedFromNotionBody = unenrichedRecipes
    .filter((r) => r.extractionMethod === 'notion')
    .map((r) => ({ id: r.id, title: r.title }))

  const createdTimes = allRecipes.map((r) => r.createdAt.getTime())
  const oldestCreatedAt = createdTimes.length ? new Date(Math.min(...createdTimes)) : null
  const newestCreatedAt = createdTimes.length ? new Date(Math.max(...createdTimes)) : null

  return {
    totalRecipes: allRecipes.length,

    withSourceUrl: allRecipes.filter((r) => r.sourceUrl !== null).length,
    withHeroImage: allRecipes.filter((r) => heroImageRecipeIds.has(r.id)).length,
    withNarrative: allRecipes.filter((r) => (r.narrativeHtml ?? '').trim() !== '').length,
    withArchivedSource: allRecipes.filter((r) => r.archivedHtmlKey !== null).length,

    zeroTags: allRecipes.filter((r) => (tagCountByRecipe.get(r.id) ?? 0) === 0).length,
    unenriched: unenrichedRecipes.length,
    unenrichedWithSourceUrl,
    unenrichedFromNotionBody,

    facetDistribution,

    rated: allRecipes.filter((r) => r.rating !== null).length,
    madeIt: allRecipes.filter((r) => r.status === 'made_it').length,
    wantToMake: allRecipes.filter((r) => r.status === 'want_to_make').length,
    blankStatus: allRecipes.filter((r) => r.status === null).length,

    oldestCreatedAt,
    newestCreatedAt,

    noIngredients,
    noSteps,

    extractionMethodBreakdown,
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting — separate from the report so the report stays testable         */
/* -------------------------------------------------------------------------- */

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function line(pass: boolean, label: string): string {
  return `  [${pass ? 'PASS' : 'FAIL'}] ${label}`
}

export function formatReport(report: VerificationReport): string {
  const out: string[] = []

  out.push('=== Migration verification ===\n')

  // --- Headline: total accounted for --------------------------------------
  const totalOk = report.totalRecipes === EXPECTED_TOTAL_RECIPES
  out.push(line(totalOk, `total recipes: ${report.totalRecipes} (expected ${EXPECTED_TOTAL_RECIPES})`))
  if (!totalOk) {
    out.push(
      '  *** DISCREPANCY *** 156 in means 156 accounted for. This script only sees\n' +
      '  what landed in the database. Reconcile the difference against\n' +
      '  docs/migration-report.md and the migration runner\'s resume file: every\n' +
      '  missing row must be explained as imported, recovered from a Notion body,\n' +
      '  or explicitly listed there as unrecoverable with a reason. Do not treat a\n' +
      '  mismatch as rounding error.',
    )
  }
  out.push('')

  // --- The headline failure mode: enrichment loss --------------------------
  out.push('--- Enrichment coverage (the most likely failure) ---')
  out.push(`  recipes with zero tags:              ${report.zeroTags} / ${report.totalRecipes}`)
  out.push(`  recipes with enrichment_applied=false: ${report.unenriched} / ${report.totalRecipes}`)
  const unenrichedOk = report.unenrichedWithSourceUrl.length === 0
  out.push(line(
    unenrichedOk,
    `unenriched recipes with a live source URL (repairable via re-import): ${report.unenrichedWithSourceUrl.length}`,
  ))
  if (!unenrichedOk) {
    for (const r of report.unenrichedWithSourceUrl) out.push(`    - ${r.title} (${r.id})`)
    out.push('  Repair by re-importing each source URL. List them with: npm run unenriched')
  }
  // Reported, never failed. These came out of a Notion page body precisely
  // because their source URL was dead, blocked or absent, so re-importing that
  // URL is not a repair — it is the thing that already did not work. They are
  // listed so the two populations stay distinguishable: the line above is a
  // to-do, this one is a fact about the library.
  out.push(
    `  unenriched recipes recovered from a Notion body (not repairable by re-import): ${report.unenrichedFromNotionBody.length}`,
  )
  for (const r of report.unenrichedFromNotionBody) out.push(`    - ${r.title} (${r.id})`)
  out.push('')

  // --- Coverage --------------------------------------------------------------
  out.push('--- Coverage ---')
  out.push(`  with source URL:       ${report.withSourceUrl} / ${report.totalRecipes}`)
  out.push(`  with hero image:       ${report.withHeroImage} / ${report.totalRecipes}`)
  out.push(`  with narrative:        ${report.withNarrative} / ${report.totalRecipes}`)
  out.push(`  with archived source:  ${report.withArchivedSource} / ${report.totalRecipes}`)
  out.push('')

  // --- Facet distribution -----------------------------------------------
  out.push('--- Facet distribution ---')
  if (report.facetDistribution.length === 0) {
    out.push('  (no tags in the database)')
  } else {
    let currentFacet: string | null = null
    for (const f of report.facetDistribution) {
      if (f.facet !== currentFacet) {
        currentFacet = f.facet
        out.push(`  ${f.facet}:`)
      }
      out.push(`    ${f.value.padEnd(20)} ${f.count}`)
    }
  }
  out.push('')

  // --- Rating / status reconciliation ---------------------------------------
  out.push('--- Rating and status (reconcile against the Notion source) ---')
  out.push(line(report.rated === EXPECTED_RATED, `rated: ${report.rated} (expected ${EXPECTED_RATED})`))
  out.push(line(report.madeIt === EXPECTED_MADE_IT, `made it: ${report.madeIt} (expected ${EXPECTED_MADE_IT})`))
  out.push(line(
    report.wantToMake === EXPECTED_WANT_TO_MAKE,
    `want to make: ${report.wantToMake} (expected ${EXPECTED_WANT_TO_MAKE})`,
  ))
  out.push(line(
    report.blankStatus === EXPECTED_BLANK_STATUS,
    `blank status: ${report.blankStatus} (expected ${EXPECTED_BLANK_STATUS})`,
  ))
  out.push('')

  // --- Dates ------------------------------------------------------------
  out.push('--- Creation dates (proving history was preserved, not flattened) ---')
  if (report.oldestCreatedAt === null || report.newestCreatedAt === null) {
    out.push('  [FAIL] no recipes in the database — cannot check date range')
  } else {
    const oldestStr = toDateOnly(report.oldestCreatedAt)
    const newestStr = toDateOnly(report.newestCreatedAt)
    out.push(line(oldestStr === EXPECTED_OLDEST_DATE, `oldest created_at: ${oldestStr} (expected ${EXPECTED_OLDEST_DATE})`))
    out.push(line(newestStr === EXPECTED_NEWEST_DATE, `newest created_at: ${newestStr} (expected ${EXPECTED_NEWEST_DATE})`))
  }
  out.push('')

  // --- Missing content -----------------------------------------------------
  out.push('--- Recipes with no ingredients (always suspect) ---')
  out.push(line(report.noIngredients.length === 0, `count: ${report.noIngredients.length}`))
  for (const r of report.noIngredients) out.push(`    - ${r.title} (${r.id})`)
  out.push('')

  out.push('--- Recipes with no steps (legitimate for a hand-typed family recipe recovered from a Notion body — check each by eye) ---')
  out.push(`  count: ${report.noSteps.length}`)
  for (const r of report.noSteps) out.push(`    - ${r.title} (${r.id})`)
  out.push('')

  // --- Extraction method breakdown ------------------------------------------
  out.push('--- Extraction method (how many were recovered from a Notion body rather than their source) ---')
  for (const m of report.extractionMethodBreakdown) {
    out.push(`  ${m.method.padEnd(12)} ${m.count}`)
  }
  out.push('')

  return out.join('\n')
}

/* -------------------------------------------------------------------------- */
/* CLI entry point                                                            */
/* -------------------------------------------------------------------------- */

async function main() {
  // Imported dynamically, not at module scope: the real db module opens a
  // connection using TURSO_DATABASE_URL at import time, which would break
  // every test that imports this file only for buildVerificationReport /
  // formatReport (as tests/db/migration-verify.test.ts does, against an
  // in-memory database with no such env var set).
  const { db } = await import('../src/lib/db')
  const report = await buildVerificationReport(db)
  console.log(formatReport(report))

  const hardFailures =
    report.totalRecipes !== EXPECTED_TOTAL_RECIPES ||
    report.unenrichedWithSourceUrl.length > 0 ||
    report.noIngredients.length > 0 ||
    report.rated !== EXPECTED_RATED ||
    report.madeIt !== EXPECTED_MADE_IT ||
    report.wantToMake !== EXPECTED_WANT_TO_MAKE

  if (hardFailures) process.exitCode = 1
}

// Only run when invoked directly (`tsx scripts/migration-verify.ts`), not when
// imported by a test for `buildVerificationReport` / `formatReport`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
