#!/usr/bin/env tsx
/**
 * The one-time Notion migration: 156 recipes out of a shared Notion database
 * and into this app, losing nothing — including the ones whose source URLs
 * have died.
 *
 * Two modes, and the first one is not optional in spirit:
 *
 *   npm run migrate -- --dry-run     classify every row, write nothing, spend nothing
 *   npm run migrate                  do it, resumably
 *
 * The dry run answers "what will happen" before anything is written. It fetches
 * every row, tries every source URL, and recovers every unreachable row from its
 * Notion page body — all with a **no-op LLM client**, so it costs nothing and can
 * be run again after every fix without that being a financial decision. It writes
 * one file (`docs/migration-report.md`) and touches neither the database nor blob
 * storage.
 *
 * The real run replays the ordinary import pipeline (`runImport`) per row, so the
 * migration is not a second implementation of extraction that can drift from the
 * first. Where the source URL is dead, blocked, or absent, the Notion page body
 * becomes the recipe instead.
 *
 * Flags:
 *   --dry-run                classify only; no database, no blob storage, no model
 *   --limit=N                process only the first N rows (a smoke test)
 *   --resume=PATH            resume file location (default .migration-resume.json)
 *   --report=PATH            dry-run report location (default docs/migration-report.md)
 *   --fresh                  ignore an existing resume file and start over
 *   --model-interval=MS      minimum spacing between model calls (default 1200)
 *   --concurrency=N          rows in flight (default 3 dry-run, 2 real)
 *
 * A note on what this file deliberately does NOT import at module scope:
 * `src/lib/db` builds a libsql client the moment it is loaded, from
 * `TURSO_DATABASE_URL`. The dry run must work with no database at all, so every
 * database-, blob- and model-touching module is loaded lazily inside
 * `loadRuntime()`, on the real-run path only.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Client } from '@notionhq/client'

import { extract, NoRecipeFoundError } from '../src/lib/extract/index'
import { applyEnrichment } from '../src/lib/extract/enrich'
import type { LlmClient } from '../src/lib/extract/llm-types'
import type { ExtractedRecipe } from '../src/lib/extract/types'
import { BlockedError, FetchFailedError, fetchPage, type FetchedPage } from '../src/lib/fetch/index'
import { findSourceUrlInBody, fromNotionBody } from '../src/lib/notion/body'
import { createNotionClient, fetchPageBody, fetchRecipeRows } from '../src/lib/notion/client'
import { mapNotionRow, type MigrationInput } from '../src/lib/notion/map'
import type { NotionRecipeBody, NotionRecipeRow } from '../src/lib/notion/types'
import type { BlobStore } from '../src/lib/storage'
import { normalizeSourceUrl } from '../src/lib/url'

/* -------------------------------------------------------------------------- */
/* Tunables                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rows in flight during the dry run. These are 156 requests to other people's
 * servers and we have no relationship with any of them; three at a time is
 * well under anything that looks like abuse.
 */
const DRY_RUN_CONCURRENCY = 3

/**
 * Rows in flight during the real run. Lower than the dry run's, and for a
 * different bottleneck: the dry run is network-bound and the real run is
 * model-bound. Two rows in flight is two imports each making up to two model
 * calls, which is as much parallelism as the throttle below will let through
 * anyway — more would only queue.
 */
const RUN_CONCURRENCY = 2

/**
 * Minimum spacing between model calls, across the whole process.
 *
 * 1200ms is 50 calls a minute, which is the request-per-minute floor of
 * Anthropic's first usage tier. This is the single most important number in
 * this file: a rate-limited burst is the most likely way this migration fails,
 * and it fails *silently* — `applyEnrichment` swallows its own errors by
 * design, so a 429 produces a recipe that stores cleanly, reads fine, and
 * reports `done` with zero tags and every quantity null. Nothing throws.
 * Nobody is told. The only symptom is a filter rail that under-counts, weeks
 * later, with no failed job anywhere to explain it.
 *
 * Spacing is enforced on call *starts* globally rather than per worker, so
 * raising `--concurrency` cannot raise the model call rate.
 */
const DEFAULT_MODEL_INTERVAL_MS = 1200

/** How many times a rate-limited model call is retried before giving up. */
const MODEL_MAX_ATTEMPTS = 6

/** First backoff, doubled each attempt: 2s, 4s, 8s, 16s, 32s. */
const MODEL_BASE_BACKOFF_MS = 2_000
const MODEL_MAX_BACKOFF_MS = 60_000

/**
 * Minimum spacing between Notion page-body fetches, which are additionally
 * serialized (one at a time). Notion's documented limit is roughly three
 * requests per second averaged, and one `fetchPageBody` is one request plus
 * one per nested block level — so spacing whole bodies 400ms apart and never
 * overlapping two of them keeps the average comfortably under the limit even
 * when a page nests.
 */
const NOTION_INTERVAL_MS = 400

const DEFAULT_RESUME_PATH = '.migration-resume.json'
const DEFAULT_REPORT_PATH = 'docs/migration-report.md'

/* -------------------------------------------------------------------------- */
/* Small utilities                                                              */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(message: string): void {
  console.log(`[migrate] ${message}`)
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, stopping early
 * when `shouldStop` returns true.
 *
 * `worker` must not reject — a rejection here would abandon the other workers
 * mid-row and lose whatever they were about to record. Every caller wraps its
 * own body in a try/catch for that reason.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (shouldStop()) return
      const index = next++
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

/**
 * Spaces the *start* of every call by `minIntervalMs`, without serializing
 * them. Slots are claimed synchronously, so two workers asking at the same
 * instant get consecutive slots rather than the same one.
 */
function createSpacingGate(minIntervalMs: number) {
  let nextSlot = 0
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const start = Math.max(now, nextSlot)
    nextSlot = start + minIntervalMs
    if (start > now) await sleep(start - now)
    return fn()
  }
}

/**
 * Like `createSpacingGate`, but also serializes: one call at a time, with a
 * gap of `minIntervalMs` between the end of one and the start of the next.
 * Used for Notion, where a single logical call fans out into several requests.
 */
function createSerialGate(minIntervalMs: number) {
  let chain: Promise<unknown> = Promise.resolve()
  let finishedAt = 0
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      const wait = finishedAt + minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await fn()
      } finally {
        finishedAt = Date.now()
      }
    })
    // Swallow on the chain only; the caller still sees the rejection.
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                          */
/* -------------------------------------------------------------------------- */

export type Options = {
  dryRun: boolean
  fresh: boolean
  limit: number | null
  concurrency: number
  modelIntervalMs: number
  resumePath: string
  reportPath: string
}

const USAGE = `Usage:
  npm run migrate -- --dry-run          classify every row; writes nothing, spends nothing
  npm run migrate                       run the migration (resumable)

Options:
  --dry-run              classify only: no database, no blob storage, no model calls
  --limit=N              process only the first N rows
  --concurrency=N        rows in flight (default ${DRY_RUN_CONCURRENCY} dry-run, ${RUN_CONCURRENCY} real)
  --model-interval=MS    minimum spacing between model calls (default ${DEFAULT_MODEL_INTERVAL_MS})
  --resume=PATH          resume file (default ${DEFAULT_RESUME_PATH})
  --report=PATH          dry-run report (default ${DEFAULT_REPORT_PATH})
  --fresh                ignore an existing resume file and start over
  --help`

function numericFlag(argv: string[], name: string, fallback: number): number {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    fail(`--${name} must be a positive number, got "${raw}".`)
  }
  return value
}

function stringFlag(argv: string[], name: string, fallback: string): string {
  return argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback
}

export function parseArgs(argv: string[]): Options {
  const dryRun = argv.includes('--dry-run')
  return {
    dryRun,
    fresh: argv.includes('--fresh'),
    limit: argv.some((a) => a.startsWith('--limit=')) ? numericFlag(argv, 'limit', 0) : null,
    concurrency: numericFlag(argv, 'concurrency', dryRun ? DRY_RUN_CONCURRENCY : RUN_CONCURRENCY),
    modelIntervalMs: numericFlag(argv, 'model-interval', DEFAULT_MODEL_INTERVAL_MS),
    resumePath: stringFlag(argv, 'resume', DEFAULT_RESUME_PATH),
    reportPath: stringFlag(argv, 'report', DEFAULT_REPORT_PATH),
  }
}

/** Prints a human-readable reason and stops. Never a stack trace. */
function fail(message: string, detail?: string): never {
  console.error(`\n[migrate] ${message}`)
  if (detail) console.error(`\n${detail}`)
  console.error('')
  process.exit(1)
}

/* -------------------------------------------------------------------------- */
/* Environment preflight                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What each variable is and how to get one. Printed instead of the exception
 * the missing variable would otherwise cause three frames deep in a client
 * constructor — the difference between "go and do this" and "go and read a
 * stack trace".
 */
const ENV_HELP: Record<string, string> = {
  NOTION_TOKEN: [
    '  NOTION_TOKEN is the internal-integration token for the one-time migration.',
    '',
    '    1. Create an internal integration at https://www.notion.so/my-integrations',
    '    2. Share the "Library" database with it (Share -> the integration name)',
    '    3. Copy the token into .env.local:  NOTION_TOKEN=ntn_...',
    '',
    '  `npm run migrate` loads .env.local automatically. If you are invoking tsx',
    '  directly, pass --env-file-if-exists=.env.local.',
  ].join('\n'),
  NOTION_DATA_SOURCE_ID: [
    '  NOTION_DATA_SOURCE_ID identifies the "Library" data source. The value for',
    '  this project is recorded in .env.example; copy it into .env.local:',
    '',
    '    NOTION_DATA_SOURCE_ID=a4ac088b-6fea-4de2-bde5-594f328bce9d',
  ].join('\n'),
  TURSO_DATABASE_URL: [
    '  TURSO_DATABASE_URL is the libsql database the recipes are written to.',
    '  It is in .env.local for every other script in this repo (`npm run seed`,',
    '  `npm run unenriched`). The dry run does not need it — if you only want to',
    '  see what the migration would do, run:  npm run migrate -- --dry-run',
  ].join('\n'),
  ANTHROPIC_API_KEY: [
    '  ANTHROPIC_API_KEY is required for the real run and only for the real run.',
    '  Without the model, every imported recipe lands with no parsed quantities',
    '  and no tags — unfilterable, in an app whose entire purpose is filtering —',
    '  so this run refuses to start rather than quietly producing that.',
    '',
    '  To see what the migration would do without spending anything:',
    '    npm run migrate -- --dry-run',
  ].join('\n'),
  BLOB_READ_WRITE_TOKEN: [
    '  BLOB_READ_WRITE_TOKEN is the Vercel Blob token that source archives and',
    '  hero images are written to. It is in .env.local alongside the database URL.',
  ].join('\n'),
}

function requireEnv(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length === 0) return

  const label = missing.length === 1 ? 'variable' : 'variables'
  fail(
    `Cannot start: required environment ${label} not set — ${missing.join(', ')}.`,
    missing.map((name) => `${name}\n${ENV_HELP[name] ?? '  (no help available)'}`).join('\n\n'),
  )
}

/* -------------------------------------------------------------------------- */
/* The decision function                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What to do with a row next.
 *
 * `skip` carries `retryable` beyond the shape the plan sketched, because the
 * two kinds of skip need opposite handling and the resume file has to tell
 * them apart: a `done` job is finished forever, while an `llm_failed` one is
 * a row this run must leave alone and the *next* run must pick up.
 */
export type MigrationAction =
  | { kind: 'import' }
  | { kind: 'notion-body' }
  | { kind: 'skip'; reason: string; retryable: boolean }

/**
 * Given a mapped row and the outcome of an import attempt (or null, meaning
 * nothing has been attempted yet), what happens next. Pure: no network, no
 * database, no clock — this is the runner's entire branching, lifted out so it
 * can be tested without either.
 *
 * The one non-obvious rule is `llm_failed`, and it is the whole reason this is
 * a function rather than a chain of ifs inline. Every other failure means the
 * *page* let us down, and the Notion body is a better copy than nothing. But
 * `llm_failed` means the page was fine and the model was not — falling back to
 * the Notion body there would store a permanently worse copy of a recipe we
 * could have had properly, in exchange for nothing, since the model will be
 * back in an hour. So it is a skip, marked retryable, and the resume file
 * brings it round again on the next run.
 */
export function decideAction(
  input: MigrationInput,
  outcome: { status: string; failureKind: string | null } | null,
): MigrationAction {
  if (!outcome) {
    // Nothing attempted yet. A row with no URL has nothing to import from and
    // goes straight to its Notion body — which may still yield a URL, see
    // `findSourceUrlInBody`, but that is the body path's business.
    return input.sourceUrl ? { kind: 'import' } : { kind: 'notion-body' }
  }

  if (outcome.status === 'done' || outcome.status === 'duplicate') {
    return {
      kind: 'skip',
      reason: `the import finished as ${outcome.status}; nothing further to do`,
      retryable: false,
    }
  }

  if (outcome.status !== 'failed') {
    // `queued` or `running`: the job never reached a conclusion, so nothing is
    // known about the page. Guessing at the Notion body here would overwrite a
    // possibly-fine import with a lossy copy.
    return {
      kind: 'skip',
      reason: `the import job is still "${outcome.status}" and reached no conclusion`,
      retryable: true,
    }
  }

  switch (outcome.failureKind) {
    case 'blocked':
      return { kind: 'notion-body' }
    case 'fetch_failed':
      return { kind: 'notion-body' }
    case 'no_recipe':
      return { kind: 'notion-body' }
    case 'llm_failed':
      return {
        kind: 'skip',
        reason:
          'the model was unavailable; the page itself is fine, so this row is left for a ' +
          'later run rather than downgraded to its Notion body',
        retryable: true,
      }
    case 'internal':
      return {
        kind: 'skip',
        reason: 'the import failed with an internal error; a human should look at the job',
        retryable: true,
      }
    default:
      return {
        kind: 'skip',
        reason: `unrecognized failure kind "${outcome.failureKind}"`,
        retryable: true,
      }
  }
}

/* -------------------------------------------------------------------------- */
/* Model throttling and rate-limit retry                                        */
/* -------------------------------------------------------------------------- */

export class RateLimitExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitExhaustedError'
    Object.setPrototypeOf(this, RateLimitExhaustedError.prototype)
  }
}

/**
 * Whether an error from the model client is a rate limit or an overload —
 * i.e. "wait and try again", not "this request was wrong".
 *
 * Deliberately generous: the SDK surfaces `status` on its own error classes,
 * but a proxy or a gateway in front of it may not, and mistaking a 429 for a
 * permanent failure is how a whole afternoon's worth of recipes lands with no
 * tags. Over-matching costs at most a few seconds of backoff on an error that
 * would have failed anyway.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; statusCode?: unknown; name?: unknown }
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode
  // 429 too many requests; 529 is Anthropic's "overloaded".
  if (status === 429 || status === 529) return true
  if (candidate.name === 'RateLimitError') return true
  const message = error instanceof Error ? error.message : ''
  return /rate.?limit|too many requests|overloaded|\b429\b|\b529\b/i.test(message)
}

/** Exponential backoff with a cap. Pure, so the schedule is testable. */
export function backoffDelayMs(attempt: number, base = MODEL_BASE_BACKOFF_MS): number {
  return Math.min(MODEL_MAX_BACKOFF_MS, base * 2 ** (attempt - 1))
}

export type LlmGate = LlmClient & {
  /** Total successful model calls made. Reported in the summary. */
  readonly calls: number
  /** Rate-limited attempts that were retried. */
  readonly retries: number
  /**
   * Sticky: set when a call gave up after `MODEL_MAX_ATTEMPTS`. The runner
   * checks this after every row and hard-stops.
   *
   * A flag rather than a thrown error because the throw does not survive the
   * journey: `applyEnrichment` catches everything it is given, by design, so
   * an exception raised inside `enrich` is swallowed and the row would store
   * unenriched and report success. The flag is the only signal that outlives
   * that catch.
   */
  readonly exhausted: boolean
  readonly exhaustionDetail: string | null
}

export function createThrottledLlm(
  inner: LlmClient,
  minIntervalMs: number,
  // Injectable only so the retry ladder can be tested in milliseconds instead
  // of the minute the real one takes.
  baseBackoffMs = MODEL_BASE_BACKOFF_MS,
): LlmGate {
  const gate = createSpacingGate(minIntervalMs)
  const state = { calls: 0, retries: 0, exhausted: false, exhaustionDetail: null as string | null }

  async function call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (state.exhausted) {
      // Fail fast once we have given up: every further call would burn the
      // full retry ladder to learn what we already know.
      throw new RateLimitExhaustedError(
        `the model is rate limited and this run has stopped calling it (${state.exhaustionDetail})`,
      )
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await gate(fn)
        state.calls++
        return result
      } catch (error) {
        if (!isRateLimitError(error)) throw error

        if (attempt >= MODEL_MAX_ATTEMPTS) {
          state.exhausted = true
          state.exhaustionDetail = `${label} still rate limited after ${attempt} attempts: ${errorText(error)}`
          throw new RateLimitExhaustedError(state.exhaustionDetail)
        }

        const delay = backoffDelayMs(attempt, baseBackoffMs)
        state.retries++
        log(
          `model rate limited on ${label} (attempt ${attempt}/${MODEL_MAX_ATTEMPTS}); ` +
            `backing off ${Math.round(delay / 1000)}s`,
        )
        await sleep(delay)
      }
    }
  }

  return {
    enrich: (input) => call('enrich', () => inner.enrich(input)),
    extractRecipe: (input) => call('extractRecipe', () => inner.extractRecipe(input)),
    get calls() {
      return state.calls
    },
    get retries() {
      return state.retries
    },
    get exhausted() {
      return state.exhausted
    },
    get exhaustionDetail() {
      return state.exhaustionDetail
    },
  }
}

/**
 * The dry run's model: answers nothing, costs nothing, counts everything.
 *
 * Counting is not decoration — it is how the report estimates the real run's
 * spend without duplicating any of the branching that decides whether a model
 * call happens. Whatever `extract()` and `fromNotionBody()` would have asked
 * the model, this records.
 */
function createCountingNoopLlm() {
  const state = { enrich: 0, extractRecipe: 0 }
  return {
    llm: {
      async enrich() {
        state.enrich++
        return null
      },
      async extractRecipe() {
        state.extractRecipe++
        return null
      },
    } satisfies LlmClient,
    get total() {
      return state.enrich + state.extractRecipe
    },
    get extractCalls() {
      return state.extractRecipe
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Dry run                                                                      */
/* -------------------------------------------------------------------------- */

export type DryRunClass =
  | 'structured'
  | 'needs-llm'
  | 'blocked'
  | 'dead'
  | 'no-link'
  | 'notion-body-only'
  | 'unrecoverable'

export const DRY_RUN_CLASSES: readonly DryRunClass[] = [
  'structured',
  'needs-llm',
  'notion-body-only',
  'no-link',
  'blocked',
  'dead',
  'unrecoverable',
]

export type FetchOutcome = 'structured' | 'unstructured' | 'blocked' | 'fetch-failed'

/**
 * Assigns exactly one class to a row.
 *
 * The seven classes overlap in plain English — a blocked row that its Notion
 * body can rescue is arguably both `blocked` and `notion-body-only` — so the
 * precedence is fixed here, once, and stated in the report:
 *
 *   1. No URL anywhere (neither the `Link` property nor the page body):
 *        the body yields a recipe  -> no-link
 *        the body yields nothing   -> unrecoverable
 *   2. A URL exists and was fetched:
 *        structured data present   -> structured
 *        none                      -> needs-llm
 *   3. A URL exists and was not reachable:
 *        the body yields a recipe  -> notion-body-only
 *        the body yields nothing   -> blocked / dead, per the fetch failure
 *
 * Read it as "what will the real run do with this row": the first four classes
 * end with a recipe in the library, the last three end with a human's attention.
 * The per-fetch-outcome tally in the report gives the plainer reading — how
 * many URLs were refused, how many were dead — without collapsing the two.
 */
export function classifyRow(args: {
  hasUrl: boolean
  fetchOutcome: FetchOutcome | null
  bodyRecovered: boolean
}): DryRunClass {
  if (!args.hasUrl) return args.bodyRecovered ? 'no-link' : 'unrecoverable'
  if (args.fetchOutcome === 'structured') return 'structured'
  if (args.fetchOutcome === 'unstructured') return 'needs-llm'
  if (args.bodyRecovered) return 'notion-body-only'
  return args.fetchOutcome === 'blocked' ? 'blocked' : 'dead'
}

/**
 * The two pieces of I/O the classifier needs, injected rather than imported so
 * the whole dry-run path can be driven from the committed fixtures with no
 * token and no network — the same boundary rule that keeps `map.ts` and
 * `body.ts` testable.
 */
export type DryRunDeps = {
  fetchPage: (url: string) => Promise<FetchedPage>
  fetchBody: (pageId: string) => Promise<NotionRecipeBody>
}

export type DryRunRow = {
  pageId: string
  title: string
  publisher: string
  klass: DryRunClass
  fetchOutcome: FetchOutcome | null
  /** The URL the real run will actually import, body-recovered or not. */
  url: string | null
  /** The URL the row's own `Link` property gave, so the report can show both. */
  rowUrl: string | null
  urlFromBody: boolean
  detail: string
  modelCalls: number
  bodyIngredients: number
  bodySteps: number
  /** Lines the body parser kept as narrative instead of as recipe content. */
  narrative: string[]
}

/**
 * Recovers the paragraphs `fromNotionBody` produced, so the report can show a
 * human what the body parser decided was prose.
 *
 * This is the Task 3 check that the plan carries forward. `looksLikeNarrative`
 * in `src/lib/notion/body.ts` is the one place in the migration where content
 * can vanish silently: a line longer than 12 words, or a 6-word sentence with
 * no leading digit, is dropped from the ingredient list. Both thresholds are
 * biased toward keeping and neither loses anything on the two committed
 * fixtures — but the other 154 bodies have never been looked at, and a long
 * quantityless ingredient written as a sentence ("Enough buttermilk to bring
 * the dough together.") would be discarded with no trace.
 *
 * Deriving the lines from `narrativeHtml` rather than re-implementing the
 * heuristic is deliberate: a second copy of the rule here would drift from the
 * first and then report the wrong thing confidently. Where the body had no
 * recipe headings this list *is* exactly what salvage rejected; where it had
 * headings, it is the preamble prose above them, which a reader can dismiss at
 * a glance.
 */
export function narrativeParagraphs(html: string | null): string[] {
  if (!html) return []
  return [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map((match) =>
      match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim(),
    )
    .filter(Boolean)
}

const QUANTITY_HINT = /[0-9¼½¾⅓⅔⅛⅜⅝⅞]/
const UNIT_HINT =
  /\b(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|ounces?|oz|pounds?|lbs?|grams?|kg|ml|l|liters?|litres?|cloves?|pinch(?:es)?|dash(?:es)?|cans?|packages?|pkgs?|sticks?|quarts?|pints?|gallons?|slices?|sprigs?|bunch(?:es)?|handfuls?|jars?|bottles?|heads?|stalks?)\b/i

/**
 * Flags a narrative line that might really be an ingredient. Not the same rule
 * as `looksLikeNarrative` — that would just restate its own answer — but an
 * independent screen: a "narrative" line carrying a number or a unit is worth
 * a human's eye first.
 *
 * A convenience, explicitly not a filter, and the report says so. The very
 * case this audit exists for — "Enough buttermilk to bring the dough
 * together." — carries neither a number nor a unit, which is why it got
 * discarded in the first place and why the report prints every narrative line
 * rather than only the flagged ones.
 */
export function looksLikeLostIngredient(line: string): boolean {
  return QUANTITY_HINT.test(line) || UNIT_HINT.test(line)
}

/** Whether a fetch outcome means the real run gets its recipe from the web. */
function isReachable(outcome: FetchOutcome | null): boolean {
  return outcome === 'structured' || outcome === 'unstructured'
}

/** Reads a URL the way the real run's import would, and says what it found. */
async function probeUrl(
  url: string,
  deps: DryRunDeps,
  llm: LlmClient,
): Promise<{ fetchOutcome: FetchOutcome; detail: string }> {
  try {
    const page = await deps.fetchPage(url)
    const extracted = await extract({ url: page.finalUrl || url, html: page.html, llm })
    return {
      fetchOutcome: 'structured',
      detail: `${extracted.extractionMethod}, ${extracted.ingredients.length} ingredients, ${extracted.steps.length} steps`,
    }
  } catch (error) {
    if (error instanceof NoRecipeFoundError) {
      return {
        fetchOutcome: 'unstructured',
        detail: 'reachable, but no JSON-LD or microdata — the real run spends a model call here',
      }
    }
    if (error instanceof BlockedError) return { fetchOutcome: 'blocked', detail: `HTTP ${error.status}` }
    if (error instanceof FetchFailedError) return { fetchOutcome: 'fetch-failed', detail: error.reason }
    // Reachable, but extraction itself broke. The real run would record this as
    // an `internal` failure, which needs a human either way.
    return {
      fetchOutcome: 'unstructured',
      detail: `reachable, but extraction threw — ${errorText(error)}`,
    }
  }
}

export async function classifyOneRow(
  row: NotionRecipeRow,
  input: MigrationInput,
  deps: DryRunDeps,
): Promise<DryRunRow> {
  const counter = createCountingNoopLlm()

  const rowUrl = input.sourceUrl
  let url = rowUrl
  let urlFromBody = false
  let body: NotionRecipeBody | null = null
  let detail = ''

  // A row with no `Link` may still carry its URL in the body — the Tamale Pie
  // row does — so the body is consulted *before* concluding the row has no
  // source, exactly as the real runner does.
  if (!url) {
    body = await deps.fetchBody(row.pageId)
    const found = findSourceUrlInBody(body)
    if (found) {
      try {
        url = normalizeSourceUrl(found).url
        urlFromBody = true
      } catch {
        url = null
      }
    }
  }

  let fetchOutcome: FetchOutcome | null = null

  if (url) {
    const probed = await probeUrl(url, deps, counter.llm)
    fetchOutcome = probed.fetchOutcome
    detail = probed.detail
  }

  // The real runner consults the page body for a source URL on *every* failure
  // path, not only when the row had no link to begin with — a blocked or dead
  // link falls through to the body path, which tries a body URL before it
  // salvages anything. The dry run used to consult the body only for a row with
  // no link at all, so a row this report called `notion-body-only` could in
  // fact be imported from a body URL, off a page nobody had looked at. The
  // report is the checkpoint an operator is told to read before spending money;
  // it has to describe the run that will actually happen.
  if (url && !isReachable(fetchOutcome)) {
    body ??= await deps.fetchBody(row.pageId)
    const found = findSourceUrlInBody(body)
    let recovered: string | null = null
    if (found) {
      try {
        recovered = normalizeSourceUrl(found).url
      } catch {
        recovered = null
      }
    }

    if (recovered && recovered !== url) {
      const retry = await probeUrl(recovered, deps, counter.llm)
      if (isReachable(retry.fetchOutcome)) {
        detail = `${detail}; the page body names ${recovered}, which works — ${retry.detail}`
        url = recovered
        urlFromBody = true
        fetchOutcome = retry.fetchOutcome
      } else {
        detail = `${detail}; the page body names ${recovered}, which is no better — ${retry.detail}`
      }
    }
  }

  const reachable = isReachable(fetchOutcome)

  let bodyRecipe: ExtractedRecipe | null = null
  if (!reachable) {
    body ??= await deps.fetchBody(row.pageId)
    bodyRecipe = await fromNotionBody(row, body, counter.llm)
    if (bodyRecipe) {
      // Not for its result — the no-op model returns nothing — but so the call
      // is counted. The real runner enriches every body-recovered recipe, and
      // an estimate that ignored that would understate the spend by one call
      // per rescued row.
      await applyEnrichment(bodyRecipe, counter.llm)
      detail = detail
        ? `${detail}; Notion body yields ${bodyRecipe.ingredients.length} ingredients, ${bodyRecipe.steps.length} steps`
        : `Notion body yields ${bodyRecipe.ingredients.length} ingredients, ${bodyRecipe.steps.length} steps`
    } else {
      detail = detail ? `${detail}; no usable Notion body` : 'no link and no usable Notion body'
    }
  }

  const klass = classifyRow({ hasUrl: url != null, fetchOutcome, bodyRecovered: bodyRecipe != null })

  // The no-op model short-circuits `extract()` before enrichment on an
  // unstructured page: `extractRecipe` returns nothing, so `NoRecipeFoundError`
  // is thrown and `applyEnrichment` never runs. The real run's model answers,
  // so enrichment does run — one more call than was counted here.
  const modelCalls = counter.total + (klass === 'needs-llm' ? 1 : 0)

  return {
    pageId: row.pageId,
    title: row.title ?? '(untitled)',
    publisher: input.publisher ?? input.sourceDomain ?? '(none)',
    klass,
    fetchOutcome,
    url,
    rowUrl,
    urlFromBody,
    detail,
    modelCalls,
    bodyIngredients: bodyRecipe?.ingredients.length ?? 0,
    bodySteps: bodyRecipe?.steps.length ?? 0,
    narrative: narrativeParagraphs(bodyRecipe?.narrativeHtml ?? null),
  }
}

function tally<T extends string>(rows: readonly { key: T }[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>
  for (const row of rows) counts[row.key]++
  return counts
}

export function renderReport(rows: DryRunRow[], meta: { generatedAt: string; elapsedMs: number }): string {
  const counts = tally(
    rows.map((r) => ({ key: r.klass })),
    DRY_RUN_CLASSES,
  )
  const modelCalls = rows.reduce((sum, r) => sum + r.modelCalls, 0)

  const fetchTally = {
    reachable: rows.filter((r) => r.fetchOutcome === 'structured' || r.fetchOutcome === 'unstructured').length,
    blocked: rows.filter((r) => r.fetchOutcome === 'blocked').length,
    failed: rows.filter((r) => r.fetchOutcome === 'fetch-failed').length,
    noUrl: rows.filter((r) => r.url == null).length,
    urlFromBody: rows.filter((r) => r.urlFromBody).length,
  }

  const out: string[] = []
  const push = (...lines: string[]) => out.push(...lines)

  push(
    '# Notion migration — dry run report',
    '',
    `Generated ${meta.generatedAt} in ${(meta.elapsedMs / 1000).toFixed(0)}s. ` +
      `${rows.length} rows.`,
    '',
    'Produced by `npm run migrate -- --dry-run`. Nothing was written to the database',
    'or to blob storage, and no model call was made: every row was classified with a',
    'no-op LLM client, so this report is free to regenerate after any fix.',
    '',
    '## How a row is classified',
    '',
    'Exactly one class per row, first match wins:',
    '',
    '| | condition | class |',
    '| --- | --- | --- |',
    '| 1 | no URL anywhere, Notion body yields a recipe | `no-link` |',
    '| 2 | no URL anywhere, Notion body yields nothing | `unrecoverable` |',
    '| 3 | URL fetched, JSON-LD or microdata found | `structured` |',
    '| 4 | URL fetched, no structured data | `needs-llm` |',
    '| 5 | URL unreachable (and any URL in the body is too), body yields a recipe | `notion-body-only` |',
    '| 6 | URL refused (403/429), no usable body | `blocked` |',
    '| 7 | URL fetch failed, no usable body | `dead` |',
    '',
    '`structured`, `needs-llm`, `notion-body-only` and `no-link` end with a recipe in the',
    'library. `blocked`, `dead` and `unrecoverable` end with a human.',
    '"No URL anywhere" means the `Link` property was empty **and** `findSourceUrlInBody`',
    'found nothing in the page body. "URL unreachable" means the same thing the real run',
    "means by it: the row's own link failed *and* any link the page body named failed too",
    '— see "Rows importing from a URL found in the page body" below.',
    '',
    '## Totals',
    '',
    '| class | rows |',
    '| --- | ---: |',
  )
  for (const klass of DRY_RUN_CLASSES) push(`| \`${klass}\` | ${counts[klass]} |`)
  push(`| **total** | **${rows.length}** |`, '')

  push(
    '### Fetch outcomes, plainly',
    '',
    'The same rows counted by what the network said, without the recoverability',
    'question folded in:',
    '',
    `- reachable: ${fetchTally.reachable}`,
    `- refused (403/429): ${fetchTally.blocked}`,
    `- fetch failed: ${fetchTally.failed}`,
    `- no URL at all: ${fetchTally.noUrl}`,
    `- URL recovered from the page body: ${fetchTally.urlFromBody}`,
    '',
    '## Estimated model calls for the real run',
    '',
    `**${modelCalls}**, counted rather than guessed: the dry run's no-op model records`,
    'every call `extract()` and `fromNotionBody()` actually attempt, plus one enrichment',
    'call per `needs-llm` row (whose enrichment the no-op model short-circuits).',
    '',
    '| class | rows | calls each | calls |',
    '| --- | ---: | --- | ---: |',
  )
  for (const klass of DRY_RUN_CLASSES) {
    const inClass = rows.filter((r) => r.klass === klass)
    if (inClass.length === 0) continue
    const total = inClass.reduce((sum, r) => sum + r.modelCalls, 0)
    const each = [...new Set(inClass.map((r) => r.modelCalls))].sort((a, b) => a - b).join(' or ')
    push(`| \`${klass}\` | ${inClass.length} | ${each} | ${total} |`)
  }
  push(`| **total** | **${rows.length}** | | **${modelCalls}** |`, '')

  // -- Per publisher ---------------------------------------------------------
  push('## By publisher', '', `| publisher | rows | ${DRY_RUN_CLASSES.join(' | ')} |`)
  push(`| --- | ---: | ${DRY_RUN_CLASSES.map(() => '---:').join(' | ')} |`)

  const byPublisher = new Map<string, DryRunRow[]>()
  for (const row of rows) {
    const list = byPublisher.get(row.publisher) ?? []
    list.push(row)
    byPublisher.set(row.publisher, list)
  }
  const publishers = [...byPublisher.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )
  for (const [publisher, list] of publishers) {
    const cells = DRY_RUN_CLASSES.map((k) => {
      const n = list.filter((r) => r.klass === k).length
      return n === 0 ? '·' : String(n)
    })
    push(`| ${publisher} | ${list.length} | ${cells.join(' | ')} |`)
  }
  push('')

  // -- Rows whose source URL did not come from the row -----------------------
  //
  // Separated out because these are the rows most likely to be quietly wrong
  // and least likely to look it: every one of them will be reported as a plain
  // import. `findSourceUrlInBody` takes the first whole-line link above the
  // first heading, and on a Notion clip that can be a "Jump to Recipe" anchor,
  // a photo credit, or the publisher's homepage rather than the article. When
  // it is, the recipe stored carries another page's title and ingredients while
  // wearing this row's rating, status and original date.
  const fromBody = rows.filter((r) => r.urlFromBody)
  push(
    '## Rows importing from a URL found in the page body',
    '',
    `${fromBody.length} rows. The real run consults the page body for a source URL whenever the`,
    "row's own `Link` is empty **or** unreachable, and imports what it finds. That is",
    'usually the right answer — it rescues rows that would otherwise be a clipped copy —',
    'but `findSourceUrlInBody` takes the first whole-line link above the first heading,',
    'which on a Notion clip may be a "Jump to Recipe" anchor, a photo credit, or the',
    "publisher's homepage. Where it is, the recipe imported is a different recipe wearing",
    "this row's rating, status and original save date. Check each of these by eye.",
    '',
  )
  if (fromBody.length === 0) {
    push('_None._', '')
  } else {
    for (const row of fromBody) {
      push(`- **${row.title}** — ${row.publisher} (\`${row.klass}\`)`)
      push(`  - row link: ${row.rowUrl ? `\`${row.rowUrl}\`` : '_empty_'}`)
      push(`  - will import: \`${row.url}\``)
    }
    push('')
  }

  // -- Everything not structured --------------------------------------------
  const notStructured = rows.filter((r) => r.klass !== 'structured')
  push(
    '## Everything that is not `structured`',
    '',
    `${notStructured.length} of ${rows.length} rows. This is the list to read before running`,
    'the migration for real.',
    '',
  )
  for (const klass of DRY_RUN_CLASSES) {
    if (klass === 'structured') continue
    const inClass = notStructured.filter((r) => r.klass === klass)
    if (inClass.length === 0) continue
    push(`### \`${klass}\` (${inClass.length})`, '')
    for (const row of inClass) {
      push(`- **${row.title}** — ${row.publisher}`)
      push(`  - ${row.url ? `\`${row.url}\`${row.urlFromBody ? ' (recovered from the page body)' : ''}` : '_no source URL_'}`)
      push(`  - ${row.detail}`)
    }
    push('')
  }

  // -- The salvage-narrative audit ------------------------------------------
  const bodyRows = rows.filter((r) => r.klass === 'notion-body-only' || r.klass === 'no-link')
  const withNarrative = bodyRows.filter((r) => r.narrative.length > 0)
  const flagged = withNarrative.flatMap((r) =>
    r.narrative.filter(looksLikeLostIngredient).map((line) => ({ title: r.title, line })),
  )

  push(
    '## Lines the body parser kept as narrative',
    '',
    'The one place this migration can lose data silently. `looksLikeNarrative` in',
    '`src/lib/notion/body.ts` drops a line from the ingredient list when it runs past',
    '12 words, or when it ends in terminal punctuation with 6 or more words and no',
    'leading digit. Both thresholds lean toward keeping, and neither loses anything on',
    'the two committed fixtures — but the other bodies have never been looked at, and a',
    'long quantityless ingredient written as a sentence would be discarded with no trace.',
    '',
    'Every line below was set aside as prose on a row that will be recovered from its',
    'Notion body. Where the body had no recipe headings these are exactly what salvage',
    'rejected; where it had headings they are the preamble above them, which reads as',
    'prose at a glance. Lines marked **REVIEW** carry a number or a unit word — an',
    'independent screen, not a restatement of the rule above.',
    '',
    '**Read the whole list, not just the flagged lines.** The screen is a convenience',
    'and cannot catch the case this audit exists for: "Enough buttermilk to bring the',
    'dough together." has neither a number nor a unit, which is exactly why it was',
    'discarded and exactly why it needs a human.',
    '',
    `${bodyRows.length} body-recovered rows, ${withNarrative.length} with narrative lines, ${flagged.length} flagged for review.`,
    '',
  )

  if (flagged.length > 0) {
    push('### Flagged', '')
    for (const item of flagged) push(`- **REVIEW** _${item.title}_ — ${item.line}`)
    push('')
  }

  if (withNarrative.length > 0) {
    push('### All narrative lines, by row', '')
    for (const row of withNarrative) {
      push(`**${row.title}** (${row.bodyIngredients} ingredients, ${row.bodySteps} steps)`, '')
      for (const line of row.narrative) {
        push(`- ${looksLikeLostIngredient(line) ? '**REVIEW** ' : ''}${line}`)
      }
      push('')
    }
  }

  push(
    '## What the real run will do',
    '',
    `- import ${counts.structured + counts['needs-llm']} rows through the ordinary pipeline`,
    `- recover ${counts['notion-body-only'] + counts['no-link']} rows from their Notion page body, then enrich each one`,
    `- leave ${counts.blocked + counts.dead + counts.unrecoverable} rows for a human`,
    `- make roughly ${modelCalls} model calls`,
    '',
    'Run it with `npm run migrate`. It writes a resume file after every row, so a run',
    'that stops halfway can be restarted without re-importing or re-paying for what',
    'already succeeded.',
    '',
  )

  return out.join('\n')
}

async function runDryRun(opts: Options, notion: Client, rows: NotionRecipeRow[]): Promise<void> {
  const notionGate = createSerialGate(NOTION_INTERVAL_MS)
  const deps: DryRunDeps = {
    fetchPage,
    fetchBody: (pageId) => notionGate(() => fetchPageBody(notion, pageId)),
  }
  const started = Date.now()
  const results: DryRunRow[] = []
  let done = 0

  log(`dry run: classifying ${rows.length} rows, ${opts.concurrency} at a time, no-op model`)

  await forEachWithConcurrency(rows, opts.concurrency, async (row) => {
    const input = mapNotionRow(row)
    let result: DryRunRow
    try {
      result = await classifyOneRow(row, input, deps)
    } catch (error) {
      // Classification itself broke — a Notion outage, a mapping bug. The row
      // still has to appear in the report; an unexplained gap between 156 and
      // the total is exactly the failure this report exists to prevent.
      result = {
        pageId: row.pageId,
        title: row.title ?? '(untitled)',
        publisher: input.publisher ?? input.sourceDomain ?? '(none)',
        klass: 'unrecoverable',
        fetchOutcome: null,
        url: input.sourceUrl,
        rowUrl: input.sourceUrl,
        urlFromBody: false,
        detail: `could not be classified — ${errorText(error)}`,
        modelCalls: 0,
        bodyIngredients: 0,
        bodySteps: 0,
        narrative: [],
      }
    }
    results.push(result)
    done++
    log(`${String(done).padStart(3)}/${rows.length}  ${result.klass.padEnd(16)} ${result.title}`)
  })

  // Report in the order the rows came out of Notion, not the order the network
  // happened to answer in, so two runs of the same library diff cleanly.
  const order = new Map(rows.map((row, index) => [row.pageId, index]))
  results.sort((a, b) => (order.get(a.pageId) ?? 0) - (order.get(b.pageId) ?? 0))

  const report = renderReport(results, {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  })

  await mkdir(path.dirname(path.resolve(opts.reportPath)), { recursive: true })
  await writeFile(opts.reportPath, report, 'utf-8')

  console.log(`\n${report}`)
  log(`report written to ${opts.reportPath}`)
}

/* -------------------------------------------------------------------------- */
/* Resume file                                                                  */
/* -------------------------------------------------------------------------- */

const RESUME_VERSION = 1

export type RowResult = {
  pageId: string
  title: string
  outcome: 'imported' | 'duplicate' | 'body-recovered' | 'unrecoverable' | 'skipped'
  /** Which path produced it, for the summary. */
  via: 'import' | 'body-url' | 'notion-body' | null
  recipeId: string | null
  /** The URL the recipe was actually stored against. */
  sourceUrl: string | null
  /**
   * The URL the row's own `Link` property gave, before the body was consulted.
   *
   * Recorded on every row, not only the interesting ones, so that a `via:
   * 'body-url'` result carries *both* URLs — the one the operator would expect
   * and the one the body supplied — into the summary and into the resume file.
   * `findSourceUrlInBody` takes the first whole-line link above the first
   * heading, which for a Notion clip is as likely to be a "Jump to Recipe"
   * anchor, a photo credit, or the publisher's homepage as the article; the
   * recipe then stored carries another page's title and ingredients wearing
   * this row's rating, status and date. That is a handful of rows a human can
   * check in a minute — but only if something tells them which rows.
   */
  rowSourceUrl: string | null
  reason: string | null
  at: string
}

type ResumeFile = {
  version: number
  dataSourceId: string
  startedAt: string
  updatedAt: string
  rows: Record<string, RowResult>
}

/**
 * Outcomes that a resumed run will not do again.
 *
 * `skipped` is deliberately absent: a skip is a row this run could not finish
 * but a later one can — an `llm_failed` import, a job that never concluded —
 * and re-attempting it is the entire reason the resume file records it at all.
 */
const TERMINAL_OUTCOMES: ReadonlySet<RowResult['outcome']> = new Set([
  'imported',
  'duplicate',
  'body-recovered',
  'unrecoverable',
])

export function isTerminal(result: RowResult | undefined): boolean {
  return result != null && TERMINAL_OUTCOMES.has(result.outcome)
}

/**
 * Reads the resume file, or refuses to run.
 *
 * Refusing is the point. Re-running a URL-backed row costs nothing — the
 * duplicate check inside `runImport` short-circuits before extraction, so no
 * model call is made — but a *body-recovered* row with no source URL has
 * nothing to dedupe on, and re-running it inserts a second copy of a recipe
 * that exists nowhere else. Silently starting over because a file did not
 * parse would do exactly that, invisibly, to precisely the recipes that matter
 * most. So a damaged file is moved aside and the operator is told, rather than
 * ignored.
 */
export type ResumeParseResult =
  | { ok: true; file: ResumeFile }
  | { ok: false; why: string }

/**
 * Validates a resume file's contents. Pure, so every way a resume file can be
 * wrong is testable without a filesystem — and every one of them has to end in
 * a refusal rather than a silent fresh start, so they are worth testing.
 */
export function parseResumeFile(raw: string, dataSourceId: string): ResumeParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, why: `it is not valid JSON (${errorText(error)})` }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, why: 'it is not a JSON object' }
  }
  const file = parsed as Partial<ResumeFile>

  if (file.version !== RESUME_VERSION) {
    return {
      ok: false,
      why: `it is version ${String(file.version)}, and this script writes version ${RESUME_VERSION}`,
    }
  }
  if (!file.rows || typeof file.rows !== 'object' || Array.isArray(file.rows)) {
    return { ok: false, why: 'it has no `rows` object' }
  }
  if (file.dataSourceId && file.dataSourceId !== dataSourceId) {
    // A resume file from a different Notion database says nothing about this
    // one, and reading it as if it did would skip rows that were never touched.
    return {
      ok: false,
      why: `it was written for data source ${file.dataSourceId}, and this run targets ${dataSourceId}`,
    }
  }

  return {
    ok: true,
    file: {
      version: RESUME_VERSION,
      dataSourceId,
      startedAt: file.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rows: file.rows as Record<string, RowResult>,
    },
  }
}

async function loadResume(opts: Options, dataSourceId: string): Promise<ResumeFile> {
  const fresh = (): ResumeFile => ({
    version: RESUME_VERSION,
    dataSourceId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rows: {},
  })

  if (opts.fresh || !existsSync(opts.resumePath)) {
    if (opts.fresh && existsSync(opts.resumePath)) {
      log(`--fresh: ignoring the existing resume file at ${opts.resumePath}`)
      log('rows already recovered from a Notion body with no source URL may be duplicated')
    }
    return fresh()
  }

  let raw: string
  try {
    raw = await readFile(opts.resumePath, 'utf-8')
  } catch (error) {
    fail(`Cannot read the resume file at ${opts.resumePath}: ${errorText(error)}`)
  }

  const result = parseResumeFile(raw, dataSourceId)

  if (!result.ok) {
    const moved = `${opts.resumePath}.corrupt-${Date.now()}.json`
    try {
      await rename(opts.resumePath, moved)
    } catch {
      // If it cannot even be moved, the message below still tells the operator
      // what to do; nothing here is worth failing differently over.
    }
    fail(
      `The resume file at ${opts.resumePath} is unusable: ${result.why}`,
      [
        `  It has been moved to ${moved} so nothing was lost.`,
        '',
        '  This run stopped instead of starting over, on purpose. Re-importing a row',
        '  that has a source URL is free — the duplicate check short-circuits before',
        '  extraction — but a recipe recovered from a Notion body with no URL has',
        '  nothing to dedupe against, and starting over would insert a second copy of',
        '  exactly the recipes that exist nowhere else.',
        '',
        '  Either:',
        `    - repair the moved file and put it back at ${opts.resumePath}, or`,
        '    - run `npm run migrate -- --fresh` if you are certain the database has',
        '      no body-recovered recipes from a previous run.',
      ].join('\n'),
    )
  }

  const finished = Object.values(result.file.rows).filter(isTerminal).length
  log(
    `resuming from ${opts.resumePath}: ${finished} rows already finished, ` +
      `${Object.keys(result.file.rows).length} recorded`,
  )
  return result.file
}

/**
 * Writes the resume file after every row, via a temp file and a rename, so an
 * interrupt during the write cannot leave a half-written file behind — which
 * would trip the refusal above on the next run for no reason.
 *
 * Serialized through a gate because two workers finish rows concurrently and
 * two interleaved writes of the same file is how a resume file gets corrupted
 * by the very code meant to protect it.
 */
function createResumeWriter(resumePath: string, file: ResumeFile) {
  const gate = createSerialGate(0)
  return (result: RowResult) =>
    gate(async () => {
      file.rows[result.pageId] = result
      file.updatedAt = new Date().toISOString()
      const tmp = `${resumePath}.tmp`
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
      await rename(tmp, resumePath)
    })
}

/* -------------------------------------------------------------------------- */
/* The real run                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every database-, blob- and model-touching module, loaded on the real-run
 * path only. See the note at the top of the file: importing `src/lib/db` at
 * module scope builds a libsql client from `TURSO_DATABASE_URL`, which the dry
 * run has no business requiring.
 */
async function loadRuntime() {
  const [dbModule, jobsModule, recipesModule, importModule, storeModule, imagesModule, llmModule, schemaModule, drizzle] =
    await Promise.all([
      import('../src/lib/db'),
      import('../src/lib/db/queries/jobs'),
      import('../src/lib/db/queries/recipes'),
      import('../src/lib/import/run-import'),
      import('../src/lib/storage/vercel-blob'),
      import('../src/lib/images/index'),
      import('../src/lib/llm/anthropic-client'),
      import('../src/lib/db/schema'),
      import('drizzle-orm'),
    ])

  return {
    db: dbModule.db,
    createJob: jobsModule.createJob,
    getJob: jobsModule.getJob,
    upsertRecipe: recipesModule.upsertRecipe,
    // Read by the body path before it writes, to refuse a downgrade. See
    // `refuseBodyDowngrade`.
    findBySourceUrl: recipesModule.findBySourceUrl,
    applyNotionMetadata: recipesModule.applyNotionMetadata,
    runImport: importModule.runImport,
    store: storeModule.createVercelBlobStore(),
    ingestHeroImage: imagesModule.ingestHeroImage,
    anthropic: llmModule.createAnthropicClient(),
    schema: schemaModule,
    eq: drizzle.eq,
    and: drizzle.and,
    // Part of the runtime rather than reached for directly, so `processRow`
    // has exactly one seam and a test can drive the whole composition — every
    // module in this repo wired together — with no network. This is the only
    // function in the file that touches other people's servers on the real
    // run, and it was the reason none of what follows had a test.
    fetchPage,
  }
}

/**
 * Everything the real run composes, in one object.
 *
 * Exported as a type so `tests/notion/migrate.test.ts` can assemble the same
 * shape around `createTestDb()` with a fake model, a memory blob store and a
 * fake network. `processRow`, `attemptImport`, `applyRowMetadata` and the body
 * path are where every module in this repo actually meets, and until they were
 * reachable from a test the only coverage here was of the pure helpers above.
 */
/**
 * The two credentials the real run cannot survive without, checked once,
 * before any row is touched.
 *
 * This exists because both of them have already failed here in exactly the
 * way that is most expensive to discover late:
 *
 *   - A Blob store created with `--access private` rejects every write this
 *     app makes, because hero images are served straight from their blob URL
 *     and so must be public. The rejection arrives *inside* `runImport`,
 *     which correctly converts it to a per-job `internal` failure — so the
 *     run does not stop, it just fails all 156 rows one at a time, each with
 *     a generic reason, over half an hour.
 *
 *   - An `ANTHROPIC_API_KEY` that is absent, truncated, or revoked does not
 *     fail loudly at all. `applyEnrichment` swallows its own errors by design
 *     (see the comment on `MODEL_INTERVAL_MS`), so every row still stores,
 *     still reports success, and still ends up with zero tags and no parsed
 *     quantities. The migration looks like it worked. The filter rail — the
 *     entire reason this app exists — is quietly empty.
 *
 * One tiny write and one small model call is a few cents and about two
 * seconds, against a failure mode measured in hours and re-runs.
 *
 * Only *authentication* failures from the model are fatal. A 429 here means
 * the account is rate limited this second, which the throttle is built to
 * ride out; aborting the whole migration over it would be wrong.
 */
export async function preflight(deps: {
  /**
   * Null when the caller writes no blobs at all — `--enrich-only` re-runs the
   * model against recipes already in the database and touches neither storage
   * nor the network. Probing a store it will never use would turn a missing
   * blob token into a refusal to do work that does not need one.
   */
  store: BlobStore | null
  llm: LlmClient
  log: (message: string) => void
}): Promise<void> {
  if (!deps.store) deps.log('preflight: blob storage not needed')
  else {
  const key = 'preflight/write-check.txt'
  try {
    await deps.store.put(key, new TextEncoder().encode('ok'), 'text/plain')
    await deps.store.delete(key)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/private access|private store/i.test(message)) {
      throw new Error(
        'The Blob store is configured for private access, but this app serves hero ' +
          'images directly from their blob URL and needs a public store.\n' +
          '  A store\'s access mode is fixed when it is created, so make a new one:\n' +
          '    vercel blob create-store sifted --access public\n' +
          '  then replace BLOB_READ_WRITE_TOKEN in .env.local with the new store\'s token.\n' +
          `  (underlying error: ${message})`,
      )
    }
    throw new Error(
      `Blob storage is not usable, so no recipe could be archived or given an image.\n` +
        `  Check BLOB_READ_WRITE_TOKEN in .env.local.\n` +
        `  (underlying error: ${message})`,
    )
  }
  deps.log('preflight: blob storage OK')
  }

  try {
    await deps.llm.enrich({
      title: 'Preflight Check',
      ingredientLines: ['1 cup water'],
      rawTags: [],
    })
    deps.log('preflight: model OK')
  } catch (error) {
    const status = (error as { status?: number } | null)?.status
    if (status === 401 || status === 403) {
      throw new Error(
        'The Anthropic API key was rejected. Every recipe would still import and ' +
          'still report success, but with no tags and no parsed quantities — so this ' +
          'stops now rather than silently migrating an unfilterable library.\n' +
          '  Set a full ANTHROPIC_API_KEY in .env.local (a real key is ~100 characters; ' +
          'a truncated paste is the usual cause).\n' +
          `  (underlying error: ${errorText(error)})`,
      )
    }
    deps.log(
      `preflight: model call failed but not on authentication (${errorText(error)}) — ` +
        'continuing, since the throttle is built to ride out a rate limit',
    )
  }
}

export type Runtime = Awaited<ReturnType<typeof loadRuntime>>

/**
 * Whether the enrichment pass landed, judged the only way available: both
 * structured parsers and `fromNotionBody` emit `quantity` and `item` as null
 * unconditionally, so a single non-null value can only have come from the
 * model. Mirrors the identical check inside `runImport`, which is private to
 * that module; the body-recovery path here does its own enrichment and so
 * needs its own answer.
 */
function enrichmentApplied(recipe: { ingredients: { quantity: number | null; item: string | null }[] }): boolean {
  return recipe.ingredients.some((i) => i.quantity !== null || i.item !== null)
}

type ImportAttempt = {
  recipeId: string | null
  outcome: { status: string; failureKind: string | null } | null
}

async function attemptImport(rt: Runtime, url: string, llm: LlmClient): Promise<ImportAttempt> {
  const jobId = await rt.createJob(rt.db, url, null)
  await rt.runImport({
    db: rt.db,
    store: rt.store,
    llm,
    jobId,
    url,
    fetchPage: rt.fetchPage,
    ingestHeroImage: rt.ingestHeroImage,
  })

  const job = await rt.getJob(rt.db, jobId)
  // `null` means "not attempted" to `decideAction`, which is the opposite of
  // what a vanished job row means, so say something it can classify: an
  // unrecognized status becomes a retryable skip rather than a second attempt.
  if (!job) return { recipeId: null, outcome: { status: 'missing', failureKind: null } }

  const outcome = { status: job.status as string, failureKind: (job.failureKind as string | null) ?? null }
  const succeeded = job.status === 'done' || job.status === 'duplicate'
  return { recipeId: succeeded ? job.recipeId : null, outcome }
}

/**
 * Applies the metadata that only Notion has — rating, cooking status, the
 * original tags — and the original save date.
 *
 * The date is written here rather than through `upsertRecipe` because
 * `runImport` owns that call and does not take one. A migrated 2019 recipe
 * that reads as migrated-today flattens seven years of history into a single
 * afternoon, which is most of what a library *is*.
 *
 * Only ever moved *earlier*: when two Notion rows point at the same canonical
 * URL the second one lands as a `duplicate` on a recipe the first one already
 * created, and the honest answer to "when did I save this" is the first time,
 * not the second.
 */
async function applyRowMetadata(
  rt: Runtime,
  recipeId: string,
  input: MigrationInput,
): Promise<void> {
  await rt.applyNotionMetadata(rt.db, recipeId, {
    rating: input.rating,
    status: input.status,
    tags: input.tags,
  })

  const [existing] = await rt.db
    .select({ createdAt: rt.schema.recipes.createdAt })
    .from(rt.schema.recipes)
    .where(rt.eq(rt.schema.recipes.id, recipeId))

  if (existing && existing.createdAt > input.createdAt) {
    await rt.db
      .update(rt.schema.recipes)
      .set({ createdAt: input.createdAt })
      .where(rt.eq(rt.schema.recipes.id, recipeId))
  }
}

/**
 * A hero image already downloaded and transcoded, waiting only for a recipe id
 * to be written under.
 */
type CapturedHeroImage = {
  blobKey: string
  thumbKey: string
  width: number
  height: number
  writes: { key: string; data: Uint8Array; contentType: string }[]
}

/**
 * The placeholder recipe id the capture below hands to `ingestHeroImage`, and
 * then substitutes out of the keys it produced. A literal that cannot collide
 * with a real cuid2 (which is lower-case alphanumeric, no hyphens).
 */
const HERO_CAPTURE_ID = 'pending-recipe-id'

/**
 * The markdown a Notion body writes a hero image as.
 *
 * A deliberate copy of `IMAGE_ONLY_RE` in `src/lib/notion/body.ts`, which is
 * private to that module. Drift is harmless here and that is the point: this
 * scan only decides how *early* the picture is captured, and anything it misses
 * is still ingested from `recipe.heroImageUrl` after the write, exactly as
 * before. It is not a second answer to "what is the hero image".
 */
const BODY_IMAGE_RE = /^!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)$/

function findBodyHeroImageUrl(markdown: string): string | null {
  for (const raw of markdown.split('\n')) {
    const match = raw.trim().match(BODY_IMAGE_RE)
    if (match) return match[1]
  }
  return null
}

/**
 * Downloads and transcodes the hero image a Notion body points at, the instant
 * the body arrives — before anything throttled runs.
 *
 * Notion's file URLs are signed with `X-Amz-Expires=300`. Five minutes, not the
 * hour an earlier version of this comment claimed, and the difference decides
 * whether this works. Between `fetchPageBody` and the recipe row landing sit a
 * whole import attempt against a URL recovered from the body and up to two
 * model calls, every one of them behind a throttle that can burn a
 * 2/4/8/16/32-second backoff ladder. Five minutes is easy to lose there, and
 * losing it costs the recipe its only picture with nothing anywhere to say so:
 * the ingest returns null on any failure, on purpose, because a recipe without
 * a picture is still a recipe.
 *
 * So the bytes are fetched and transcoded here, while the signature is
 * certainly still good, and only the two `put`s are held back — `ingestHeroImage`
 * keys its blobs by recipe id and there is no recipe yet. The capture store
 * records what it was asked to write; `storeCapturedHeroImage` replays it under
 * the real id once `upsertRecipe` has produced one, so the blobs still live
 * under `recipes/<id>/` and nothing downstream can tell the difference.
 *
 * The cost is one wasted download on the rows where the body path does not end
 * in a write after all (a recovered URL that imports cleanly, a body that holds
 * no recipe). One image is a cheap price for the ones that do.
 *
 * Never throws: a picture must not fail a row.
 */
async function captureBodyHeroImage(rt: Runtime, url: string): Promise<CapturedHeroImage | null> {
  const writes: CapturedHeroImage['writes'] = []
  const captureStore: BlobStore = {
    async put(key, data, contentType) {
      // Copied, matching the real store, so a later mutation of the buffer
      // cannot rewrite what we are holding.
      const copy = data.slice()
      writes.push({ key, data: copy, contentType })
      return { key, url: `pending://${key}`, size: copy.byteLength }
    },
    async get() {
      return null
    },
    async delete() {},
  }

  try {
    const image = await rt.ingestHeroImage({ url, recipeId: HERO_CAPTURE_ID, store: captureStore })
    if (!image) return null
    return { ...image, writes }
  } catch (error) {
    log(`  hero image from the Notion body could not be fetched: ${errorText(error)}`)
    return null
  }
}

/**
 * Writes a captured hero image out under the recipe that now exists.
 *
 * The placeholder substitution is a plain string replace over keys
 * `ingestHeroImage` built itself. Should it ever stop embedding the recipe id
 * in them the replace is a no-op — the blobs and the row still agree with each
 * other, they just sit under a different prefix — so this cannot corrupt
 * anything, only misfile it.
 *
 * Wrapped so it can never fail the row, for the same reason as the capture.
 */
async function storeCapturedHeroImage(
  rt: Runtime,
  recipeId: string,
  captured: CapturedHeroImage,
): Promise<void> {
  const rekey = (key: string) => key.split(HERO_CAPTURE_ID).join(recipeId)
  try {
    for (const write of captured.writes) {
      await rt.store.put(rekey(write.key), write.data, write.contentType)
    }
    // Replace rather than append, matching how `upsertRecipe` treats every
    // other child table: a resumed run must not leave one `source_hero` row per
    // attempt.
    await rt.db
      .delete(rt.schema.images)
      .where(
        rt.and(
          rt.eq(rt.schema.images.recipeId, recipeId),
          rt.eq(rt.schema.images.role, 'source_hero'),
        ),
      )
    await rt.db.insert(rt.schema.images).values({
      recipeId,
      role: 'source_hero',
      blobKey: rekey(captured.blobKey),
      thumbKey: rekey(captured.thumbKey),
      width: captured.width,
      height: captured.height,
    })
  } catch (error) {
    log(`  hero image from the Notion body could not be stored: ${errorText(error)}`)
  }
}

/**
 * Which rule refused a body-path write, and what to tell the operator.
 *
 * Two rules, deliberately distinguishable in the summary: they mean different
 * things and they imply different next steps. `enrichment-regression` is
 * temporary — the model will be back and a later run finishes the row.
 * `clipping-over-extraction` is permanent — no re-run of this migration will
 * ever be allowed to make that write, and that is the correct answer.
 */
type BodyWriteRefusal = {
  rule: 'clipping-over-extraction' | 'enrichment-regression'
  reason: string
}

/**
 * Whether writing a Notion body copy over whatever already lives at
 * `sourceUrl` would destroy something better, and if so, why.
 *
 * The path this protects exists because `runImport` fetches *before* it
 * dedupes. When two Notion rows share a canonical URL and the second one is
 * refused by the publisher, the 403 throws first, `decideAction` routes the row
 * to `notion-body`, and the body path calls `upsertRecipe` directly. That finds
 * the first row's recipe by `sourceUrl`, updates it in place, and replaces its
 * children wholesale — on the same recipe id, with no error anywhere.
 *
 * Rule 1, `clipping-over-extraction`: a Notion body may never replace a recipe
 * that was extracted from the page itself.
 *
 * A Notion body is a *clipping* — a lossy, second-hand rendering that someone's
 * web clipper produced years ago, sometimes hand-retyped since. A JSON-LD or
 * microdata extraction is the publisher's own structured data, read off the
 * live page. When we hold both for the same canonical URL the extraction is
 * better essentially by construction, and enrichment status is beside the
 * point: an enriched clipping is still a clipping. Checked first because when
 * it fires, rule 2's advice ("try again when the model is back") would be a
 * lie — a later run refuses this write too, forever, on purpose.
 *
 * Rule 2, `enrichment-regression`: `EnrichmentRegressionError`'s own condition
 * out of `src/lib/import/run-import.ts`, applied to the one path that never
 * reaches it. It catches the degraded case rule 1 does not cover — a body copy
 * landing on top of an *earlier body copy* that did get enriched, where the
 * model was unavailable this time round. Like the original it only fires when
 * the stored recipe *has* enrichment: a first import that landed unenriched is
 * not worth protecting from a better copy.
 *
 * What neither rule does is refuse to *create*. A canonical URL with no recipe
 * behind it writes normally, and a body copy is still free to overwrite an
 * existing `notion` extraction — re-running the migration after improving
 * `fromNotionBody` has to be able to improve exactly those rows, which is the
 * whole point of the parser being improvable.
 */
async function refuseBodyDowngrade(
  rt: Runtime,
  sourceUrl: string | null,
  applied: boolean,
): Promise<BodyWriteRefusal | null> {
  if (!sourceUrl) return null

  const existing = await rt.findBySourceUrl(rt.db, sourceUrl)
  if (!existing) return null

  if (existing.extractionMethod !== 'notion') {
    return {
      rule: 'clipping-over-extraction',
      reason:
        `${sourceUrl} already holds a recipe read from the page itself ` +
        `(${existing.extractionMethod}), and a Notion body is a clipping of that page — ` +
        'lossy, second-hand, and not an improvement on the publisher\'s own data even when ' +
        'it enriches. The existing recipe was preserved and nothing was overwritten',
    }
  }

  if (!applied && existing.enrichmentApplied) {
    return {
      rule: 'enrichment-regression',
      reason:
        `the Notion body copy is not enriched and ${sourceUrl} already holds an enriched ` +
        'recipe; the existing recipe was preserved and nothing was overwritten',
    }
  }

  return null
}

/**
 * One Notion row, end to end.
 *
 * Exported for `tests/notion/migrate.test.ts`. This function is the
 * composition root of the migration — the Notion mapping, the import pipeline,
 * the body salvage, enrichment, the recipe write, the metadata pass and the
 * image ingest all meet here and nowhere else — and it had no test at all until
 * the seams below existed. Every one of them (`rt.fetchPage`, `rt.runImport`,
 * `llm`, `fetchBody`) is injected rather than reached for so the whole path
 * runs against `createTestDb()` with no network, no model, and no blob store.
 */
export async function processRow(
  row: NotionRecipeRow,
  rt: Runtime,
  llm: LlmClient,
  fetchBody: (pageId: string) => Promise<NotionRecipeBody>,
): Promise<RowResult> {
  const input = mapNotionRow(row)
  const title = row.title ?? '(untitled)'
  const now = () => new Date().toISOString()
  const rowSourceUrl = input.sourceUrl

  let action = decideAction(input, null)

  if (action.kind === 'import' && input.sourceUrl) {
    const attempt = await attemptImport(rt, input.sourceUrl, llm)
    if (attempt.recipeId) {
      await applyRowMetadata(rt, attempt.recipeId, input)
      return {
        pageId: row.pageId,
        title,
        outcome: attempt.outcome?.status === 'duplicate' ? 'duplicate' : 'imported',
        via: 'import',
        recipeId: attempt.recipeId,
        sourceUrl: input.sourceUrl,
        rowSourceUrl,
        reason: null,
        at: now(),
      }
    }
    action = decideAction(input, attempt.outcome)
  }

  if (action.kind === 'skip') {
    return {
      pageId: row.pageId,
      title,
      outcome: 'skipped',
      via: null,
      recipeId: null,
      sourceUrl: input.sourceUrl,
      rowSourceUrl,
      reason: action.reason,
      at: now(),
    }
  }

  // -- The Notion body path --------------------------------------------------
  const body = await fetchBody(row.pageId)

  // The picture first, and before anything throttled. The signature on a Notion
  // file URL is good for five minutes; everything below this line can spend
  // longer than that on backoff alone. See `captureBodyHeroImage`.
  const bodyHeroUrl = findBodyHeroImageUrl(body.markdown ?? '')
  const captured = bodyHeroUrl ? await captureBodyHeroImage(rt, bodyHeroUrl) : null

  // Before converting the body, check whether it names a source URL the `Link`
  // property was missing. The Tamale Pie row has exactly that: an empty `Link`
  // and its URL in the first line of the body. A row that looked unrecoverable
  // is often importable properly, which beats a clipped copy every time.
  const inBody = findSourceUrlInBody(body)
  let recoveredUrl: string | null = null
  if (inBody) {
    try {
      recoveredUrl = normalizeSourceUrl(inBody).url
    } catch {
      recoveredUrl = null
    }
  }

  if (recoveredUrl && recoveredUrl !== input.sourceUrl) {
    log(`  ${title}: trying a source URL found in the page body — ${recoveredUrl}`)
    const attempt = await attemptImport(rt, recoveredUrl, llm)
    if (attempt.recipeId) {
      await applyRowMetadata(rt, attempt.recipeId, input)
      return {
        pageId: row.pageId,
        title,
        outcome: attempt.outcome?.status === 'duplicate' ? 'duplicate' : 'imported',
        via: 'body-url',
        recipeId: attempt.recipeId,
        sourceUrl: recoveredUrl,
        rowSourceUrl,
        // Said out loud, and the summary prints it even though the outcome is a
        // plain success: `findSourceUrlInBody` returns the first whole-line
        // link above the first heading, which on a Notion clip can just as
        // easily be a "Jump to Recipe" anchor or a photo credit as the article.
        // When it is, this row now holds a different recipe's title and
        // ingredients wearing this row's rating, status and original date, and
        // nothing else in the run would ever mention it.
        reason:
          `source URL recovered from the Notion page body — imported ${recoveredUrl} ` +
          `instead of ${rowSourceUrl ?? 'no link on the row'}; CHECK that this is the same recipe`,
        at: now(),
      }
    }
    const next = decideAction(input, attempt.outcome)
    if (next.kind === 'skip') {
      return {
        pageId: row.pageId,
        title,
        outcome: 'skipped',
        via: null,
        recipeId: null,
        sourceUrl: recoveredUrl,
        rowSourceUrl,
        reason: `${next.reason} (URL recovered from the page body)`,
        at: now(),
      }
    }
  }

  const extracted = await fromNotionBody(row, body, llm)
  if (!extracted) {
    return {
      pageId: row.pageId,
      title,
      outcome: 'unrecoverable',
      via: null,
      recipeId: null,
      sourceUrl: input.sourceUrl,
      rowSourceUrl,
      reason: 'the source URL is unusable and the Notion page body holds no recipe',
      at: now(),
    }
  }

  // `fromNotionBody` never parses quantities — that is its whole rule, since
  // the body is already a lossy copy and the verbatim line is the last thing
  // between a bad parse and lost data. So enrichment has to happen *here*, or
  // every recipe rescued from a dead link lands with no tags and no parsed
  // quantities: invisible to the filter rail, in an app that is a filter rail.
  const enriched = await applyEnrichment(extracted, llm)
  const recipe: ExtractedRecipe = { ...enriched, narrativeHtml: extracted.narrativeHtml }

  // The original URL is stored even when it is dead. It is the recipe's true
  // provenance, it is what a later repair pass would retry, and it is what
  // makes this path idempotent: a second run upserts over the same row instead
  // of inserting a second copy.
  const sourceUrl = recoveredUrl ?? input.sourceUrl
  const sourceDomain = sourceUrl ? safeDomain(sourceUrl) : null
  const applied = enrichmentApplied(recipe)

  // Refuse to trade a good recipe for a lossy Notion copy of it.
  //
  // Two Notion rows can share a canonical URL. The first imports cleanly; the
  // second is refused by the publisher, lands here, and `upsertRecipe` would
  // find the first one's row by `sourceUrl` and overwrite it in place — same
  // recipe id, ingredients replaced wholesale by the body's raw lines, tags
  // gone. `runImport` has a guard for precisely this and this path never
  // reaches it, because `runImport` fetches before it dedupes and the fetch is
  // what failed. Two rules apply here instead; see `refuseBodyDowngrade` for
  // what each of them protects and why the reasons are worded differently.
  const refusal = await refuseBodyDowngrade(rt, sourceUrl, applied)
  if (refusal) {
    return {
      pageId: row.pageId,
      title,
      outcome: 'skipped',
      via: null,
      recipeId: null,
      sourceUrl,
      rowSourceUrl,
      reason: refusal.reason,
      at: now(),
    }
  }

  const recipeId = await rt.upsertRecipe(rt.db, {
    extracted: recipe,
    sourceUrl,
    sourceDomain,
    enrichmentApplied: applied,
    createdAt: input.createdAt,
  })

  // The picture was captured before any of the above ran; all that is left is
  // to write it out under the id that now exists. `captured` is null when the
  // body named no image, or when the download failed — both of which are
  // survivable and neither of which fails the row.
  if (captured) await storeCapturedHeroImage(rt, recipeId, captured)
  // A hero the early scan did not recognise but `fromNotionBody` did. Rare
  // enough to be worth the late, expiry-exposed attempt rather than nothing.
  else if (recipe.heroImageUrl) {
    const late = await captureBodyHeroImage(rt, recipe.heroImageUrl)
    if (late) await storeCapturedHeroImage(rt, recipeId, late)
  }

  await applyRowMetadata(rt, recipeId, input)

  return {
    pageId: row.pageId,
    title,
    outcome: 'body-recovered',
    via: 'notion-body',
    recipeId,
    sourceUrl,
    rowSourceUrl,
    reason: `recovered from the Notion body: ${recipe.ingredients.length} ingredients, ${recipe.steps.length} steps${
      applied ? '' : ' — NOT enriched'
    }`,
    at: now(),
  }
}

function safeDomain(url: string): string | null {
  try {
    return normalizeSourceUrl(url).domain
  } catch {
    return null
  }
}

async function runMigration(
  opts: Options,
  notion: Client,
  rows: NotionRecipeRow[],
  dataSourceId: string,
): Promise<void> {
  const resume = await loadResume(opts, dataSourceId)
  const writeResume = createResumeWriter(opts.resumePath, resume)

  const rt = await loadRuntime()
  const llm = createThrottledLlm(rt.anthropic, opts.modelIntervalMs)

  await preflight({ store: rt.store, llm: rt.anthropic, log })
  const notionGate = createSerialGate(NOTION_INTERVAL_MS)

  const pending = rows.filter((row) => !isTerminal(resume.rows[row.pageId]))
  const alreadyDone = rows.length - pending.length

  log(
    `migrating ${pending.length} rows (${alreadyDone} already finished), ` +
      `${opts.concurrency} at a time, model calls spaced ${opts.modelIntervalMs}ms apart`,
  )

  const started = Date.now()
  const results: RowResult[] = []
  let done = 0
  let stopped = false

  await forEachWithConcurrency(
    pending,
    opts.concurrency,
    async (row) => {
      let result: RowResult
      try {
        result = await processRow(row, rt, llm, (pageId) =>
          notionGate(() => fetchPageBody(notion, pageId)),
        )
      } catch (error) {
        result = {
          pageId: row.pageId,
          title: row.title ?? '(untitled)',
          outcome: 'skipped',
          via: null,
          recipeId: null,
          sourceUrl: null,
          rowSourceUrl: null,
          reason: errorText(error),
          at: new Date().toISOString(),
        }
      }

      results.push(result)
      await writeResume(result)
      done++
      log(
        `${String(done).padStart(3)}/${pending.length}  ${result.outcome.padEnd(15)} ${result.title}` +
          // A plain `imported` needs no explanation — except when the URL that
          // was imported is not the row's own. That one always gets said.
          (result.reason && (result.outcome !== 'imported' || result.via === 'body-url')
            ? `\n      ${result.reason}`
            : ''),
      )

      // The hard stop. Checked after the row rather than before, so the row in
      // flight is finished and recorded before anything gives up. Continuing
      // past an exhausted rate limit would import recipe after recipe with no
      // tags and no quantities, every one of them reporting success — the
      // exact silent failure this whole file is arranged around.
      if (llm.exhausted) stopped = true
    },
    () => stopped,
  )

  printSummary({ results, rows, alreadyDone, llm, elapsedMs: Date.now() - started, opts })

  if (stopped) {
    console.error(
      [
        '',
        `[migrate] STOPPED: ${llm.exhaustionDetail}`,
        '',
        '  The model stayed rate limited through the full backoff ladder, so this run',
        '  stopped rather than carrying on. Recipes imported past an exhausted rate',
        '  limit look perfectly fine — they store, they read, the job says `done` — and',
        '  arrive with zero tags and every quantity null. Nothing would have told you.',
        '',
        `  Everything finished so far is recorded in ${opts.resumePath}. Wait for the`,
        '  limit to reset (an hour is usually plenty) and run `npm run migrate` again;',
        '  it picks up exactly where this stopped and pays for nothing twice.',
        '',
      ].join('\n'),
    )
    process.exit(2)
  }
}

/**
 * The end-of-run report. Exported so a test can read what an operator is
 * actually told — in particular that a row whose source URL was swapped for one
 * found in the page body says so, out loud, with both URLs.
 */
export function printSummary(args: {
  results: RowResult[]
  rows: NotionRecipeRow[]
  alreadyDone: number
  llm: LlmGate
  elapsedMs: number
  opts: Options
}): void {
  const { results, rows, alreadyDone, llm, elapsedMs, opts } = args
  const count = (outcome: RowResult['outcome']) => results.filter((r) => r.outcome === outcome).length

  console.log('')
  log('--- summary ---')
  log(`rows in the library:        ${rows.length}`)
  log(`already finished before:    ${alreadyDone}`)
  log(`imported:                   ${count('imported')}`)
  log(`duplicates:                 ${count('duplicate')}`)
  log(`recovered from Notion body: ${count('body-recovered')}`)
  log(`unrecoverable:              ${count('unrecoverable')}`)
  log(`skipped (retry later):      ${count('skipped')}`)
  log(`model calls:                ${llm.calls} (${llm.retries} rate-limited retries)`)
  log(`elapsed:                    ${(elapsedMs / 1000).toFixed(0)}s`)

  const needsEyes = results.filter((r) => r.outcome === 'skipped' || r.outcome === 'unrecoverable')
  if (needsEyes.length > 0) {
    console.log('')
    log(`${needsEyes.length} rows did not land:`)
    for (const row of needsEyes) log(`  ${row.outcome.padEnd(14)} ${row.title}\n      ${row.reason}`)
  }

  // Rows whose source was swapped. A success by every measure the runner has,
  // and still the one outcome most likely to be wrong: `findSourceUrlInBody`
  // takes the first whole-line link above the first heading, which on a Notion
  // clip may be a "Jump to Recipe" anchor, a photo credit, or the publisher's
  // homepage. Where it is, the recipe stored here carries another page's title
  // and ingredients while wearing this row's rating, status and original date —
  // and every number above it counts that as an import. It is a handful of rows
  // and a minute of a human's time, but only if the run says which rows.
  const bodyUrlImports = results.filter((r) => r.via === 'body-url')
  if (bodyUrlImports.length > 0) {
    console.log('')
    log(`${bodyUrlImports.length} rows were imported from a URL found in the page body, not from`)
    log('the row\'s own Link property. Open each one and check it is the same recipe:')
    for (const row of bodyUrlImports) {
      log(`  ${row.title}`)
      log(`      row link:  ${row.rowSourceUrl ?? '(none — the Link property was empty)'}`)
      log(`      imported:  ${row.sourceUrl}`)
    }
    log(`(also recorded in ${opts.resumePath}, so a re-run does not lose the list)`)
  }

  const unenriched = results.filter((r) => r.reason?.includes('NOT enriched'))
  if (unenriched.length > 0) {
    console.log('')
    log(`${unenriched.length} body-recovered recipes stored without enrichment — run \`npm run unenriched\``)
  }

  console.log('')
  log(`resume file: ${opts.resumePath}`)
  log('next: `npm run unenriched`, then `npm run migrate:verify`')
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }

  const opts = parseArgs(argv)

  // Preflight before anything else, so a missing token is a sentence rather
  // than a stack trace out of a client constructor.
  requireEnv(
    opts.dryRun
      ? ['NOTION_TOKEN', 'NOTION_DATA_SOURCE_ID']
      : [
          'NOTION_TOKEN',
          'NOTION_DATA_SOURCE_ID',
          'TURSO_DATABASE_URL',
          'ANTHROPIC_API_KEY',
          'BLOB_READ_WRITE_TOKEN',
        ],
  )

  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID!
  const notion = createNotionClient()

  log(`fetching rows from Notion data source ${dataSourceId} ...`)
  let rows = await fetchRecipeRows(notion, dataSourceId)
  log(`fetched ${rows.length} rows`)

  if (rows.length !== 156) {
    // Not fatal: the library is a living database and rows get added. But the
    // whole plan is measured against 156, so a different number is a fact the
    // operator should see before reading any total in the report.
    log(`note: the plan was written against 156 rows; this run sees ${rows.length}`)
  }

  if (opts.limit != null) {
    rows = rows.slice(0, opts.limit)
    log(`--limit=${opts.limit}: processing the first ${rows.length} rows only`)
  }

  if (opts.dryRun) {
    await runDryRun(opts, notion, rows)
    return
  }

  await runMigration(opts, notion, rows, dataSourceId)
}

/**
 * Run `main` only when this file is the program, so `tests/notion/migrate.test.ts`
 * can import the pure functions above without kicking off a migration.
 *
 * `process.argv[1]` rather than `import.meta.url`: this file is executed by tsx
 * with no `"type": "module"` in package.json, so it is transpiled to CommonJS
 * and `import.meta` is not reliably available, while argv is available in both.
 */
const invokedDirectly = /migrate-notion\.(ts|js)$/.test(process.argv[1] ?? '')

if (invokedDirectly) {
  main().catch((error) => {
    console.error('\n[migrate] unexpected error:')
    console.error(error)
    process.exit(1)
  })
}
