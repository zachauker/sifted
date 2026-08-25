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
      return jsonResponse({ job: { id: 'job-1', status: 'running', recipeId: null } })
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
      // The poller looks the job up by the id it already knows, not by
      // scanning the list route — see the regression test below for why.
      if (url === '/api/jobs/job-1') {
        jobsCalls += 1
        const done = jobsCalls >= 2
        return jsonResponse({
          job: { id: 'job-1', status: done ? 'done' : 'running', recipeId: done ? 'recipe-1' : null },
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

  it('polls the job it already knows the id of, never the capped-and-unfiltered list route', async () => {
    // Regression for the poller finding its job by scanning `GET /api/jobs`
    // (`listJobs`, capped at the newest 50 rows of every status): during a
    // migration burst the job it's waiting on can fall out of that window,
    // and the poller then runs its full timeout for an import that actually
    // finished. `GET /api/jobs/[id]` (`getJob`) has no window to fall out of.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/recipes/import' && method === 'POST') {
        return jsonResponse({ status: 'queued', jobId: 'job-1' }, 202)
      }
      if (url === '/api/jobs/job-1') {
        return jsonResponse({ job: { id: 'job-1', status: 'done', recipeId: 'recipe-1' } })
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

    await screen.findByRole('link', { name: 'Open it' })

    expect(fetchMock).not.toHaveBeenCalledWith('/api/jobs', expect.anything())
    expect(fetchMock).not.toHaveBeenCalledWith('/api/jobs')
  })

  it('reports a polled duplicate the same way as a synchronous one, with a link to the existing recipe', async () => {
    // `markDuplicate` in `run-import.ts` exists specifically for a
    // shortened/redirecting URL that only resolves to a known recipe
    // *after* the fetch — the synchronous POST response cannot know that
    // yet, so it answers `queued`, and the `duplicate` only shows up later,
    // from the poll. Before this test, the poller collapsed a polled `done`
    // and `duplicate` into the same "Saved." message, telling the user
    // something was saved when nothing was.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/recipes/import' && method === 'POST') {
        return jsonResponse({ status: 'queued', jobId: 'job-1' }, 202)
      }
      if (url === '/api/jobs/job-1') {
        return jsonResponse({ job: { id: 'job-1', status: 'duplicate', recipeId: 'recipe-9' } })
      }
      if (url === '/api/library-index') {
        return jsonResponse({ entries: [{ id: 'recipe-9', slug: 'existing-recipe' }] })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<UrlImportForm pollIntervalMs={5} maxAttempts={50} />)

    await user.type(screen.getByLabelText('Recipe URL'), 'https://example.com/korma')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Already in your library/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Open it' })
    expect(link).toHaveAttribute('href', '/recipes/existing-recipe')

    // Must not claim "Saved." anywhere alongside the duplicate notice.
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument()
  })

  it('does not silently poll to timeout when a done job carries no recipeId', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/recipes/import' && method === 'POST') {
        return jsonResponse({ status: 'queued', jobId: 'job-1' }, 202)
      }
      if (url === '/api/jobs/job-1') {
        return jsonResponse({ job: { id: 'job-1', status: 'done', recipeId: null } })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<UrlImportForm pollIntervalMs={5} maxAttempts={50} />)

    await user.type(screen.getByLabelText('Recipe URL'), 'https://example.com/korma')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Resolves promptly to a visible alert rather than sitting on
    // "Importing…" until `maxAttempts` (60s in production) is exhausted.
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/Still working after a minute/)).not.toBeInTheDocument()
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
