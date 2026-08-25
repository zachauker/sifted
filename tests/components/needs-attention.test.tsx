// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { NeedsAttentionTray } from '@/components/jobs/needs-attention-tray'
import type { Job } from '@/components/jobs/types'

afterEach(cleanup)

let counter = 0
function job(overrides: Partial<Job> = {}): Job {
  counter += 1
  return {
    id: `job-${counter}`,
    url: `https://example.com/recipe-${counter}`,
    status: 'failed',
    failureKind: 'fetch_failed',
    error: null,
    recipeId: null,
    requestedBy: null,
    createdAt: new Date(counter),
    finishedAt: new Date(counter),
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ status: 'queued' }), { status: 202 })),
  )
})

describe('the needs-attention tray', () => {
  it('lists failed jobs with their URL and a plain-English reason', () => {
    render(
      <NeedsAttentionTray
        jobs={[job({ url: 'https://allrecipes.com/korma', failureKind: 'blocked' })]}
      />,
    )
    expect(screen.getByText('https://allrecipes.com/korma')).toBeInTheDocument()
    expect(screen.getByText('Blocked by the publisher')).toBeInTheDocument()
    expect(screen.getByText(/won't let our server open this page/)).toBeInTheDocument()
  })

  it('says so plainly when the tray is empty', () => {
    render(<NeedsAttentionTray jobs={[]} />)
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
  })

  describe('each failureKind gets its own explanation and call to action', () => {
    it('blocked: offers the paste-HTML form, not a plain retry', () => {
      render(<NeedsAttentionTray jobs={[job({ failureKind: 'blocked' })]} />)
      expect(screen.getByText('Blocked by the publisher')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Paste the page source here')).toBeInTheDocument()
      expect(screen.getByText('Retry with pasted HTML')).toBeInTheDocument()
      // No bare "Retry" button alongside the paste form for this kind.
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    })

    it('fetch_failed: offers a plain retry', () => {
      render(<NeedsAttentionTray jobs={[job({ failureKind: 'fetch_failed' })]} />)
      expect(screen.getByText("Couldn't reach the page")).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('Paste the page source here')).not.toBeInTheDocument()
    })

    it('llm_failed: offers a retry hinting to try again in a bit', () => {
      render(<NeedsAttentionTray jobs={[job({ failureKind: 'llm_failed' })]} />)
      expect(screen.getByText('Recipe reader was unavailable')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Try again in a bit' })).toBeInTheDocument()
    })

    it('no_recipe: explains why, and offers removal instead of a retry', () => {
      render(<NeedsAttentionTray jobs={[job({ failureKind: 'no_recipe' })]} />)
      expect(screen.getByText('No recipe on this page')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Remove from this list' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
    })

    it('internal: offers a retry and shows the error text', () => {
      render(
        <NeedsAttentionTray
          jobs={[job({ failureKind: 'internal', error: 'TypeError: cannot read x' })]}
        />,
      )
      expect(screen.getByText('Something went wrong on our end')).toBeInTheDocument()
      expect(screen.getByText(/TypeError: cannot read x/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })
  })

  it('a no_recipe job offers no retry button', () => {
    render(<NeedsAttentionTray jobs={[job({ failureKind: 'no_recipe' })]} />)
    expect(screen.queryByRole('button', { name: /^retry/i })).not.toBeInTheDocument()
  })

  it('a running job shows as in progress and offers no retry', () => {
    render(<NeedsAttentionTray jobs={[job({ status: 'running', failureKind: null, error: null })]} />)
    expect(screen.getByText('In progress')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  // `done` and `duplicate` jobs never reach this component: the tray is fed
  // by `listJobsNeedingAttention` (`src/lib/db/queries/jobs.ts`), which
  // selects only `failed` / `running` / `queued` at the database layer.
  // That is where "does a job need attention" is decided and tested (see
  // `tests/db/jobs.test.ts`) — re-filtering `done`/`duplicate` here as well
  // would encode the same rule a second time, free to drift from the one
  // that actually enforces it.

  it('pasting HTML and retrying calls the retry endpoint with that HTML in the body', async () => {
    const user = userEvent.setup()
    render(
      <NeedsAttentionTray
        jobs={[job({ id: 'job-blocked', url: 'https://allrecipes.com/korma', failureKind: 'blocked' })]}
      />,
    )

    const textarea = screen.getByPlaceholderText('Paste the page source here')
    fireEvent.change(textarea, { target: { value: '<html>pasted content</html>' } })

    await user.click(screen.getByText('Retry with pasted HTML'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/jobs/job-blocked/retry',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html: '<html>pasted content</html>' }),
      }),
    )
    expect(await screen.findByText(/Retry sent/)).toBeInTheDocument()
  })

  it('a plain retry posts with no body', async () => {
    const user = userEvent.setup()
    render(<NeedsAttentionTray jobs={[job({ id: 'job-ff', failureKind: 'fetch_failed' })]} />)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(fetch).toHaveBeenCalledWith('/api/jobs/job-ff/retry', { method: 'POST' })
    expect(await screen.findByText(/Retry sent/)).toBeInTheDocument()
  })

  it('shows an inline error, and keeps the pasted text, when the server rejects the retry as too large', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'html too large' }), { status: 413 })),
    )
    const user = userEvent.setup()
    render(<NeedsAttentionTray jobs={[job({ id: 'job-blocked', failureKind: 'blocked' })]} />)

    const textarea = screen.getByPlaceholderText('Paste the page source here') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'some html' } })
    await user.click(screen.getByText('Retry with pasted HTML'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/)
    expect(textarea.value).toBe('some html')
  })

  it('removing a no_recipe job hides it from the list', async () => {
    const user = userEvent.setup()
    render(
      <NeedsAttentionTray
        jobs={[job({ url: 'https://example.com/blank', failureKind: 'no_recipe' })]}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Remove from this list' }))
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
  })

  it('a queued job shows as queued, not failed, and offers a retry', () => {
    render(<NeedsAttentionTray jobs={[job({ status: 'queued', failureKind: null, error: null })]} />)
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
