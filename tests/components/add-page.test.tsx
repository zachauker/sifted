// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import AddRecipePage from '@/app/(app)/add/page'
import { UrlImportForm } from '@/app/(app)/add/url-import-form'
import { ManualEntryForm } from '@/app/(app)/add/manual-entry-form'

afterEach(cleanup)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  push.mockClear()
})

describe('AddRecipePage', () => {
  it('renders both the URL and the hand-entry sections', () => {
    render(<AddRecipePage />)
    expect(screen.getByRole('heading', { name: 'Add a recipe' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Paste a URL' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Enter one by hand' })).toBeInTheDocument()
  })
})

describe('UrlImportForm', () => {
  it('posts the pasted URL to the session-authenticated bridge route, not /api/import directly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/recipes/import') return jsonResponse({ status: 'queued', jobId: 'job-1' }, 202)
      // The polling effect fires an immediate tick regardless of interval
      // length, so this has to answer something sane rather than assume
      // it's never called.
      return jsonResponse({ jobs: [{ id: 'job-1', status: 'running', recipeId: null }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<UrlImportForm pollIntervalMs={100000} maxAttempts={1} />)

    await user.type(screen.getByLabelText('Recipe URL'), 'https://example.com/korma')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/recipes/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://example.com/korma' }),
      }),
    ))
  })

  it('shows progress, then a link to the recipe once the job finishes', async () => {
    let jobsCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/recipes/import' && method === 'POST') {
        return jsonResponse({ status: 'queued', jobId: 'job-1' }, 202)
      }
      if (url === '/api/jobs') {
        jobsCalls += 1
        const done = jobsCalls >= 2
        return jsonResponse({
          jobs: [{ id: 'job-1', status: done ? 'done' : 'running', recipeId: done ? 'recipe-1' : null }],
        })
      }
      if (url === '/api/library-index') {
        return jsonResponse({ entries: [{ id: 'recipe-1', slug: 'chicken-korma' }] })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<UrlImportForm pollIntervalMs={5} maxAttempts={50} />)

    await user.type(screen.getByLabelText('Recipe URL'), 'https://example.com/korma')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Queued…|Importing…/)).toBeInTheDocument()

    const link = await screen.findByRole('link', { name: 'Open it' })
    expect(link).toHaveAttribute('href', '/recipes/chicken-korma')
  })

  it('reports a duplicate plainly, with a link straight to the existing recipe', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'duplicate', jobId: 'job-1', recipeId: 'recipe-9', slug: 'existing-recipe' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<UrlImportForm pollIntervalMs={5} maxAttempts={50} />)

    await user.type(screen.getByLabelText('Recipe URL'), 'https://example.com/korma')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Already in your library/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Open it' })
    expect(link).toHaveAttribute('href', '/recipes/existing-recipe')

    // A duplicate resolves immediately from the POST response — nothing to
    // poll for, since no new job is actually running.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows a plain error and keeps the field usable when the request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const user = userEvent.setup()
    render(<UrlImportForm pollIntervalMs={5} maxAttempts={50} />)

    await user.type(screen.getByLabelText('Recipe URL'), 'https://example.com/korma')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i)
  })
})

describe('ManualEntryForm', () => {
  it('posts the raw title/ingredients/steps text and redirects to the new recipe', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ recipeId: 'recipe-5', slug: 'ham-pot-pie' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ManualEntryForm />)

    await user.type(screen.getByLabelText('Title'), 'Ham Pot Pie')
    await user.type(screen.getByLabelText('Ingredients'), 'leftover ham{enter}pie crust')
    await user.type(screen.getByLabelText('Steps'), 'Assemble.{enter}Bake.')
    await user.click(screen.getByRole('button', { name: 'Save recipe' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/recipes/manual',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'Ham Pot Pie',
          ingredients: 'leftover ham\npie crust',
          steps: 'Assemble.\nBake.',
          claimedTimeMinutes: null,
          servings: null,
        }),
      }),
    ))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/ham-pot-pie'))
  })

  it('keeps the typed recipe on screen and shows an error when the save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const user = userEvent.setup()
    render(<ManualEntryForm />)

    await user.type(screen.getByLabelText('Title'), 'Ham Pot Pie')
    await user.type(screen.getByLabelText('Ingredients'), 'leftover ham')
    await user.click(screen.getByRole('button', { name: 'Save recipe' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was lost/i)
    expect(screen.getByLabelText('Title')).toHaveValue('Ham Pot Pie')
    expect(screen.getByLabelText('Ingredients')).toHaveValue('leftover ham')
    expect(push).not.toHaveBeenCalled()
  })

  it('surfaces a server-side rejection inline without losing typed content', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'something the server rejected' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ManualEntryForm />)

    await user.type(screen.getByLabelText('Title'), 'Ham Pot Pie')
    await user.type(screen.getByLabelText('Ingredients'), 'leftover ham')
    await user.click(screen.getByRole('button', { name: 'Save recipe' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('something the server rejected')
    expect(screen.getByLabelText('Ingredients')).toHaveValue('leftover ham')
    expect(push).not.toHaveBeenCalled()
  })

  // The empty-title case never reaches the network at all: the field is
  // `required`, and the submit handler also guards on a trimmed, non-empty
  // title (whitespace-only would pass HTML's `required` but shouldn't pass
  // this), matching the server's own `z.string().trim().min(1)` in
  // `src/app/api/recipes/manual/route.ts`.
  it('does not submit a whitespace-only title', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ManualEntryForm />)

    const title = screen.getByLabelText('Title') as HTMLInputElement
    await user.type(title, '   ')
    // `type="text"` with `required` still lets whitespace into the field;
    // submitting the form directly bypasses the button's own click handler
    // wiring to prove the component's guard is what's stopping it.
    title.form?.requestSubmit()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
