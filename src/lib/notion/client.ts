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

function renderBlockOwnLines(block: BlockObjectResponse): string[] {
  switch (block.type) {
    case 'heading_1':
      return [`# ${richTextToMarkdown(block.heading_1.rich_text)}`]
    case 'heading_2':
      return [`## ${richTextToMarkdown(block.heading_2.rich_text)}`]
    case 'heading_3':
      return [`### ${richTextToMarkdown(block.heading_3.rich_text)}`]
    case 'paragraph':
      return [richTextToMarkdown(block.paragraph.rich_text)]
    case 'bulleted_list_item':
      return [`- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}`]
    case 'numbered_list_item':
      return [`1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}`]
    case 'quote':
      return [`> ${richTextToMarkdown(block.quote.rich_text)}`]
    case 'image':
      return [`![](${imageUrl(block.image)})`]
    case 'code':
      return renderCodeBlock(block)
    default:
      // Unknown block type -- ignored rather than throwing. Its children,
      // if any, are still recursed into by the caller.
      return []
  }
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
  return richText.map(renderRichTextItem).join('')
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
