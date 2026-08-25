#!/usr/bin/env tsx
/**
 * Fetches a real page, runs it through the extraction pipeline, and prints the
 * resulting recipe as JSON. This is the manual/operational entry point for the
 * pipeline built in src/lib/{fetch,extract,url} -- nothing in that pipeline has
 * ever been exercised against a live site until this script runs it.
 *
 * Usage:
 *   npm run extract -- <url> [save-html-path]
 *   npm run extract -- <url> [save-html-path] --no-llm
 *
 * Progress and diagnostics go to stderr; the final JSON result goes to stdout,
 * so the output can be piped (e.g. `npm run extract -- <url> | jq .title`).
 */
import { writeFile } from 'node:fs/promises'
import { createAnthropicClient } from '../src/lib/llm/anthropic-client'
import { extract } from '../src/lib/extract/index'
import type { LlmClient } from '../src/lib/extract/llm-types'
import { BlockedError, FetchFailedError, fetchPage } from '../src/lib/fetch/index'
import { normalizeSourceUrl } from '../src/lib/url'

/** Substitutes for the real Anthropic client when no key is available or the
 * caller explicitly opts out. JSON-LD and microdata extraction need no LLM at
 * all -- it is only consulted for enrichment and as a last-resort extractor --
 * so a no-op stand-in lets the rest of the pipeline run untouched. */
const noopLlm: LlmClient = {
  async enrich() {
    return null
  },
  async extractRecipe() {
    return null
  },
}

function resolveLlmClient(noLlmFlag: boolean): LlmClient {
  if (noLlmFlag) {
    console.error('[extract-url] mode: --no-llm passed, using no-op LLM client')
    return noopLlm
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '[extract-url] warning: ANTHROPIC_API_KEY is not set; falling back to no-op LLM client. ' +
        'Structured-data extraction (JSON-LD/microdata) is unaffected, but enrichment and ' +
        'LLM-fallback extraction will not run.',
    )
    return noopLlm
  }

  console.error('[extract-url] mode: using real Anthropic client')
  return createAnthropicClient()
}

function parseArgs(argv: string[]): { url: string; savePath: string | null; noLlm: boolean } {
  const noLlm = argv.includes('--no-llm')
  const positional = argv.filter((a) => a !== '--no-llm')

  const [url, savePath] = positional
  if (!url) {
    console.error('Usage: npm run extract -- <url> [save-html-path] [--no-llm]')
    process.exit(1)
  }

  return { url, savePath: savePath ?? null, noLlm }
}

async function main(): Promise<void> {
  const { url: rawUrl, savePath, noLlm } = parseArgs(process.argv.slice(2))

  const { url } = normalizeSourceUrl(rawUrl)
  console.error(`[extract-url] normalized URL: ${url}`)

  const llm = resolveLlmClient(noLlm)

  console.error(`[extract-url] fetching ${url} ...`)
  let page: Awaited<ReturnType<typeof fetchPage>>
  try {
    page = await fetchPage(url)
  } catch (error) {
    if (error instanceof BlockedError) {
      console.error(
        `[extract-url] BLOCKED: ${error.url} returned HTTP ${error.status}. ` +
          'The site refused this request (likely a datacenter-IP block). Retry from a ' +
          'residential network or a device fallback rather than retrying immediately.',
      )
      process.exit(2)
    }
    if (error instanceof FetchFailedError) {
      console.error(`[extract-url] FETCH FAILED: ${error.url} -- ${error.reason}`)
      process.exit(3)
    }
    throw error
  }

  console.error(`[extract-url] fetched: HTTP ${page.status}, finalUrl=${page.finalUrl}, ${page.html.length} chars`)

  if (savePath) {
    await writeFile(savePath, page.html, 'utf-8')
    console.error(`[extract-url] saved raw HTML to ${savePath}`)
  }

  console.error('[extract-url] running extract() ...')
  const result = await extract({ url: page.finalUrl, html: page.html, llm })

  const heroAbsolute = result.heroImageUrl ? /^[a-z][a-z0-9+.-]*:/i.test(result.heroImageUrl) : null

  console.error('[extract-url] --- summary ---')
  console.error(`[extract-url] extractionMethod: ${result.extractionMethod}`)
  console.error(`[extract-url] title: ${result.title}`)
  console.error(`[extract-url] ingredients: ${result.ingredients.length}`)
  console.error(`[extract-url] steps: ${result.steps.length}`)
  console.error(`[extract-url] claimedTimeMinutes: ${result.claimedTimeMinutes ?? '(none)'}`)
  console.error(
    `[extract-url] heroImageUrl: ${result.heroImageUrl ?? '(none)'} ` +
      `(${heroAbsolute === null ? 'n/a' : heroAbsolute ? 'absolute' : 'NOT absolute'})`,
  )
  console.error(`[extract-url] tags (${result.tags.length}): ${result.tags.map((t) => `${t.facet}:${t.value}`).join(', ') || '(none)'}`)
  console.error(`[extract-url] narrativeHtml: ${result.narrativeHtml ? `${result.narrativeHtml.length} chars` : '(none)'}`)

  // The full result -- including narrativeHtml in full -- goes to stdout so the
  // output stays pipeable (e.g. into `jq` or a file redirect) without the
  // stderr progress log polluting it.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
  console.error('[extract-url] unexpected error:')
  console.error(error)
  process.exit(1)
})
