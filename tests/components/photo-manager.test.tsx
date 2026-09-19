// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { DetailImage } from '@/lib/db/queries/recipe-detail'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'
import { PhotoManager } from '@/components/recipe/photo-manager'

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

function photo(id: string, overrides: Partial<DetailImage> = {}): DetailImage {
  return {
    id,
    role: 'user',
    isCover: false,
    blobUrl: `https://blob.example.com/${id}.webp`,
    thumbUrl: `https://blob.example.com/${id}-thumb.webp`,
    width: 1600,
    height: 1200,
    ...overrides,
  }
}

const HERO = photo('hero', { role: 'source_hero' })
const MINE = photo('mine')

// Typed with both parameters so `mockImplementation((url, init) => …)` below
// typechecks — `tsc` covers `tests/` too.
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderManager(photos: DetailImage[] = [HERO, MINE], coverId: string | null = 'hero') {
  return render(<PhotoManager recipeId="r1" photos={photos} coverId={coverId} />)
}

function item(index: number) {
  return within(screen.getByRole('list', { name: 'Photos' })).getAllByRole('listitem')[index]
}

describe('PhotoManager', () => {
  it('marks the cover and offers every other photo as the cover', () => {
    renderManager()
    expect(within(item(0)).getByText('Cover')).toBeInTheDocument()
    expect(within(item(0)).queryByRole('button', { name: 'Make cover' })).not.toBeInTheDocument()
    expect(within(item(1)).getByRole('button', { name: 'Make cover' })).toBeInTheDocument()
  })

  it('shows a placeholder, not a broken image, for a photo with no stored URL', () => {
    renderManager([photo('legacy', { blobUrl: null, thumbUrl: null })], null)
    expect(within(item(0)).getByText('No preview')).toBeInTheDocument()
    expect(item(0).querySelector('img')).toBeNull()
  })

  it('offers no Make cover button for a photo missing either stored URL', () => {
    // Both cover-rule implementations skip a row unless it has both URLs, so
    // a click here would silently change nothing — see `isRenderable` in
    // `@/lib/images/cover`.
    renderManager(
      [HERO, photo('no-thumb', { thumbUrl: null }), photo('no-full', { blobUrl: null })],
      'hero',
    )
    expect(within(item(1)).queryByRole('button', { name: 'Make cover' })).not.toBeInTheDocument()
    expect(within(item(2)).queryByRole('button', { name: 'Make cover' })).not.toBeInTheDocument()
  })

  it('makes a photo the cover and refreshes', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }))
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Make cover' }))

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1/images/mine', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ cover: true }),
    }))
  })

  it('says so when the cover could not be changed', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"not_found"}', { status: 404 }))
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Make cover' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t make that the cover.')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('asks before deleting, and Cancel sends nothing', async () => {
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete' }))
    expect(within(item(1)).getByText('Delete this photo?')).toBeInTheDocument()
    await userEvent.click(within(item(1)).getByRole('button', { name: 'Cancel' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(within(item(1)).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('deletes after confirmation and refreshes', async () => {
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete photo' }))

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1/images/mine', expect.objectContaining({ method: 'DELETE' }))
  })

  it('warns that a deleted publisher photo will not come back on re-import', async () => {
    renderManager()
    await userEvent.click(within(item(0)).getByRole('button', { name: 'Delete' }))
    expect(within(item(0)).getByText(/Re-importing this recipe won’t bring it back/)).toBeInTheDocument()
  })

  it('says the photo is still there when storage refused the delete', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"storage_failed"}', { status: 502 }))
    renderManager()

    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(item(1)).getByRole('button', { name: 'Delete photo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('it’s still here')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('renders "Add photos" as the last tile inside the Photos grid, not outside it', () => {
    renderManager()
    const list = screen.getByRole('list', { name: 'Photos' })
    const items = within(list).getAllByRole('listitem')
    expect(within(items[items.length - 1]).getByText('Add photos')).toBeInTheDocument()
  })

  it('accepts only formats the server can read', () => {
    renderManager()
    expect(screen.getByLabelText('Add photos')).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp')
    expect(screen.getByLabelText('Add photos')).toHaveAttribute('multiple')
  })

  it('uploads each chosen file in its own request, one after another', async () => {
    const order: string[] = []
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const file = (init!.body as FormData).get('file') as File
      order.push(`start ${file.name}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end ${file.name}`)
      return Response.json({ photo: photo(file.name) }, { status: 201 })
    })
    renderManager()

    await userEvent.upload(screen.getByLabelText('Add photos'), [
      new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' }),
    ])

    await waitFor(() => expect(order).toEqual(['start a.jpg', 'end a.jpg', 'start b.jpg', 'end b.jpg']))
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1/images', expect.objectContaining({ method: 'POST' }))
    for (const [, init] of fetchMock.mock.calls) {
      expect([...(init!.body as FormData).keys()]).toEqual(['file'])
    }
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
  })

  it('refuses an oversized file in the browser without sending it', async () => {
    renderManager()

    await userEvent.upload(
      screen.getByLabelText('Add photos'),
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('huge.jpg')
    expect(screen.getByRole('alert')).toHaveTextContent('up to 15 MB')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the file the server could not read', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unsupported"}', { status: 415 }))
    renderManager()

    await userEvent.upload(
      screen.getByLabelText('Add photos'),
      new File([new Uint8Array([1])], 'odd.jpg', { type: 'image/jpeg' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('odd.jpg')
    expect(alert).toHaveTextContent('Couldn’t read this image.')
  })

  it('renders both failures when two picked files share a name, with no duplicate-key warning', async () => {
    // iOS routinely hands back multiple picked photos all named "image.jpg".
    // Keying the list by name alone renders both <p>s (React does not drop
    // elements over a key collision on initial render) but logs "Encountered
    // two children with the same key" — asserting only on the rendered text
    // would pass even with the bug, so this checks the console instead.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(new Response('{"error":"unsupported"}', { status: 415 }))
    renderManager()

    await userEvent.upload(screen.getByLabelText('Add photos'), [
      new File([new Uint8Array([1])], 'image.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([2])], 'image.jpg', { type: 'image/jpeg' }),
    ])

    const alert = await screen.findByRole('alert')
    expect(within(alert).getAllByText(/image\.jpg/)).toHaveLength(2)
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    consoleError.mockRestore()
  })

  it('treats a non-JSON 413 from the platform as too large', async () => {
    // A proxy or edge limit can reject the body before the route ever runs,
    // answering with a plain-text or HTML 413 rather than our JSON error
    // shape. The status code alone still says enough.
    fetchMock.mockResolvedValue(new Response('Request Entity Too Large', { status: 413 }))
    renderManager()

    await userEvent.upload(
      screen.getByLabelText('Add photos'),
      new File([new Uint8Array([1])], 'huge.jpg', { type: 'image/jpeg' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('huge.jpg')
    expect(alert).toHaveTextContent('up to 15 MB')
  })
})
