/**
 * The only module that talks to the Notion API. Everything downstream
 * consumes the plain types in `./types`, so mapping and body recovery stay
 * testable against committed fixtures with no token and no network.
 *
 * One-time migration tool -- not part of the app's runtime request path.
 */
import {
  Client,
  isFullBlock,
  isFullPage,
  type BlockObjectResponse,
  type CodeBlockObjectResponse,
  type ImageBlockObjectResponse,
  type PageObjectResponse,
  type PartialBlockObjectResponse,
  type RichTextItemResponse,
} from '@notionhq/client'
import type { NotionRecipeBody, NotionRecipeRow } from '@/lib/notion/types'

/**
 * Builds a Notion client. Evaluated at call time (not import time) so that a
 * route or script can import this module -- transitively, through the
 * migration runner -- without booting a client or requiring the token to be
 * set, matching the pattern in `src/lib/llm/anthropic-client.ts`.
 */
export function createNotionClient(token = process.env.NOTION_TOKEN): Client {
  if (!token) throw new Error('NOTION_TOKEN is not set')
  return new Client({ auth: token })
}

// ---------------------------------------------------------------------------
// Row fetching
// ---------------------------------------------------------------------------

/**
 * Queries the "Library" data source for rows where `Type = Recipe`
 * (filtered server-side), paginates until exhausted, and maps each page's
 * properties onto `NotionRecipeRow`. Notion's property shapes are unwrapped
 * here so nothing downstream ever sees them.
 */
export async function fetchRecipeRows(
  client: Client,
  dataSourceId: string,
): Promise<NotionRecipeRow[]> {
  const rows: NotionRecipeRow[] = []
  let cursor: string | undefined

  for (;;) {
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      filter: {
        property: 'Type',
        select: { equals: 'Recipe' },
      },
    })

    for (const result of response.results) {
      if (!isFullPage(result)) continue
      rows.push(mapPageToRow(result))
    }

    // Guards against a malformed response that claims more pages exist but
    // provides no cursor to fetch them with -- without this check that
    // combination would spin forever.
    if (!response.has_more || !response.next_cursor) break
    cursor = response.next_cursor
  }

  return rows
}

function mapPageToRow(page: PageObjectResponse): NotionRecipeRow {
  const props = page.properties

  return {
    pageId: page.id,
    title: getTitlePlainText(props['Name']),
    link: getUrlValue(props['Link']),
    publisher: getRichTextPlainText(props['Publisher']),
    author: getRichTextPlainText(props['Author']),
    rating: getNumberValue(props['Rating']),
    cookingStatus: getCookingStatusValue(props['Cooking Status']),
    // `Topic` is a second multi_select duplicating the non-food half of
    // `Tags` on this database -- deliberately not read here. `Tags` alone is
    // what `normalizeTags` (in map.ts) expects, and folding `Topic` in would
    // silently double up categories that already exist in `Tags`.
    tags: getMultiSelectNames(props['Tags']),
    createdTime: page.created_time,
  }
}

// -- Defensive property unwrapping -------------------------------------------
//
// Every helper below takes `unknown` and returns null/empty on anything that
// isn't exactly the shape it expects -- an absent property, a null value, or
// a property whose type changed in Notion -- rather than throwing. This is
// what lets one genuinely titleless row (see NotionRecipeRow.title) pass
// through the migration instead of crashing it.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function plainTextOf(item: unknown): string {
  const record = asRecord(item)
  return typeof record?.plain_text === 'string' ? record.plain_text : ''
}

function getRichTextArray(prop: unknown, propertyType: string): RichTextItemResponse[] | null {
  const record = asRecord(prop)
  if (!record || record.type !== propertyType) return null
  const value = record[propertyType]
  return Array.isArray(value) ? (value as RichTextItemResponse[]) : null
}

function joinRichText(items: RichTextItemResponse[]): string | null {
  const text = items.map(plainTextOf).join('')
  return text.length > 0 ? text : null
}

function getTitlePlainText(prop: unknown): string | null {
  const arr = getRichTextArray(prop, 'title')
  return arr ? joinRichText(arr) : null
}

function getRichTextPlainText(prop: unknown): string | null {
  const arr = getRichTextArray(prop, 'rich_text')
  return arr ? joinRichText(arr) : null
}

function getUrlValue(prop: unknown): string | null {
  const record = asRecord(prop)
  if (!record || record.type !== 'url') return null
  return typeof record.url === 'string' ? record.url : null
}

function getNumberValue(prop: unknown): number | null {
  const record = asRecord(prop)
  if (!record || record.type !== 'number') return null
  return typeof record.number === 'number' ? record.number : null
}

function getCookingStatusValue(prop: unknown): 'Made It' | 'Want to Make' | null {
  const record = asRecord(prop)
  if (!record || record.type !== 'select') return null
  const select = asRecord(record.select)
  const name = select?.name
  return name === 'Made It' || name === 'Want to Make' ? name : null
}

function getMultiSelectNames(prop: unknown): string[] {
  const record = asRecord(prop)
  if (!record || record.type !== 'multi_select' || !Array.isArray(record.multi_select)) return []
  return record.multi_select
    .map((item) => asRecord(item)?.name)
    .filter((name): name is string => typeof name === 'string')
}

// ---------------------------------------------------------------------------
// Page body fetching
// ---------------------------------------------------------------------------

// Bounds the children-of-children recursion below so a malformed or
// pathologically deeply nested page cannot blow the stack. 156 hand-written
// recipe pages have no legitimate reason to nest anywhere near this deep.
const MAX_BLOCK_DEPTH = 50

/**
 * Reads a page's block children -- recursing into nested children, and
 * paginating both the top level and every nested level, since Notion paginates
 * block children independently at each level of nesting -- and renders them
 * as markdown matching the conventions in
 * tests/notion/fixtures/body-structured.json and body-unstructured.json:
 * `##`/`###` headings, `- ` / `1. ` list items, `![](url)` images, `**bold**`,
 * and `[text](url)` links, with bare lines for paragraphs.
 */
export async function fetchPageBody(client: Client, pageId: string): Promise<NotionRecipeBody> {
  const topLevelBlocks = await listAllBlockChildren(client, pageId)
  const lines = await renderBlocks(client, topLevelBlocks, 0)
  return { pageId, markdown: `${lines.join('\n')}\n` }
}

async function listAllBlockChildren(
  client: Client,
  blockId: string,
): Promise<Array<BlockObjectResponse | PartialBlockObjectResponse>> {
  const blocks: Array<BlockObjectResponse | PartialBlockObjectResponse> = []
  let cursor: string | undefined

  for (;;) {
    const response = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    })
    blocks.push(...response.results)

    // Same defensive termination as fetchRecipeRows' pagination loop.
    if (!response.has_more || !response.next_cursor) break
    cursor = response.next_cursor
  }

  return blocks
}

async function renderBlocks(
  client: Client,
  blocks: Array<BlockObjectResponse | PartialBlockObjectResponse>,
  depth: number,
): Promise<string[]> {
  const lines: string[] = []

  for (const block of blocks) {
    // A partial block (no `type`) carries nothing renderable; skip rather
    // than throw.
    if (!isFullBlock(block)) continue

    lines.push(...renderBlockOwnLines(block))

    // Recurse into children regardless of whether this block's own type is
    // one we render -- an unrecognized container (toggle, callout, column,
    // etc.) may still hold a paragraph or image worth recovering, and losing
    // that would be worse than an unlabeled line of migrated content.
    if (block.has_children && depth < MAX_BLOCK_DEPTH) {
      const children = await listAllBlockChildren(client, block.id)
      lines.push(...(await renderBlocks(client, children, depth + 1)))
    }
  }

  return lines
}

/**
 * Renders a block's own text -- as opposed to its children, which `renderBlocks`
 * recurses into separately regardless of what happens here.
 *
 * Every case below is a block type that carries its own `rich_text` (or, for
 * `table_row`, the closest equivalent: a grid of rich_text cells). The
 * `default` case is the important one: rather than silently dropping a block
 * type this function has no case for, it looks for a `rich_text` array on the
 * block's payload and renders it the same way a paragraph would. New Notion
 * block types appear over time (this SDK version alone added `heading_4` and
 * `meeting_notes` since the union was first handled here); a block this
 * function has never seen still gets its text recovered rather than dropped.
 */
// Exported for tests/notion/render.test.ts, which drives the real renderer
// with constructed block objects -- no Client, no network -- rather than
// against hand-captured markdown fixtures that could silently drift from
// what the renderer actually produces.
export function renderBlockOwnLines(block: BlockObjectResponse): string[] {
  switch (block.type) {
    case 'heading_1':
      return [`# ${richTextToMarkdown(block.heading_1.rich_text)}`]
    case 'heading_2':
      return [`## ${richTextToMarkdown(block.heading_2.rich_text)}`]
    case 'heading_3':
      return [`### ${richTextToMarkdown(block.heading_3.rich_text)}`]
    case 'heading_4':
      return [`#### ${richTextToMarkdown(block.heading_4.rich_text)}`]
    case 'paragraph':
      return [richTextToMarkdown(block.paragraph.rich_text)]
    case 'bulleted_list_item':
      return [`- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}`]
    case 'numbered_list_item':
      return [`1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}`]
    // A checkbox ingredient list is ordinary Notion authoring for a
    // hand-typed recipe -- rendered as a bullet so it parses the same way a
    // `bulleted_list_item` does downstream; checked/unchecked state carries
    // no meaning for recipe recovery and is deliberately dropped.
    case 'to_do':
      return [`- ${richTextToMarkdown(block.to_do.rich_text)}`]
    // A toggle's own text is its (always-visible) summary line; its
    // children -- rendered separately by the caller -- are whatever was
    // nested inside it.
    case 'toggle':
      return [richTextToMarkdown(block.toggle.rich_text)]
    case 'callout':
      return [richTextToMarkdown(block.callout.rich_text)]
    case 'quote':
      return [`> ${richTextToMarkdown(block.quote.rich_text)}`]
    case 'image':
      return [`![](${imageUrl(block.image)})`]
    case 'code':
      return renderCodeBlock(block)
    // What Notion's own Web Clipper writes for a clipped source URL -- the
    // one place `findSourceUrlInBody` looks for a URL a row's `Link`
    // property doesn't have. Emitted as a bare-URL line first (so that
    // search still matches it) with any caption on its own line after, so a
    // caption never turns the URL line into something search would miss.
    case 'bookmark':
      return renderUrlBlock(block.bookmark)
    case 'embed':
      return renderUrlBlock(block.embed)
    case 'link_preview':
      return renderUrlBlock(block.link_preview)
    // Rows arrive as children of the `table` block (which itself carries no
    // rich_text and falls through to the generic default below, correctly
    // emitting nothing on its own). Each row is rendered as one bullet line
    // with cells joined by " | " rather than as `| a | b |` markdown table
    // syntax: `body.ts` has no table-syntax parser, and a bullet line is
    // exactly what its existing list-item handling (`stripListMarker`,
    // ingredient/step parsing) already knows how to consume without any new
    // parsing logic added on that side.
    case 'table_row':
      return [`- ${block.table_row.cells.map((cell) => richTextToMarkdown(cell)).join(' | ')}`]
    default:
      return renderGenericRichText(block)
  }
}

/**
 * The fallback for any block type not given an explicit case above --
 * including ones that don't exist yet. If the block's own payload has a
 * `rich_text` array, it's rendered exactly as a paragraph would be; if not
 * (a `divider`, a `table`, a `column_list`), nothing is emitted, matching the
 * old default's behavior. Either way nothing throws, and text is never
 * dropped silently.
 */
function renderGenericRichText(block: BlockObjectResponse): string[] {
  const payload = asRecord((block as unknown as Record<string, unknown>)[block.type])
  const richText = payload?.rich_text
  if (!Array.isArray(richText) || richText.length === 0) return []
  return [richTextToMarkdown(richText as RichTextItemResponse[])]
}

function renderUrlBlock(content: { url: string; caption?: RichTextItemResponse[] }): string[] {
  const lines = [content.url]
  const caption = content.caption ? richTextToMarkdown(content.caption) : ''
  if (caption) lines.push(caption)
  return lines
}

function imageUrl(image: ImageBlockObjectResponse['image']): string {
  return image.type === 'external' ? image.external.url : image.file.url
}

function renderCodeBlock(block: CodeBlockObjectResponse): string[] {
  const language = block.code.language || 'plaintext'
  // Plain concatenation, not richTextToMarkdown: wrapping code content in
  // markdown emphasis would corrupt it.
  const content = block.code.rich_text.map((item) => item.plain_text).join('')
  return [`\`\`\`${language}`, ...content.split('\n'), '```']
}

function richTextToMarkdown(richText: RichTextItemResponse[]): string {
  return mergeAdjacentRichText(richText).map(renderRichTextItem).join('')
}

/**
 * Notion splits `rich_text` at every annotation and edit boundary, so two
 * adjacent runs that share the same formatting ("Dou" then "gh", both bold)
 * are legitimately two array items for one visual word. Rendered
 * independently that produces `**Dou****gh**`; merged first, it produces the
 * single run `**Dough**` that `BOLD_ONLY_RE` in body.ts expects a bolded
 * section-break line to be.
 */
function mergeAdjacentRichText(richText: RichTextItemResponse[]): RichTextItemResponse[] {
  const merged: RichTextItemResponse[] = []
  for (const item of richText) {
    const prev = merged.at(-1)
    if (prev && prev.type === item.type && sameFormatting(prev, item)) {
      merged[merged.length - 1] = { ...prev, plain_text: prev.plain_text + item.plain_text }
    } else {
      merged.push(item)
    }
  }
  return merged
}

/** Only the annotations `renderRichTextItem` actually turns into markdown syntax matter here. */
function sameFormatting(a: RichTextItemResponse, b: RichTextItemResponse): boolean {
  return (
    a.href === b.href &&
    a.annotations.bold === b.annotations.bold &&
    a.annotations.italic === b.annotations.italic &&
    a.annotations.strikethrough === b.annotations.strikethrough &&
    a.annotations.code === b.annotations.code
  )
}

function renderRichTextItem(item: RichTextItemResponse): string {
  let text = item.plain_text
  if (item.annotations.code) text = `\`${text}\``
  if (item.annotations.bold) text = `**${text}**`
  if (item.annotations.italic) text = `_${text}_`
  if (item.annotations.strikethrough) text = `~~${text}~~`
  // `href` is populated for both a plain text link and a mention link, so
  // this is the one place we need to check regardless of the item's type.
  if (item.href) text = `[${text}](${item.href})`
  return text
}
