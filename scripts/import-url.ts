#!/usr/bin/env tsx
/**
 * Import recipes from this machine instead of from the deployed app.
 *
 * This exists because the two are not equivalent, and right now only one of
 * them works. Vercel's Node runtime starts with
 * `--no-experimental-require-module`, so `require()` of an ES module throws
 * there; jsdom reaches an ESM-only package, cannot load, and every route that
 * extracts returns a bare 500 (see `/api/health`). Your machine has no such
 * flag, so the identical pipeline runs fine here.
 *
 * It is also the better route for a blocked publisher even after that is
 * fixed: the sites that refuse Vercel's datacenter IPs generally do not refuse
 * a home connection, which is the whole reason the paste-HTML path exists.
 *
 * Everything real is real — the production database, blob storage, the model,
 * and `runImport` itself. This is not a second import implementation that can
 * drift from the one the app uses; it is the same function with the same
 * dependencies, called from a different place.
 *
 *   npm run import -- <url> [<url>...]     import or re-import specific URLs
 *   npm run import -- --unenriched         every recipe that has zero tags
 *   npm run import -- --missing            failed jobs whose URL has no recipe
 *   npm run import -- --enrich-only        re-run enrichment against what is
 *                                          already stored, with no fetching at
 *                                          all — the only repair available to a
 *                                          recipe whose page cannot be reached
 *   npm run import -- --html=page.html <url>
 *                                          use saved page source instead of
 *                                          fetching — for a publisher that
 *                                          blocks us even from here
 *
 *   --dry-run    list what would be imported, touch nothing
 *   --interval=MS  spacing between model calls (default 1200)
 */
import { readFile } from 'node:fs/promises'

import { eq } from 'drizzle-orm'

import { preflight, createThrottledLlm } from './migrate-notion'

const DEFAULT_INTERVAL_MS = 1200

function log(message: string): void {
  console.log(`[import] ${message}`)
}

type Options = {
  urls: string[]
  unenriched: boolean
  missing: boolean
  enrichOnly: boolean
  htmlPath: string | null
  dryRun: boolean
  intervalMs: number
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    urls: [],
    unenriched: false,
    missing: false,
    enrichOnly: false,
    htmlPath: null,
    dryRun: false,
    intervalMs: DEFAULT_INTERVAL_MS,
  }

  for (const arg of argv) {
    if (arg === '--unenriched') opts.unenriched = true
    else if (arg === '--missing') opts.missing = true
    else if (arg === '--enrich-only') opts.enrichOnly = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg.startsWith('--html=')) opts.htmlPath = arg.slice('--html='.length)
    else if (arg.startsWith('--interval=')) {
      const n = Number(arg.slice('--interval='.length))
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad --interval: ${arg}`)
      opts.intervalMs = n
    } else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
    else opts.urls.push(arg)
  }

  if (opts.htmlPath && opts.urls.length !== 1) {
    throw new Error('--html applies to exactly one URL')
  }
  if (!opts.urls.length && !opts.unenriched && !opts.missing && !opts.enrichOnly) {
    throw new Error('nothing to do: pass a URL, --unenriched, --missing, or --enrich-only')
  }
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  const [dbModule, jobsModule, storeModule, imagesModule, llmModule, schemaModule, importModule, drizzle] =
    await Promise.all([
      import('../src/lib/db'),
      import('../src/lib/db/queries/jobs'),
      import('../src/lib/storage/vercel-blob'),
      import('../src/lib/images/index'),
      import('../src/lib/llm/anthropic-client'),
      import('../src/lib/db/schema'),
      import('../src/lib/import/run-import'),
      import('drizzle-orm'),
    ])
  const { fetchPage } = await import('../src/lib/fetch/index')

  const db = dbModule.db
  const { recipes, importJobs, recipeTags } = schemaModule

  if (opts.enrichOnly) {
    await enrichOnly({ db, schema: schemaModule, dryRun: opts.dryRun, intervalMs: opts.intervalMs })
    if (!opts.urls.length && !opts.unenriched && !opts.missing) return
  }

  // Work out the list before spending anything on credentials.
  const targets = new Set(opts.urls)

  if (opts.unenriched) {
    const all = await db.select({ id: recipes.id, url: recipes.sourceUrl, title: recipes.title }).from(recipes)
    const tagged = new Set((await db.select({ id: recipeTags.recipeId }).from(recipeTags)).map((t) => t.id))
    const untagged = all.filter((r) => !tagged.has(r.id) && r.url)
    log(`--unenriched: ${untagged.length} recipes with no tags at all`)
    for (const r of untagged) {
      log(`    ${r.title}`)
      targets.add(r.url!)
    }
  }

  if (opts.missing) {
    const haveUrl = new Set(
      (await db.select({ url: recipes.sourceUrl }).from(recipes)).map((r) => r.url).filter(Boolean),
    )
    const jobs = await db.select().from(importJobs)
    // A failed job whose URL already has a recipe is a stale record of a
    // failure that a later run recovered from — re-importing it would be
    // paid work to replace a recipe that is already there.
    const orphaned = jobs.filter(
      (j) => (j.status === 'failed' || j.status === 'queued' || j.status === 'running') && !haveUrl.has(j.url),
    )
    const urls = [...new Set(orphaned.map((j) => j.url))]
    log(`--missing: ${urls.length} URLs with a failed job and no recipe`)
    for (const u of urls) {
      log(`    ${u}`)
      targets.add(u)
    }
  }

  const list = [...targets]
  if (!list.length) {
    log('nothing to import — everything asked for is already in the library')
    return
  }

  if (opts.dryRun) {
    log(`--dry-run: would import ${list.length} URL(s). Nothing was written.`)
    return
  }

  const suppliedHtml = opts.htmlPath ? await readFile(opts.htmlPath, 'utf8') : null
  if (suppliedHtml) log(`using ${opts.htmlPath} (${suppliedHtml.length} chars) instead of fetching`)

  const store = storeModule.createVercelBlobStore()
  const anthropic = llmModule.createAnthropicClient()
  await preflight({ store, llm: anthropic, log })
  const llm = createThrottledLlm(anthropic, opts.intervalMs)

  log(`importing ${list.length} URL(s)`)
  let ok = 0
  const problems: string[] = []

  for (const [i, url] of list.entries()) {
    const jobId = await jobsModule.createJob(db, url, null)
    await importModule.runImport({
      db,
      store,
      llm,
      jobId,
      url,
      suppliedHtml,
      // Every caller here is deliberately re-importing something that already
      // failed or stored badly, which is exactly what this flag is for.
      allowExistingUpdate: true,
      fetchPage,
      ingestHeroImage: imagesModule.ingestHeroImage,
    })

    const job = await jobsModule.getJob(db, jobId)
    const status = job?.status ?? 'unknown'
    const detail = job?.failureKind ? ` (${job.failureKind}: ${job.error ?? 'no detail'})` : ''
    log(`  [${i + 1}/${list.length}] ${status}${detail}  ${url}`)
    if (status === 'done' || status === 'duplicate') ok++
    else problems.push(`${status}${detail}  ${url}`)
  }

  console.log('')
  log(`${ok}/${list.length} imported`)
  if (problems.length) {
    log(`${problems.length} still need attention:`)
    for (const p of problems) log(`    ${p}`)
    log('For a blocked publisher, open the page in your browser, save the source,')
    log('and re-run with --html=<file> for that one URL.')
  }

  // Re-importing is the only way to fix a recipe that stored without tags, so
  // say plainly whether it worked rather than leaving it to be discovered as
  // an under-counting filter rail weeks later.
  const stillUntagged = await (async () => {
    const all = await db.select({ id: recipes.id, url: recipes.sourceUrl }).from(recipes)
    const tagged = new Set((await db.select({ id: recipeTags.recipeId }).from(recipeTags)).map((t) => t.id))
    return all.filter((r) => r.url && targets.has(r.url) && !tagged.has(r.id)).length
  })()
  if (stillUntagged) {
    log(`WARNING: ${stillUntagged} of these still have no tags — enrichment is failing silently.`)
  }

  void drizzle
}


/**
 * Re-runs enrichment against recipes that are already stored, touching no
 * network at all.
 *
 * This is the repair for the recipes that `--unenriched` cannot help: one
 * recovered from a Notion page body has no reachable source URL, so
 * re-importing it fetches nothing and it keeps its zero tags forever. In an app
 * built around a filter rail, a recipe with no tags is a recipe nobody finds.
 *
 * Only the model is spent here — the content is read straight out of the
 * database.
 */
async function enrichOnly(input: {
  db: Awaited<typeof import('../src/lib/db')>['db']
  schema: typeof import('../src/lib/db/schema')
  dryRun: boolean
  intervalMs: number
}): Promise<void> {
  const { db, schema } = input
  const { recipes, ingredients, recipeTags } = schema

  const [{ applyEnrichment }, { enrichStoredRecipe }, llmModule] = await Promise.all([
    import('../src/lib/extract/enrich'),
    import('../src/lib/db/queries/recipes'),
    import('../src/lib/llm/anthropic-client'),
  ])

  const all = await db.select({ id: recipes.id, title: recipes.title }).from(recipes)
  const tagged = new Set((await db.select({ id: recipeTags.recipeId }).from(recipeTags)).map((t) => t.id))
  const candidates = all.filter((r) => !tagged.has(r.id))

  log(`--enrich-only: ${candidates.length} recipes with no tags`)
  for (const r of candidates) log(`    ${r.title}`)
  if (!candidates.length) return

  if (input.dryRun) {
    log('--dry-run: nothing was written.')
    return
  }

  const anthropic = llmModule.createAnthropicClient()
  await preflight({ store: null, llm: anthropic, log })
  const llm = createThrottledLlm(anthropic, input.intervalMs)

  let fixed = 0
  for (const [i, r] of candidates.entries()) {
    const lines = await db
      .select({ position: ingredients.position, rawText: ingredients.rawText })
      .from(ingredients)
      .where(eq(ingredients.recipeId, r.id))
      .orderBy(ingredients.position)

    if (!lines.length) {
      log(`  [${i + 1}/${candidates.length}] skipped (no ingredients stored)  ${r.title}`)
      continue
    }

    const enriched = await applyEnrichment(
      {
        title: r.title,
        description: null, author: null, publisher: null,
        claimedTimeMinutes: null, servings: null, yieldText: null,
        ingredients: lines.map((l) => ({
          position: l.position, section: null, rawText: l.rawText,
          quantity: null, unit: null, item: null, note: null,
        })),
        steps: [],
        tags: [],
        heroImageUrl: null,
        extractionMethod: 'llm',
      },
      llm,
    )

    if (!enriched.tags.length) {
      log(`  [${i + 1}/${candidates.length}] STILL no tags — the model call failed  ${r.title}`)
      continue
    }

    await enrichStoredRecipe(db, r.id, {
      tags: enriched.tags,
      ingredients: enriched.ingredients.map((l) => ({
        position: l.position, quantity: l.quantity, unit: l.unit, item: l.item, note: l.note,
      })),
    })
    fixed++
    log(`  [${i + 1}/${candidates.length}] ${enriched.tags.length} tags  ${r.title}`)
  }

  console.log('')
  log(`${fixed}/${candidates.length} enriched in place`)
}

const invokedDirectly = /import-url\.(ts|js)$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  main().catch((error) => {
    console.error('\n[import] unexpected error:')
    console.error(error)
    process.exit(1)
  })
}
