import { describe, it, expect, vi } from 'vitest'
import type { BlockObjectResponse, RichTextItemResponse } from '@notionhq/client'
import { renderBlockOwnLines } from '@/lib/notion/client'
import { fromNotionBody, findSourceUrlInBody } from '@/lib/notion/body'
import type { NotionRecipeRow, NotionRecipeBody } from '@/lib/notion/types'
import type { LlmClient } from '@/lib/extract/llm-types'
import structured from './fixtures/body-structured.json'
import unstructured from './fixtures/body-unstructured.json'

/**
 * This is the seam that had no test at all before this file: `client.ts`'s
 * renderer and `body.ts`'s parser were written independently, and only
 * hand-captured markdown fixtures connected them. Every test below drives
 * the *real* `renderBlockOwnLines` with constructed `BlockObjectResponse`
 * objects -- no Client, no network, no mocked HTTP layer, since a block's own
 * text never depends on either.
 */

// ---------------------------------------------------------------------------
// Block / rich-text builders
// ---------------------------------------------------------------------------

let blockCounter = 0

/** The boilerplate every `BlockObjectResponse` variant carries, regardless of type. */
function base() {
  blockCounter += 1
  return {
    object: 'block' as const,
    id: `block-${blockCounter}`,
    created_time: '2020-01-01T00:00:00.000Z',
    created_by: { object: 'user' as const, id: 'user-1' },
    last_edited_time: '2020-01-01T00:00:00.000Z',
    last_edited_by: { object: 'user' as const, id: 'user-1' },
    has_children: false,
    in_trash: false,
    archived: false,
    parent: { type: 'page_id' as const, page_id: 'page-1' },
  }
}

type RtOpts = Partial<{
  bold: boolean
  italic: boolean
  strikethrough: boolean
  code: boolean
  underline: boolean
  href: string | null
}>

function rt(text: string, opts: RtOpts = {}): RichTextItemResponse {
  return {
    type: 'text',
    text: { content: text, link: opts.href ? { url: opts.href } : null },
    annotations: {
      bold: opts.bold ?? false,
      italic: opts.italic ?? false,
      strikethrough: opts.strikethrough ?? false,
      underline: opts.underline ?? false,
      code: opts.code ?? false,
      color: 'default',
    },
    plain_text: text,
    href: opts.href ?? null,
  } as RichTextItemResponse
}

function heading2(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'heading_2',
    heading_2: { rich_text: [rt(text)], color: 'default', is_toggleable: false },
  } as BlockObjectResponse
}

function heading3(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'heading_3',
    heading_3: { rich_text: [rt(text)], color: 'default', is_toggleable: false },
  } as BlockObjectResponse
}

function heading4(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'heading_4',
    heading_4: { rich_text: [rt(text)], color: 'default', is_toggleable: false },
  } as BlockObjectResponse
}

function paragraph(richText: RichTextItemResponse[]): BlockObjectResponse {
  return {
    ...base(),
    type: 'paragraph',
    paragraph: { rich_text: richText, color: 'default' },
  } as BlockObjectResponse
}

function para(text: string): BlockObjectResponse {
  return paragraph(text ? [rt(text)] : [])
}

function bulleted(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [rt(text)], color: 'default' },
  } as BlockObjectResponse
}

function toDo(text: string, checked = false): BlockObjectResponse {
  return {
    ...base(),
    type: 'to_do',
    to_do: { rich_text: [rt(text)], color: 'default', checked },
  } as BlockObjectResponse
}

function toggle(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'toggle',
    toggle: { rich_text: [rt(text)], color: 'default' },
  } as BlockObjectResponse
}

function callout(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'callout',
    callout: { rich_text: [rt(text)], color: 'default', icon: null },
  } as BlockObjectResponse
}

function quote(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'quote',
    quote: { rich_text: [rt(text)], color: 'default' },
  } as BlockObjectResponse
}

function image(url: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'image',
    image: { type: 'external', external: { url }, caption: [] },
  } as BlockObjectResponse
}

function bookmark(url: string, caption: RichTextItemResponse[] = []): BlockObjectResponse {
  return { ...base(), type: 'bookmark', bookmark: { url, caption } } as BlockObjectResponse
}

function embed(url: string, caption: RichTextItemResponse[] = []): BlockObjectResponse {
  return { ...base(), type: 'embed', embed: { url, caption } } as BlockObjectResponse
}

function linkPreview(url: string): BlockObjectResponse {
  return { ...base(), type: 'link_preview', link_preview: { url } } as BlockObjectResponse
}

function table(): BlockObjectResponse {
  return {
    ...base(),
    type: 'table',
    table: { has_column_header: false, has_row_header: false, table_width: 2 },
    has_children: true,
  } as BlockObjectResponse
}

function tableRow(cellTexts: string[]): BlockObjectResponse {
  return {
    ...base(),
    type: 'table_row',
    table_row: { cells: cellTexts.map((text) => [rt(text)]) },
  } as BlockObjectResponse
}

/** A block type this SDK has never heard of, carrying its own rich_text. */
function futureBlock(text: string): BlockObjectResponse {
  return {
    ...base(),
    type: 'super_duper_block',
    super_duper_block: { rich_text: [rt(text)], color: 'default' },
  } as unknown as BlockObjectResponse
}

/** A block type carrying no text at all -- the divider/table case. */
function divider(): BlockObjectResponse {
  return { ...base(), type: 'divider', divider: {} } as BlockObjectResponse
}

function render(blocks: BlockObjectResponse[]): string {
  return `${blocks.flatMap(renderBlockOwnLines).join('\n')}\n`
}

// ---------------------------------------------------------------------------
// fromNotionBody test scaffolding, matching tests/notion/body.test.ts
// ---------------------------------------------------------------------------

const row = (over: Partial<NotionRecipeRow> = {}): NotionRecipeRow => ({
  pageId: 'p1',
  title: 'Test Recipe',
  link: null,
  publisher: null,
  author: null,
  rating: null,
  cookingStatus: null,
  tags: [],
  createdTime: '2022-01-01T00:00:00.000Z',
  ...over,
})

const noLlm = (): LlmClient => ({
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
})

const bodyFrom = (blocks: BlockObjectResponse[]): NotionRecipeBody => ({
  pageId: 'p1',
  markdown: render(blocks),
})

// ---------------------------------------------------------------------------
// Each newly handled block type produces its own text
// ---------------------------------------------------------------------------

describe('renderBlockOwnLines — newly handled block types', () => {
  it('renders heading_4 as a level-4 markdown heading', () => {
    expect(renderBlockOwnLines(heading4('For the dough'))).toEqual(['#### For the dough'])
  })

  it('renders to_do as a bullet, dropping the checked state', () => {
    expect(renderBlockOwnLines(toDo('1 lb potatoes', true))).toEqual(['- 1 lb potatoes'])
    expect(renderBlockOwnLines(toDo('1 lb potatoes', false))).toEqual(['- 1 lb potatoes'])
  })

  it('renders toggle as its summary line', () => {
    expect(renderBlockOwnLines(toggle('1 lb potatoes'))).toEqual(['1 lb potatoes'])
  })

  it('renders callout as a plain text line', () => {
    expect(renderBlockOwnLines(callout('Use bread flour, not all-purpose.'))).toEqual([
      'Use bread flour, not all-purpose.',
    ])
  })

  it('renders quote as a blockquote line (already handled, still correct)', () => {
    expect(renderBlockOwnLines(quote('4 cups flour'))).toEqual(['> 4 cups flour'])
  })

  it('renders a bookmark as a bare URL line', () => {
    expect(renderBlockOwnLines(bookmark('https://example.com/recipe'))).toEqual([
      'https://example.com/recipe',
    ])
  })

  it('renders a bookmark caption on its own line, after the bare URL', () => {
    expect(renderBlockOwnLines(bookmark('https://example.com/recipe', [rt('Original source')]))).toEqual([
      'https://example.com/recipe',
      'Original source',
    ])
  })

  it('renders an embed as a bare URL line', () => {
    expect(renderBlockOwnLines(embed('https://example.com/video'))).toEqual([
      'https://example.com/video',
    ])
  })

  it('renders a link_preview as a bare URL line', () => {
    expect(renderBlockOwnLines(linkPreview('https://example.com/preview'))).toEqual([
      'https://example.com/preview',
    ])
  })

  it('renders a table_row as one bullet line, cells joined by " | "', () => {
    expect(renderBlockOwnLines(tableRow(['Ingredient', 'Amount']))).toEqual(['- Ingredient | Amount'])
    expect(renderBlockOwnLines(tableRow(['Flour', '4 cups']))).toEqual(['- Flour | 4 cups'])
  })

  it('renders a table itself as nothing -- its rows carry the text, via recursion into children', () => {
    expect(renderBlockOwnLines(table())).toEqual([])
  })

  it('renders a block type with no rich_text as nothing, same as before', () => {
    expect(renderBlockOwnLines(divider())).toEqual([])
  })

  // The structural fix: an unrecognized block type is no longer a silent
  // drop. `super_duper_block` does not exist in the SDK's union -- this is
  // exactly the shape a *future* Notion block type would have.
  it('renders an unknown block type by finding its rich_text generically', () => {
    expect(renderBlockOwnLines(futureBlock('New block type text'))).toEqual(['New block type text'])
  })
})

// ---------------------------------------------------------------------------
// The regressions from the defect table, reproduced and now fixed
// ---------------------------------------------------------------------------

describe('renderBlockOwnLines — defects from the review', () => {
  it('no longer loses a to_do list under a heading', () => {
    const blocks = [heading2('Ingredients'), toDo('2 lb potatoes'), toDo('1 onion')]
    expect(render(blocks)).toBe('## Ingredients\n- 2 lb potatoes\n- 1 onion\n')
  })

  it('no longer loses a toggle under a heading', () => {
    const blocks = [heading2('Ingredients'), toggle('1 lb potatoes')]
    expect(render(blocks)).toBe('## Ingredients\n1 lb potatoes\n')
  })

  it('no longer loses a callout', () => {
    expect(render([callout('Use bread flour, not all-purpose.')])).toBe(
      'Use bread flour, not all-purpose.\n',
    )
  })

  it('no longer loses a bookmark', () => {
    expect(render([bookmark('https://example.com/recipe')])).toBe('https://example.com/recipe\n')
  })

  it('no longer loses a table', () => {
    const blocks = [table(), tableRow(['Ingredient', 'Amount']), tableRow(['Flour', '4 cups'])]
    expect(render(blocks)).toBe('- Ingredient | Amount\n- Flour | 4 cups\n')
  })

  it('no longer loses a fourth-level sub-section', () => {
    const blocks = [heading2('Ingredients'), heading4('For the dough'), bulleted('4 cups flour')]
    expect(render(blocks)).toBe('## Ingredients\n#### For the dough\n- 4 cups flour\n')
  })
})

// ---------------------------------------------------------------------------
// The renderer feeding the parser -- the actual seam this file exists for
// ---------------------------------------------------------------------------

describe('renderer -> parser: to_do under an ingredients heading', () => {
  it('round-trips a checkbox ingredient list into ingredients', async () => {
    const body = bodyFrom([
      heading2('Ingredients'),
      toDo('2 lb potatoes', true),
      toDo('1 onion', false),
      toDo('1 tsp salt'),
    ])
    const r = (await fromNotionBody(row(), body, noLlm()))!
    expect(r).not.toBeNull()
    expect(r.ingredients.map((i) => i.rawText)).toEqual(['2 lb potatoes', '1 onion', '1 tsp salt'])
  })
})

describe('renderer -> parser: bookmark as a recoverable source url', () => {
  it('is findable by findSourceUrlInBody even though the row has no Link property', () => {
    const body = bodyFrom([
      bookmark('https://example.com/recipe'),
      heading2('Ingredients'),
      bulleted('1 cup flour'),
    ])
    expect(findSourceUrlInBody(body)).toBe('https://example.com/recipe')
  })
})

describe('renderer -> parser: heading_4 as a section', () => {
  it('becomes the ingredient section, the way heading_3 already does', async () => {
    const body = bodyFrom([
      heading2('Ingredients'),
      heading4('For the dough'),
      bulleted('4 cups flour'),
      bulleted('1 cup water'),
    ])
    const r = (await fromNotionBody(row(), body, noLlm()))!
    expect(r.ingredients.map((i) => i.section)).toEqual(['For the dough', 'For the dough'])
  })
})

describe('renderer -> parser: a quote line does not keep its marker', () => {
  it('strips the `>` so rawText matches the ingredient content only', async () => {
    const body = bodyFrom([heading2('Ingredients'), quote('4 cups flour')])
    const r = (await fromNotionBody(row(), body, noLlm()))!
    expect(r.ingredients[0].rawText).toBe('4 cups flour')
    expect(r.ingredients[0].rawText).not.toContain('>')
  })
})

describe('renderer -> parser: adjacent bold runs merge into one section name', () => {
  it('does not split "Dough" into "Dou****gh" across the annotation boundary', async () => {
    // Notion splits rich_text at every annotation/edit boundary -- two
    // adjacent bold runs for what a human typed as one bolded word.
    const body = bodyFrom([
      para('Ham'),
      paragraph([rt('Dou', { bold: true }), rt('gh', { bold: true })]),
      para('4 cups flour'),
    ])
    const r = (await fromNotionBody(row(), body, noLlm()))!
    const flour = r.ingredients.find((i) => i.rawText === '4 cups flour')!
    expect(flour.section).toBe('Dough')
  })

  it('does not merge across an annotation boundary that actually differs', () => {
    const merged = paragraph([rt('Dou', { bold: true }), rt('gh', { bold: false })])
    expect(renderBlockOwnLines(merged)).toEqual(['**Dou**gh'])
  })

  it('does not merge across a boundary where only the href differs', () => {
    const merged = paragraph([
      rt('one', { href: 'https://a.example' }),
      rt('two', { href: 'https://b.example' }),
    ])
    expect(renderBlockOwnLines(merged)).toEqual(['[one](https://a.example)[two](https://b.example)'])
  })
})

// ---------------------------------------------------------------------------
// The two committed fixtures still round-trip byte-for-byte through the
// renderer. Both are flat (no nested block children), so calling
// renderBlockOwnLines directly on each top-level block and joining is exactly
// what fetchPageBody's renderBlocks does for a page shaped like these.
// ---------------------------------------------------------------------------

describe('fixture round-trip: body-structured.json', () => {
  it('reconstructs byte-for-byte from constructed blocks', () => {
    const TAMALE_URL = 'https://www.finecooking.com/recipe/cast-iron-green-chile-tamale-pie'
    const SALSA_URL = 'https://www.finecooking.com/recipe/cooked-tomatillo-salsa'

    const blocks: BlockObjectResponse[] = [
      paragraph([rt(TAMALE_URL, { href: TAMALE_URL })]),
      para(''),
      image('https://prod-files-secure.s3.us-west-2.amazonaws.com/expired/tamale-beef-pie_wide-scaled.jpg'),
      para(
        'Tamale pie owes its name to the rich layer of cornbread that sits on top of its ground beef filling, mimicking masa-wrapped, meat-filled tamales. This Southwest spin on the dish favors green chiles and tangy, tomatillo-spiked salsa verde in lieu of more traditionally used canned tomatoes',
      ),
      heading2('Ingredients'),
      heading3('For the filling'),
      bulleted('1 lb. 85% lean ground beef'),
      bulleted('1 medium zucchini, chopped'),
      bulleted('1/2 medium yellow onion, chopped'),
      bulleted('1 Tbs. chili powder'),
      bulleted_with_link(),
      bulleted('1/2 cup cooked black or pinto beans'),
      bulleted('1/2 cup fresh or thawed frozen yellow corn kernels'),
      bulleted('1 4-oz. can mild or spicy chopped green chiles (undrained)'),
      bulleted('Kosher salt'),
      heading3('For the cornbread topping'),
      bulleted('1 cup stone-ground yellow cornmeal'),
      bulleted('1/4 cup all-purpose flour'),
      bulleted('1 Tbs. sugar'),
      bulleted('1 tsp. baking powder'),
      bulleted('1 tsp. kosher salt'),
      bulleted('1/2 tsp. baking soda'),
      bulleted('1 cup buttermilk'),
      bulleted('3 Tbs. unsalted butter, melted'),
      bulleted('1 Tbs. chopped fresh cilantro leaves; more for garnish'),
      bulleted('1 large egg'),
      bulleted('1 cup shredded Monterey Jack or pepper Jack cheese'),
      bulleted('Sour cream and avocado slices, for serving'),
      heading2('Preparation'),
      heading3('Make the filling'),
      para(
        'Preheat the oven to 400°F. In a 10-inch deep cast-iron skillet, cook the beef over medium-high heat until browned, breaking it into pieces with a wooden spoon, 6 to 8 minutes. Add the zucchini, onion, and chili powder, reduce heat to medium, and cook, stirring occasionally, until softened, about 5 minutes. Stir in the salsa, beans, corn, green chiles, and salt. Remove from the heat.',
      ),
      heading3('Make the cornbread topping'),
      para(
        'In a medium bowl, whisk together the cornmeal, flour, sugar, baking powder, salt, and baking soda, and set aside.',
      ),
      para(
        'In another medium bowl, whisk together the buttermilk, butter, cilantro, and egg. Add the wet ingredients to the dry ingredients, and stir just until combined.',
      ),
      para(
        'Scatter half of the cheese over the beef mixture in the skillet, then pour the cornbread batter over and spread to the edges. Sprinkle with the remaining cheese. Bake until cornbread is cooked through and golden brown, about 25 minutes. Serve with additional salsa, sour cream, and avocado slices. Garnish with cilantro.',
      ),
    ]

    function bulleted_with_link(): BlockObjectResponse {
      return {
        ...base(),
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            rt('1 cup mild or spicy salsa verde ('),
            rt('homemade', { href: SALSA_URL }),
            rt(' or storebought); more for serving'),
          ],
          color: 'default',
        },
      } as BlockObjectResponse
    }

    expect(render(blocks)).toBe((structured as NotionRecipeBody).markdown)
  })
})

describe('fixture round-trip: body-unstructured.json', () => {
  it('reconstructs byte-for-byte from constructed blocks', () => {
    const blocks: BlockObjectResponse[] = [
      image('https://prod-files-secure.s3.us-west-2.amazonaws.com/expired/Untitled.png'),
      para('Ham'),
      para('Ham base'),
      para('1 lb potatoes '),
      para('2 carrots'),
      para('1 onion'),
      para('3 celery stalks'),
      para('Garlic '),
      para('8 cups water'),
      paragraph([rt('Dough', { bold: true })]),
      para('4 cups flour'),
      para('4 TBS crisco'),
      para('1 1/3 cup water'),
    ]

    expect(render(blocks)).toBe((unstructured as NotionRecipeBody).markdown)
  })
})
