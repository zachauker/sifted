import { llmRecipeSchema, type LlmClient } from '@/lib/extract/llm-types'
import type { ExtractedIngredient, ExtractedRecipe, ExtractedStep } from '@/lib/extract/types'
import type { NotionRecipeBody, NotionRecipeRow } from '@/lib/notion/types'

/**
 * Recovers a recipe from a Notion page body.
 *
 * This is the path for rows whose source URL is dead (getpocket.com is already
 * gone), blocked, or absent. For the hand-typed family recipes in the library
 * the Notion body is the *only* copy that exists anywhere, so the guiding rule
 * here is that no strategy may silently drop content: each one hands off to the
 * next, and null is returned only when all three find nothing.
 *
 * The chain mirrors `src/lib/extract/index.ts` -- deterministic parse first,
 * model second -- with one addition it does not have: a salvage floor, because
 * a page fetched from the web can be fetched again after an outage and a
 * hand-typed 2019 family recipe cannot.
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const IMAGE_ONLY_RE = /^!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)$/
const LINK_ONLY_RE = /^\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)$/
const BARE_URL_RE = /^(https?:\/\/\S+)$/
const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)])\s+/
const BOLD_ONLY_RE = /^(?:\*\*(.+?)\*\*|__(.+?)__)$/

/**
 * A heading that introduces the ingredient list. Matched loosely because these
 * bodies were written by hand over seven years and by Notion's web clipper,
 * with no shared template between them.
 */
function isIngredientsHeading(text: string): boolean {
  return /\bingredients?\b/i.test(text) || /\byou(?:'ll| will)? need\b/i.test(text)
}

/** A heading that introduces the steps. Same looseness, same reason. */
function isStepsHeading(text: string): boolean {
  return (
    /\b(?:instructions?|preparation|directions?|method|steps)\b/i.test(text) ||
    /\bhow to make\b/i.test(text)
  )
}

type Heading = { level: number; text: string }

function asHeading(line: string): Heading | null {
  const match = line.match(HEADING_RE)
  return match ? { level: match[1].length, text: match[2] } : null
}

/** Strips a leading `- `, `* ` or `1. ` so the stored text is the content only. */
function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER_RE, '').trim()
}

/**
 * Whether a bare line reads as prose rather than as a recipe line.
 *
 * Only the salvage floor uses this, and it is deliberately reluctant: keeping
 * one stray sentence as an "ingredient" is a cosmetic wart, while dropping a
 * real line loses the only copy of it. So a line is prose only when it is
 * clearly long, or when it is a complete sentence of some length that carries
 * no quantity at all -- "We should try making this sometime." rather than
 * "1 cup buttermilk, warmed."
 */
function looksLikeNarrative(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length > 12) return true
  if (!/[.!?]$/.test(line)) return false
  // A leading quantity is the strongest signal of an ingredient line, and
  // outranks the trailing period.
  if (/^\W*\d/.test(line)) return false
  return words.length >= 6
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toNarrativeHtml(paragraphs: string[]): string | null {
  const kept = paragraphs.map((p) => p.trim()).filter(Boolean)
  if (kept.length === 0) return null
  return kept.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
}

/**
 * Finds a source URL that the row's `Link` property was missing.
 *
 * The Notion clipper writes the clipped URL as a standalone markdown link at
 * the top of the body, and at least one row (Cast-Iron Green Chile Tamale Pie)
 * has that link while its `Link` property is empty -- so a row that looks
 * unrecoverable may in fact be importable from the web after all.
 *
 * Only the preamble above the first heading is searched, and only lines that
 * are *entirely* a link count. A link embedded in an ingredient
 * ("1 cup salsa verde ([homemade](...) or storebought)") is a reference to a
 * different recipe, and returning it as this recipe's source would import the
 * wrong page.
 */
export function findSourceUrlInBody(body: NotionRecipeBody): string | null {
  for (const raw of body.markdown.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // The recipe proper has started; anything below is content, not a header.
    if (asHeading(line)) return null
    if (IMAGE_ONLY_RE.test(line)) continue

    const url = line.match(LINK_ONLY_RE)?.[1] ?? line.match(BARE_URL_RE)?.[1]
    if (url && /^https?:\/\//i.test(url)) return url
  }
  return null
}

function findHeroImageUrl(markdown: string): string | null {
  for (const raw of markdown.split('\n')) {
    const match = raw.trim().match(IMAGE_ONLY_RE)
    if (match) return match[1]
  }
  return null
}

/** The prose above the first recipe heading: no link line, no image, no list. */
function preambleParagraphs(markdown: string): string[] {
  const paragraphs: string[] = []
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (asHeading(line)) break
    if (IMAGE_ONLY_RE.test(line)) continue
    if (LINK_ONLY_RE.test(line) || BARE_URL_RE.test(line)) continue
    if (LIST_MARKER_RE.test(line)) continue
    paragraphs.push(line)
  }
  return paragraphs
}

type Parsed = {
  ingredients: { text: string; section: string | null }[]
  steps: { text: string; section: string | null }[]
}

/**
 * Strategy 1: parse by heading. Free, exact, and lossless where it applies --
 * the sub-headings under `## Ingredients` and `## Preparation` are precisely
 * the `section` field, so a body written this way needs no model at all.
 */
function parseByHeadings(markdown: string): Parsed | null {
  const lines = markdown.split('\n')
  const hasRecipeHeading = lines.some((line) => {
    const heading = asHeading(line.trim())
    return heading != null && (isIngredientsHeading(heading.text) || isStepsHeading(heading.text))
  })
  if (!hasRecipeHeading) return null

  const parsed: Parsed = { ingredients: [], steps: [] }
  let mode: 'ingredients' | 'steps' | null = null
  let modeLevel = 0
  let section: string | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    const heading = asHeading(line)
    if (heading) {
      // Anything nested below the active heading is a sub-section of it --
      // "For the filling", "Make the cornbread topping".
      if (mode && heading.level > modeLevel) {
        section = heading.text
        continue
      }
      if (isIngredientsHeading(heading.text)) {
        mode = 'ingredients'
      } else if (isStepsHeading(heading.text)) {
        mode = 'steps'
      } else {
        // A sibling heading that is neither ("## Notes", "## Nutrition") ends
        // the recipe region rather than quietly absorbing its content.
        mode = null
      }
      modeLevel = heading.level
      section = null
      continue
    }

    if (!mode) continue
    if (IMAGE_ONLY_RE.test(line)) continue

    const text = stripListMarker(line)
    if (!text) continue
    parsed[mode].push({ text, section })
  }

  return parsed
}

/**
 * Strategy 3: the floor. Every line that is not an image, a link, or prose
 * becomes a verbatim ingredient, with a bolded line (`**Dough**`) read as a
 * section break the way the person typing it meant it.
 *
 * This exists so that a model outage cannot lose a recipe that exists in one
 * place. An over-inclusive ingredient list is fixable by hand later; a recipe
 * that was never imported is not, because the Notion database is going away.
 */
function salvage(markdown: string): Parsed & { narrative: string[] } {
  const ingredients: { text: string; section: string | null }[] = []
  const narrative: string[] = []
  let section: string | null = null

  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (IMAGE_ONLY_RE.test(line)) continue
    if (LINK_ONLY_RE.test(line) || BARE_URL_RE.test(line)) continue

    const heading = asHeading(line)
    if (heading) {
      section = heading.text
      continue
    }

    const bold = line.match(BOLD_ONLY_RE)
    if (bold) {
      section = (bold[1] ?? bold[2]).trim()
      continue
    }

    const text = stripListMarker(line)
    if (!text) continue
    if (looksLikeNarrative(text)) {
      narrative.push(text)
      continue
    }
    ingredients.push({ text, section })
  }

  return { ingredients, steps: [], narrative }
}

function hasContent(parsed: Parsed | null): parsed is Parsed {
  return parsed != null && (parsed.ingredients.length > 0 || parsed.steps.length > 0)
}

function toIngredients(items: Parsed['ingredients']): ExtractedIngredient[] {
  // quantity/unit/item/note stay null on purpose. The body is already a lossy
  // copy of the original; the verbatim line is the last thing standing between
  // a bad parse and lost data, and enrichment fills these in later against the
  // line we preserved.
  return items.map((item, position) => ({
    position,
    section: item.section,
    rawText: item.text,
    quantity: null,
    unit: null,
    item: null,
    note: null,
  }))
}

function toSteps(items: Parsed['steps']): ExtractedStep[] {
  return items.map((item, position) => ({ position, section: item.section, text: item.text }))
}

type LlmResult = {
  parsed: Parsed
  title: string | null
  description: string | null
  author: string | null
  claimedTimeMinutes: number | null
  servings: number | null
  yieldText: string | null
}

/**
 * Strategy 2: the model, validated exactly as `extract()` validates it.
 *
 * Unlike `extract()`, a rejection is not rethrown. There is no URL to retry
 * here and no second copy of the page, so an unavailable model must fall
 * through to salvage rather than abort the row.
 */
async function fromLlm(
  markdown: string,
  url: string,
  llm: LlmClient,
): Promise<LlmResult | null> {
  let raw: unknown
  try {
    raw = await llm.extractRecipe({ url, text: markdown })
  } catch {
    return null
  }

  const result = llmRecipeSchema.safeParse(raw)
  if (!result.success) return null

  const data = result.data
  return {
    parsed: {
      ingredients: data.ingredients
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ text, section: null })),
      steps: data.steps
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ text, section: null })),
    },
    title: data.title.trim() || null,
    description: data.description,
    author: data.author,
    claimedTimeMinutes: data.claimedTimeMinutes,
    servings: data.servings,
    yieldText: data.yieldText,
  }
}

/**
 * Converts a Notion page body into a recipe. Pure: no network, no database, no
 * clock. The model is injected, so every path is driven from tests.
 *
 * Returns null only when headings, the model, and salvage all yield neither an
 * ingredient nor a step -- i.e. the page genuinely holds no recipe.
 */
export async function fromNotionBody(
  row: NotionRecipeRow,
  body: NotionRecipeBody,
  llm: LlmClient,
): Promise<ExtractedRecipe | null> {
  const markdown = body.markdown ?? ''
  if (!markdown.trim()) return null

  let parsed: Parsed | null = null
  let llmResult: LlmResult | null = null
  // The prose that is *not* part of the recipe. Which lines those are depends
  // on which strategy won, so each one reports its own leftovers -- otherwise
  // the "story" ends up being the ingredient list a second time.
  let narrative: string[] = []

  const byHeadings = parseByHeadings(markdown)
  if (hasContent(byHeadings)) {
    parsed = byHeadings
    narrative = preambleParagraphs(markdown)
  } else {
    // A heading-shaped body with nothing under it (an `## Ingredients` and no
    // list) is a miss, not a result: returning an empty-but-non-null recipe
    // would record a successful import of nothing, forever.
    const fromModel = await fromLlm(
      markdown,
      findSourceUrlInBody(body) ?? `notion:${body.pageId}`,
      llm,
    )
    const salvaged = salvage(markdown)
    narrative = salvaged.narrative

    if (fromModel && hasContent(fromModel.parsed)) {
      parsed = fromModel.parsed
      llmResult = fromModel
    } else if (hasContent(salvaged)) {
      parsed = { ingredients: salvaged.ingredients, steps: salvaged.steps }
    }
  }

  if (!hasContent(parsed)) return null

  return {
    // The row's title is authoritative: it is what the library has been
    // indexed by for seven years. "Untitled recipe" matches the fallback the
    // JSON-LD path uses, and only ever applies to the one blank 2026 page.
    title: row.title?.trim() || llmResult?.title || 'Untitled recipe',
    description: llmResult?.description ?? null,
    author: row.author ?? llmResult?.author ?? null,
    publisher: row.publisher ?? null,
    claimedTimeMinutes: llmResult?.claimedTimeMinutes ?? null,
    servings: llmResult?.servings ?? null,
    yieldText: llmResult?.yieldText ?? null,
    ingredients: toIngredients(parsed.ingredients),
    steps: toSteps(parsed.steps),
    // Tags come from the row's Notion properties via `mapNotionRow`, not from
    // the body, so this stays empty rather than guessing a second time.
    tags: [],
    heroImageUrl: findHeroImageUrl(markdown),
    narrativeHtml: toNarrativeHtml(narrative),
    extractionMethod: 'notion',
  }
}
