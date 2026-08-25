import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { Db } from '@/lib/db'
import { images } from '@/lib/db/schema'
import { markDone, markFailed, markRunning, type FailureKind } from '@/lib/db/queries/jobs'
import { upsertRecipe } from '@/lib/db/queries/recipes'
import { extract, NoRecipeFoundError, type ExtractedRecipe } from '@/lib/extract'
import type { LlmClient } from '@/lib/extract/llm-types'
import { BlockedError, FetchFailedError, type FetchedPage } from '@/lib/fetch'
import type { IngestedImage } from '@/lib/images'
import type { BlobStore } from '@/lib/storage'
import { normalizeSourceUrl } from '@/lib/url'
import { eq, and } from 'drizzle-orm'

const gzipAsync = promisify(gzip)

/**
 * How long extraction may run before the job is failed instead of left hanging.
 *
 * Measured: `@mozilla/readability` is superlinear in block count, and a 3 MB
 * page of flat blocks — a size the fetch layer's cap admits — costs about 101
 * seconds of CPU. With no bound the job sits on `running` until the platform
 * kills the function mid-flight, which writes nothing: the row never reaches
 * `failed`, never reaches the needs-attention tray, and the user is left
 * watching a spinner that outlives the process.
 */
const DEFAULT_EXTRACT_BUDGET_MS = 25_000

export type RunImportInput = {
  db: Db
  store: BlobStore
  llm: LlmClient
  jobId: string
  url: string
  addedBy?: string | null
  /**
   * HTML captured on the phone, for a publisher that blocks our datacenter IP.
   * When present the network is not touched at all.
   */
  suppliedHtml?: string | null
  extractBudgetMs?: number
  /** Injected so tests never touch the network. */
  fetchPage: (url: string) => Promise<FetchedPage>
  /** Injected for the same reason. */
  ingestHeroImage: (input: {
    url: string
    recipeId: string
    store: BlobStore
  }) => Promise<IngestedImage | null>
}

class ExtractionBudgetExceededError extends Error {
  constructor(budgetMs: number) {
    super(`Extraction exceeded its ${budgetMs}ms budget`)
    this.name = 'ExtractionBudgetExceededError'
    Object.setPrototypeOf(this, ExtractionBudgetExceededError.prototype)
  }
}

/**
 * Races `work` against the budget.
 *
 * Honest about what this does and does not buy: `extract()` is synchronous CPU
 * work between its await points (three JSDOM parses and a Readability pass), so
 * the timer cannot preempt it. When the budget expires the returned promise
 * rejects and the job records a real, visible failure — but the event loop
 * stays blocked until the parse finishes, and the abandoned work keeps burning
 * CPU in the background with its result discarded. Genuinely interrupting it
 * needs a worker thread. Converting a silent hang into a recorded failure is
 * the valuable half, and it is the half that costs nothing.
 *
 * A corollary worth knowing before debugging this: the timer only fires when
 * the event loop reaches its timers phase, so if every await inside `extract()`
 * resolves without yielding a macrotask (a stubbed LLM, say) the budget never
 * fires at all. In production the LLM call is real network I/O and always
 * yields.
 */
async function withExtractionBudget<T>(work: () => Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractionBudgetExceededError(budgetMs)), budgetMs)
  })

  try {
    // The timer is armed before `work()` is invoked, because `work()` runs
    // synchronously up to its first await and would otherwise eat part of its
    // own budget before the clock started.
    return await Promise.race([work(), expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Maps a thrown error to the kind that describes how to recover from it. See
 * `FailureKind` in the jobs queries for what each one means to a human staring
 * at the needs-attention tray.
 */
function classify(error: unknown): FailureKind {
  if (error instanceof BlockedError) return 'blocked'
  if (error instanceof FetchFailedError) return 'fetch_failed'
  if (error instanceof NoRecipeFoundError) return 'no_recipe'
  return 'internal'
}

/**
 * The archive key.
 *
 * Derived from the canonical URL, so a re-import of the same recipe overwrites
 * its own archive instead of accumulating a new blob per attempt. It is hashed
 * rather than used literally because a URL is a bad object-store key: it
 * carries a colon and a `//`, and an empty path segment is either rejected or
 * silently rewritten depending on the store. The digest is fixed-length, needs
 * no escaping, and is stable; nothing needs to read the URL back out of the
 * key, because the row that points at the blob also stores `sourceUrl`.
 * The domain prefix is purely so a human browsing the bucket can tell what
 * they are looking at.
 */
function archiveKey(canonicalUrl: string, domain: string): string {
  const digest = createHash('sha256').update(canonicalUrl).digest('hex')
  return `archives/${domain}/${digest}.html.gz`
}

/**
 * Whether the enrichment pass actually landed.
 *
 * `applyEnrichment` swallows its own errors by design — a recipe without parsed
 * quantities is still a usable recipe — so the only signal available here is
 * whether parsed fields arrived. Both structured parsers emit `quantity` and
 * `item` as null unconditionally, so a single non-null value can only have come
 * from the model.
 *
 * Without this flag nothing downstream can tell "this recipe genuinely has no
 * quantities" from "the model was rate-limited that afternoon", and the
 * migration's dry-run report has nothing to report on.
 */
function enrichmentApplied(extracted: ExtractedRecipe): boolean {
  return extracted.ingredients.some((i) => i.quantity !== null || i.item !== null)
}

/**
 * Builds a page record from HTML supplied by the phone. The string is the
 * authoritative copy in this path — there are no original bytes to preserve,
 * because the browser already decoded them — so encoding it as UTF-8 is exact
 * rather than a lossy re-encode, and `utf-8` is the honest thing to record.
 */
function suppliedPage(url: string, html: string): FetchedPage {
  return {
    html,
    bytes: new TextEncoder().encode(html),
    encoding: 'utf-8',
    finalUrl: url,
    status: 200,
  }
}

/**
 * The composition root of the import: the pure extractor, the network, the LLM,
 * blob storage and the database, wired together exactly once.
 *
 * **This function must never throw.** It runs detached, after the API route has
 * already returned 202 to the phone, so nothing is left to catch anything it
 * throws: a rejection becomes an unhandled rejection and the job row sits on
 * `running` forever, invisible to the tray that exists to surface problems.
 * Every failure path ends at `markFailed` with a kind.
 */
export async function runImport(input: RunImportInput): Promise<void> {
  const { db, store, llm, jobId, url } = input
  const budgetMs = input.extractBudgetMs ?? DEFAULT_EXTRACT_BUDGET_MS

  try {
    await markRunning(db, jobId)

    const page = input.suppliedHtml
      ? suppliedPage(url, input.suppliedHtml)
      : await input.fetchPage(url)

    // A redirect means the URL the recipe belongs to is not the one the job
    // recorded, and the canonical form is what dedupes.
    const sourceUrl = page.finalUrl || url
    const canonical = normalizeSourceUrl(sourceUrl)

    // `extract` resolves relative image references against this, so it gets the
    // URL the bytes actually came from rather than the tracking-stripped one:
    // stripping is right for storage and dedupe, but the base for resolving a
    // relative reference should be the document's real address.
    const extracted = await withExtractionBudget(
      () => extract({ url: sourceUrl, html: page.html, llm }),
      budgetMs,
    )

    // Archive the bytes the server actually sent, gzipped — never a re-encode
    // of `page.html`. A re-encode is lossy the moment the decode was wrong, and
    // would bake today's charset bugs permanently into every future
    // re-extraction. `page.encoding` rides along on the recipe so a later pass
    // can tell a declared decode from a guessed one.
    const key = archiveKey(canonical.url, canonical.domain)
    await store.put(key, new Uint8Array(await gzipAsync(page.bytes)), 'application/gzip')

    // Deliberately before `upsertRecipe`: if the blob write fails after the row
    // was written, the recipe would claim an archive that does not exist, and
    // nothing would ever discover that until a re-extraction years from now.
    // The opposite order fails safe — a blob nobody references is inert, costs
    // a few kilobytes, and is overwritten by the next import of the same URL.
    const recipeId = await upsertRecipe(db, {
      extracted,
      sourceUrl: canonical.url,
      sourceDomain: canonical.domain,
      archivedHtmlKey: key,
      sourceEncoding: page.encoding,
      enrichmentApplied: enrichmentApplied(extracted),
      addedBy: input.addedBy ?? null,
    })

    // A failed image must never fail the import: `ingestHeroImage` returns null
    // on any problem, and the recipe is still stored and the job still
    // succeeds. A recipe without a picture is a recipe; a recipe lost because a
    // CDN hiccuped is not.
    if (extracted.heroImageUrl) {
      const image = await input.ingestHeroImage({
        url: extracted.heroImageUrl,
        recipeId,
        store,
      })
      if (image) {
        // Replace rather than append, matching how `upsertRecipe` treats every
        // other child table: a re-import must not leave the recipe with one
        // `source_hero` row per attempt. Only the source hero is touched — a
        // picture the user uploaded is theirs and survives re-extraction.
        await db
          .delete(images)
          .where(and(eq(images.recipeId, recipeId), eq(images.role, 'source_hero')))
        await db.insert(images).values({
          recipeId,
          role: 'source_hero',
          blobKey: image.blobKey,
          thumbKey: image.thumbKey,
          width: image.width,
          height: image.height,
        })
      }
    }

    await markDone(db, jobId, recipeId)
  } catch (error) {
    try {
      await markFailed(db, jobId, classify(error), error)
    } catch {
      // The catch of the catch. If the database is unreachable there is nothing
      // left to record the failure with, and throwing from here would defeat
      // the whole point of the outer catch — the job would stay `running` AND
      // take down the process with an unhandled rejection. Swallowing leaves a
      // stale `running` row for a sweeper to reap, which is the least bad of
      // the options available at this point.
    }
  }
}
