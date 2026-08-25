import { normalizeSourceUrl } from '@/lib/url'
import { normalizeTags, type TagAssignment } from '@/lib/taxonomy'
import type { NotionRecipeRow } from '@/lib/notion/types'

/** The input the migration runner consumes for one recipe, derived from a Notion row. */
export type MigrationInput = {
  pageId: string
  notionTitle: string | null
  publisher: string | null
  author: string | null
  sourceUrl: string | null
  sourceDomain: string | null
  rating: number | null
  status: 'made_it' | 'want_to_make' | null
  tags: TagAssignment[]
  createdAt: Date
}

// Anchored to the full string on purpose: a link with surrounding prose
// (e.g. "see [here](https://x.com/r)") is not a pure markdown link and is
// left alone rather than partially extracted, since the label there isn't
// necessarily interchangeable with the URL.
const MARKDOWN_LINK = /^\[(.*)\]\((.*)\)$/

/**
 * Unwraps a Notion "Link" field that was pasted as a markdown link
 * `[label](target)` instead of a bare URL. 59 of 156 rows in the source
 * library (38%) are stored this way -- this is not defensive clutter, it is
 * the core job of this module. When the label and target differ, the target
 * (the actual URL) wins.
 */
export function unwrapLink(raw: string | null): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const match = trimmed.match(MARKDOWN_LINK)
  if (!match) return trimmed

  const target = match[2].trim()
  return target ? target : null
}

const STATUS_MAP: Record<string, 'made_it' | 'want_to_make'> = {
  'Made It': 'made_it',
  'Want to Make': 'want_to_make',
}

/**
 * Parses a Notion page-creation timestamp, e.g. "2020-12-20 00:59:34Z".
 * Notion uses a space where ISO 8601 requires "T"; Node's `Date` parser
 * happens to accept that leniently, but leniency is engine-specific and
 * silent failure here would write `Invalid Date` into migrated rows and
 * flatten the library's history. Normalize to a strict ISO string first so
 * parsing does not depend on that leniency, and fail loudly if it still
 * doesn't parse.
 */
function parseCreatedTime(raw: string): Date {
  const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const date = new Date(isoish)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Notion createdTime: ${raw}`)
  }
  return date
}

/**
 * Converts one Notion database row into the migration runner's input. Pure:
 * no network, no database. `Added By` is deliberately not mapped -- it is
 * empty on all 156 source rows, so there is nothing to carry over.
 */
export function mapNotionRow(row: NotionRecipeRow): MigrationInput {
  let sourceUrl: string | null = null
  let sourceDomain: string | null = null

  const unwrapped = unwrapLink(row.link)
  if (unwrapped) {
    try {
      const normalized = normalizeSourceUrl(unwrapped)
      sourceUrl = normalized.url
      sourceDomain = normalized.domain
    } catch {
      // Not a real URL (e.g. "see the cookbook"). The row is still
      // migratable from its Notion body, so this is not fatal here.
      sourceUrl = null
      sourceDomain = null
    }
  }

  return {
    pageId: row.pageId,
    notionTitle: row.title,
    publisher: row.publisher,
    author: row.author,
    sourceUrl,
    sourceDomain,
    // Notion's Rating is a plain number property with no enforced range or
    // step; it is carried through unclamped. Any clamping/rounding policy
    // (e.g. capping above 5, rounding a 4.5) belongs downstream, closer to
    // however the UI/storage layer defines its rating scale.
    rating: row.rating,
    status: row.cookingStatus ? (STATUS_MAP[row.cookingStatus] ?? null) : null,
    tags: normalizeTags(row.tags),
    createdAt: parseCreatedTime(row.createdTime),
  }
}
