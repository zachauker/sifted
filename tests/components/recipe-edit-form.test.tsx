// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { RecipeEditForm, initialEditValues } from '@/components/recipe/recipe-edit-form'
import type { EditFormState } from '@/app/(app)/recipes/[slug]/edit/actions'

afterEach(cleanup)

function recipe(over: Partial<RecipeDetail> = {}): RecipeDetail {
  return {
    id: 'r1',
    slug: 'gochujang-chicken',
    title: 'Slow-Roast Gochujang Chicken',
    sourceUrl: 'https://bonappetit.com/recipe/gochujang-chicken',
    sourceDomain: 'bonappetit.com',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    description: 'A whole chicken.',
    claimedTimeMinutes: 180,
    actualTimeMinutes: null,
    servings: 4,
    yieldText: '4 servings',
    rating: null,
    status: null,
    notes: null,
    narrativeHtml: null,
    extractionMethod: 'jsonld',
    handEdited: false,
    createdAt: new Date('2026-01-01'),
    ingredients: [
      { position: 0, section: 'For the sauce', rawText: '2 Tbsp. gochujang', quantity: null, unit: null, item: null, note: null },
      { position: 1, section: 'For the chicken', rawText: '1 whole chicken', quantity: null, unit: null, item: null, note: null },
    ],
    steps: [{ position: 0, section: null, text: 'Roast low for three hours.' }],
    tags: [
      { facet: 'course', value: 'main' },
      { facet: 'tag', value: 'holiday' },
    ],
    images: [],
    ...over,
  }
}

const noop = async (): Promise<EditFormState> => null

function renderForm(over: Partial<RecipeDetail> = {}) {
  return render(<RecipeEditForm recipe={recipe(over)} action={noop} />)
}

describe('initialEditValues', () => {
  it('renders ingredients back into text with their section headers', () => {
    expect(initialEditValues(recipe()).ingredients).toBe(
      'For the sauce:\n2 Tbsp. gochujang\n\nFor the chicken:\n1 whole chicken',
    )
  })

  it('spells an absent number as an empty box, never as a zero', () => {
    const values = initialEditValues(recipe({ claimedTimeMinutes: null, servings: null }))
    expect(values.claimedTimeMinutes).toBe('')
    expect(values.servings).toBe('')
  })

  it('lists the free-form tags, and only those, in the free-text field', () => {
    expect(initialEditValues(recipe()).freeTags).toBe('holiday')
  })

  it('lists the vocabulary tags as chip ids', () => {
    expect(initialEditValues(recipe()).vocabularyTags).toEqual(['course:main'])
  })
})

describe('RecipeEditForm', () => {
  it('opens with the recipe already in the fields', () => {
    renderForm()

    expect(screen.getByLabelText(/^title$/i)).toHaveValue('Slow-Roast Gochujang Chicken')
    expect(screen.getByLabelText(/publisher/i)).toHaveValue('Bon Appétit')
    expect(screen.getByLabelText(/how long it claims/i)).toHaveValue('180')
    expect(screen.getByLabelText(/ingredients/i)).toHaveValue(
      'For the sauce:\n2 Tbsp. gochujang\n\nFor the chicken:\n1 whole chicken',
    )
  })

  it('checks the chips the recipe already carries and leaves the rest alone', () => {
    renderForm()

    expect(screen.getByRole('checkbox', { name: 'main' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'dessert' })).not.toBeChecked()
  })

  it('groups the chips by facet so the vocabulary is visible', () => {
    renderForm()

    for (const legend of ['Course', 'Ingredient', 'Method', 'Cuisine']) {
      expect(screen.getByRole('group', { name: legend })).toBeInTheDocument()
    }
  })

  it('offers a way back that does not save', () => {
    renderForm()
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute(
      'href',
      '/recipes/gochujang-chicken',
    )
  })

  it('has no field for the narrative — that is not editable here', () => {
    renderForm()
    expect(screen.queryByLabelText(/narrative/i)).not.toBeInTheDocument()
  })

  it('renders an empty recipe without inventing content', () => {
    renderForm({ ingredients: [], steps: [], tags: [], description: null })

    expect(screen.getByLabelText(/ingredients/i)).toHaveValue('')
    expect(screen.getByLabelText(/steps/i)).toHaveValue('')
  })
})

describe('RecipeEditForm, after a rejected save', () => {
  // `useActionState` returns the initial state on first render, so the
  // rejected-state rendering is asserted through the same path the action
  // returns: a state whose values differ from the recipe's stored ones.
  it('shows a field error and keeps what was typed', async () => {
    const rejected: EditFormState = {
      message: '',
      fieldErrors: { title: 'A title is required.' },
      values: { ...initialEditValues(recipe()), title: '', steps: 'Do not lose me.' },
    }
    const action = vi.fn(async () => rejected)

    render(<RecipeEditForm recipe={recipe()} action={action} initialState={rejected} />)

    expect(screen.getByText('A title is required.')).toBeInTheDocument()
    expect(screen.getByLabelText(/^steps$/i)).toHaveValue('Do not lose me.')
  })

  it('shows a whole-form message when there is one', () => {
    const rejected: EditFormState = {
      message: 'That recipe is no longer in the library.',
      fieldErrors: {},
      values: initialEditValues(recipe()),
    }

    render(<RecipeEditForm recipe={recipe()} action={noop} initialState={rejected} />)

    expect(screen.getByRole('alert')).toHaveTextContent('no longer in the library')
  })
})
