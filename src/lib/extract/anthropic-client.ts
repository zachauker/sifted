import Anthropic from '@anthropic-ai/sdk'
import { COURSE_VALUES, CUISINE_VALUES, INGREDIENT_VALUES, METHOD_VALUES } from '@/lib/taxonomy'
import type { LlmClient } from './llm-types'

const MODEL = 'claude-sonnet-5'

const ENRICH_TOOL: Anthropic.Tool = {
  name: 'emit_enrichment',
  description: 'Return normalized tags, parsed ingredients, and a one-line description.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: ['string', 'null'],
        description: 'One sentence, max 140 characters, describing the dish.',
      },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            facet: { type: 'string', enum: ['course', 'ingredient', 'method', 'cuisine', 'tag'] },
            value: { type: 'string' },
          },
          required: ['facet', 'value'],
        },
      },
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            position: { type: 'integer' },
            quantity: { type: ['number', 'null'] },
            unit: { type: ['string', 'null'] },
            item: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
          },
          required: ['position', 'quantity', 'unit', 'item', 'note'],
        },
      },
    },
    required: ['description', 'tags', 'ingredients'],
  },
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'emit_recipe',
  description: 'Return the recipe found in the page text.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      author: { type: ['string', 'null'] },
      claimedTimeMinutes: { type: ['integer', 'null'] },
      servings: { type: ['integer', 'null'] },
      yieldText: { type: ['string', 'null'] },
      ingredients: { type: 'array', items: { type: 'string' } },
      steps: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'title', 'description', 'author', 'claimedTimeMinutes',
      'servings', 'yieldText', 'ingredients', 'steps',
    ],
  },
}

function vocabularyPrompt(): string {
  return [
    `course: ${COURSE_VALUES.join(', ')}`,
    `ingredient: ${INGREDIENT_VALUES.join(', ')}`,
    `method: ${METHOD_VALUES.join(', ')}`,
    `cuisine: ${CUISINE_VALUES.join(', ')}`,
    'tag: any short lowercase slug for dish types or occasions',
  ].join('\n')
}

async function callTool(
  client: Anthropic,
  tool: Anthropic.Tool,
  prompt: string,
): Promise<unknown> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: prompt }],
  })

  const block = response.content.find((b) => b.type === 'tool_use')
  return block && block.type === 'tool_use' ? block.input : null
}

export function createAnthropicClient(apiKey = process.env.ANTHROPIC_API_KEY): LlmClient {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  const client = new Anthropic({ apiKey })

  return {
    async enrich({ title, ingredientLines, rawTags }) {
      const prompt = [
        `Recipe: ${title}`,
        '',
        'Ingredient lines (use the given index as "position"):',
        ...ingredientLines.map((line, i) => `${i}: ${line}`),
        '',
        `Tags already assigned: ${rawTags.join(', ') || '(none)'}`,
        '',
        'Assign tags using ONLY these facet values:',
        vocabularyPrompt(),
        '',
        'Rules:',
        '- Assign at most one course.',
        '- Omit a facet entirely rather than guessing.',
        '- Parse each ingredient line into quantity (decimal, e.g. 1.5), unit',
        '  (singular: cup, tablespoon, gram, ounce, clove), item, and note',
        '  (preparation such as "sifted" or "finely chopped").',
        '- Use null for any field the line does not specify.',
      ].join('\n')

      return callTool(client, ENRICH_TOOL, prompt)
    },

    async extractRecipe({ url, text }) {
      const prompt = [
        `Extract the recipe from this page. Source: ${url}`,
        '',
        'Return ingredient lines and steps verbatim as written. Do not rewrite,',
        'summarize, renumber, or merge them. Exclude narrative prose, ads, and',
        'commentary. If the page contains no recipe, return an empty title.',
        '',
        '--- PAGE TEXT ---',
        text.slice(0, 60_000),
      ].join('\n')

      return callTool(client, EXTRACT_TOOL, prompt)
    },
  }
}
