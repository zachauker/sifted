// @vitest-environment jsdom
//
// jsdom, opted into per file the way `tests/components/library-grid.test.tsx`
// does — see the note in `vitest.config.mts` for why there is no second
// Vitest project.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { RecipeView } from '@/components/recipe/recipe-view'

// The page module reaches for a real libsql client through `@/lib/db`, which
// throws `URL_INVALID` when `TURSO_DATABASE_URL` is unset. Mocked the same way
// `tests/app/proxy.test.ts` and the route tests mock it.
const mocks = vi.hoisted(() => ({
  getRecipeBySlug: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/recipe-detail', () => ({ getRecipeBySlug: mocks.getRecipeBySlug }))
// The edit controls call `useRouter().refresh()` after a successful save, and
// there is no mounted App Router under jsdom. `notFound` is left as the real
// export because the page's 404 test asserts on the digest it throws.
vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>()
  return { ...actual, useRouter: () => ({ refresh: mocks.refresh }) }
})

/** A `fetch` stub standing in for `PATCH /api/recipes/[id]`. */
function stubPatch(
  respond: (patch: Record<string, unknown>) => { ok: boolean; stored?: Record<string, unknown> },
) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
    const result = respond(patch)
    if (!result.ok) return new Response('{"error":"boom"}', { status: 500 })
    // The real endpoint answers with the stored row, not an echo of the patch.
    return Response.json({ recipe: { id: 'r1', ...(result.stored ?? patch) } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  // Saves succeed and store exactly what was sent, unless a test says otherwise.
  stubPatch((patch) => ({ ok: true, stored: patch }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const { default: RecipePage } = await import('@/app/(app)/recipes/[slug]/page')

function recipe(overrides: Partial<RecipeDetail> = {}): RecipeDetail {
  return {
    id: 'r1',
    slug: 'gochujang-chicken',
    title: 'Slow-Roast Gochujang Chicken',
    sourceUrl: 'https://www.bonappetit.com/recipe/gochujang-chicken',
    sourceDomain: 'bonappetit.com',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    description: null,
    claimedTimeMinutes: null,
    actualTimeMinutes: null,
    servings: null,
    yieldText: null,
    rating: null,
    status: null,
    notes: null,
    narrativeHtml: null,
    extractionMethod: 'jsonld',
    handEdited: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ingredients: [],
    steps: [],
    tags: [],
    images: [],
    ...overrides,
  }
}

function ingredient(
  position: number,
  rawText: string,
  overrides: Partial<RecipeDetail['ingredients'][number]> = {},
) {
  return {
    position,
    section: null,
    rawText,
    quantity: null,
    unit: null,
    item: null,
    note: null,
    ...overrides,
  }
}

function step(position: number, text: string, section: string | null = null) {
  return { position, section, text }
}

/** The `<li>` elements of the steps column, in document order across sections. */
function stepItems(): HTMLElement[] {
  return within(screen.getByRole('region', { name: 'Steps' })).getAllByRole('listitem')
}

/** The ingredient lines as shown, in document order, optionally within one list. */
function ingredientLines(scope?: HTMLElement): string[] {
  const query = scope ? within(scope) : screen
  return query.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent ?? '')
}

describe('the recipe header', () => {
  it('renders the title, the publisher and the author', () => {
    render(<RecipeView recipe={recipe()} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Slow-Roast Gochujang Chicken' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Bon Appétit')).toBeInTheDocument()
    expect(screen.getByText('Molly Baz')).toBeInTheDocument()
  })

  it('links to the source, and opens it outside the app', () => {
    render(<RecipeView recipe={recipe()} />)

    const link = screen.getByRole('link', { name: /original/i })

    expect(link).toHaveAttribute('href', 'https://www.bonappetit.com/recipe/gochujang-chicken')
    expect(link).toHaveAttribute('target', '_blank')
    // Without `noopener`, the opened page gets a handle on `window.opener` and
    // can navigate the app out from under the reader.
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('renders no source link for a recipe that has no source', () => {
    render(<RecipeView recipe={recipe({ sourceUrl: null, sourceDomain: null })} />)

    expect(screen.queryByRole('link', { name: /original/i })).not.toBeInTheDocument()
  })

  it('renders the tags', () => {
    render(
      <RecipeView
        recipe={recipe({
          tags: [
            { facet: 'course', value: 'main' },
            { facet: 'cuisine', value: 'korean' },
            { facet: 'method', value: 'slow-cooker' },
          ],
        })}
      />,
    )

    const tags = within(screen.getByRole('list', { name: 'Tags' })).getAllByRole('listitem')
    expect(tags.map((t) => t.textContent)).toEqual(['Main', 'Korean', 'Slow cooker'])
  })

  it('renders the hero image when there is one', () => {
    render(
      <RecipeView
        recipe={recipe({
          images: [
            {
              role: 'source_hero',
              blobUrl: 'https://blob.example.com/hero.webp',
              thumbUrl: 'https://blob.example.com/thumb.webp',
              width: 1600,
              height: 1067,
            },
          ],
        })}
      />,
    )

    // Queried by tag, not by role: the hero carries `alt=""` (the title is
    // right above it as text), which makes it presentational and gives it no
    // `img` role to find.
    expect(document.querySelector('img')).toHaveAttribute(
      'src',
      'https://blob.example.com/hero.webp',
    )
  })

  it('does not lazy-load the hero image, since it is the page\'s LCP element', () => {
    render(
      <RecipeView
        recipe={recipe({
          images: [
            {
              role: 'source_hero',
              blobUrl: 'https://blob.example.com/hero.webp',
              thumbUrl: 'https://blob.example.com/thumb.webp',
              width: 1600,
              height: 1067,
            },
          ],
        })}
      />,
    )

    // `priority` on `next/image` is what turns this off — without it, the
    // image above the fold on the most important page in the app waits on
    // the browser noticing it scrolled into view before it starts loading.
    expect(document.querySelector('img')).not.toHaveAttribute('loading', 'lazy')
  })

  it('renders no broken image for a recipe with no image at all', () => {
    render(<RecipeView recipe={recipe({ images: [] })} />)

    // Not "renders a placeholder <img> with an empty src" — an <img> with
    // nothing behind it is the broken-image icon, and a library full of
    // Notion-bodied recipes would be a wall of them.
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it('renders no image when the row predates the stored blob URL', () => {
    render(
      <RecipeView
        recipe={recipe({
          images: [
            { role: 'source_hero', blobUrl: null, thumbUrl: null, width: 1600, height: 1067 },
          ],
        })}
      />,
    )

    expect(document.querySelectorAll('img')).toHaveLength(0)
  })
})

/**
 * The feature the user specifically asked for. Recipe sites systematically
 * understate time, and the gap between what the publisher claimed and what it
 * actually took is the institutional knowledge this app accumulates — it is
 * the one number on the page that exists nowhere else.
 */
describe('the claimed-versus-actual time chip', () => {
  it('shows the claim beside the measured time when both are known', () => {
    render(<RecipeView recipe={recipe({ claimedTimeMinutes: 35, actualTimeMinutes: 70 })} />)

    expect(screen.getByText('claims 35m').closest('p')?.textContent).toBe(
      'claims 35m · took us 1h 10m',
    )
  })

  it('shows only the claim when nobody has cooked it yet', () => {
    render(<RecipeView recipe={recipe({ claimedTimeMinutes: 35, actualTimeMinutes: null })} />)

    expect(screen.getByText('claims 35m')).toBeInTheDocument()
    expect(screen.queryByText(/took us/)).not.toBeInTheDocument()
  })

  it('shows only the measured time when the source never claimed one', () => {
    render(<RecipeView recipe={recipe({ claimedTimeMinutes: null, actualTimeMinutes: 70 })} />)

    expect(screen.getByText('took us 1h 10m')).toBeInTheDocument()
    expect(screen.queryByText(/claims/)).not.toBeInTheDocument()
  })

  it('shows no chip at all when neither time is known', () => {
    render(<RecipeView recipe={recipe({ claimedTimeMinutes: null, actualTimeMinutes: null })} />)

    expect(screen.queryByText(/claims/)).not.toBeInTheDocument()
    expect(screen.queryByText(/took us/)).not.toBeInTheDocument()
  })
})

describe('the ingredients', () => {
  it('renders the raw line verbatim, not the parsed fields', () => {
    // The parse here is wrong in the way a real one goes wrong: the LLM read
    // "1 ½" as 1 and dropped the "packed". The page must still show the truth.
    render(
      <RecipeView
        recipe={recipe({
          ingredients: [
            ingredient(0, '1 ½ cups packed dark brown sugar', {
              quantity: 1,
              unit: 'cup',
              item: 'brown sugar',
              note: null,
            }),
          ],
        })}
      />,
    )

    expect(screen.getByText('1 ½ cups packed dark brown sugar')).toBeInTheDocument()
    expect(screen.queryByText('brown sugar')).toBeNull()
    expect(screen.queryByText('1 cup brown sugar')).toBeNull()
    expect(screen.getByRole('region', { name: 'Ingredients' }).textContent).not.toContain('1 cup')
  })

  it('renders them in position order however they arrive', () => {
    render(
      <RecipeView
        recipe={recipe({
          ingredients: [
            ingredient(0, 'first'),
            ingredient(1, 'second'),
            ingredient(2, 'third'),
          ],
        })}
      />,
    )

    expect(ingredientLines()).toEqual(['first', 'second', 'third'])
  })

  it('groups the ingredients under their section heading', () => {
    render(
      <RecipeView
        recipe={recipe({
          ingredients: [
            ingredient(0, '2 cups flour', { section: 'For the crust' }),
            ingredient(1, '1 stick butter', { section: 'For the crust' }),
            ingredient(2, '4 apples', { section: 'For the filling' }),
            ingredient(3, '1 tsp cinnamon', { section: 'For the filling' }),
          ],
        })}
      />,
    )

    expect(screen.getByRole('heading', { name: 'For the crust' })).toBeInTheDocument()
    expect(ingredientLines(screen.getByRole('list', { name: 'For the crust' }))).toEqual([
      '2 cups flour',
      '1 stick butter',
    ])
    expect(ingredientLines(screen.getByRole('list', { name: 'For the filling' }))).toEqual([
      '4 apples',
      '1 tsp cinnamon',
    ])
  })

  // Real recipes do this constantly: a few loose ingredients, then "For the
  // sauce". The loose ones must not be swallowed by the first heading, and
  // they must not invent a heading of their own.
  it('keeps loose ingredients above the first section, unlabelled', () => {
    render(
      <RecipeView
        recipe={recipe({
          ingredients: [
            ingredient(0, '1 lb pork shoulder'),
            ingredient(1, 'Kosher salt'),
            ingredient(2, '2 tbsp soy sauce', { section: 'For the sauce' }),
          ],
        })}
      />,
    )

    const lists = within(screen.getByRole('region', { name: 'Ingredients' })).getAllByRole('list')
    expect(lists).toHaveLength(2)
    expect(ingredientLines(lists[0])).toEqual(['1 lb pork shoulder', 'Kosher salt'])
    expect(ingredientLines(lists[1])).toEqual(['2 tbsp soy sauce'])
    // The loose ones sit above the first heading and invent none of their own.
    expect(screen.getAllByRole('heading', { name: /for the/i })).toHaveLength(1)
    // Ordering across the whole column is still position order.
    expect(ingredientLines()).toEqual(['1 lb pork shoulder', 'Kosher salt', '2 tbsp soy sauce'])
  })

  it('gives every ingredient a checkbox that starts unchecked', () => {
    render(
      <RecipeView recipe={recipe({ ingredients: [ingredient(0, 'Kosher salt')] })} />,
    )

    const box = screen.getByRole('checkbox', { name: 'Kosher salt' })
    expect(box).not.toBeChecked()
  })

  it('gives the whole ingredient row — the most-tapped element in the app — a full-height tap target', () => {
    render(
      <RecipeView recipe={recipe({ ingredients: [ingredient(0, 'Kosher salt')] })} />,
    )

    // jsdom does not compute real layout (`getBoundingClientRect` reads
    // zero regardless of CSS), so a literal 44px cannot be measured here —
    // see the real-viewport measurement in the task report instead. This
    // asserts on the class doing the work: the label around the checkbox
    // and its text is what has to carry the tap target, not the 16px
    // checkbox glyph alone.
    const box = screen.getByRole('checkbox', { name: 'Kosher salt' })
    expect(box.closest('label')).toHaveClass('min-h-11')
  })

  it('renders no ingredients heading for a recipe that has none', () => {
    render(<RecipeView recipe={recipe({ ingredients: [] })} />)

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  // The hand-typed family recipes the Notion migration rescued: the
  // ingredients were all anyone ever wrote down. Saying nothing at all leaves
  // a page that is indistinguishable from one that failed to load.
  it('says so when a recipe has ingredients but no steps', () => {
    render(
      <RecipeView recipe={recipe({ ingredients: [ingredient(0, 'Ham')], steps: [] })} />,
    )

    expect(screen.getByText('No steps were saved with this recipe.')).toBeInTheDocument()
  })

  it('says nothing of the sort when the recipe has steps', () => {
    render(
      <RecipeView
        recipe={recipe({ ingredients: [ingredient(0, 'Ham')], steps: [step(0, 'Bake it.')] })}
      />,
    )

    expect(screen.queryByText(/no steps were saved/i)).not.toBeInTheDocument()
  })
})

describe('the steps', () => {
  it('renders them in position order however they arrive', () => {
    render(
      <RecipeView
        recipe={recipe({
          steps: [
            step(0, 'Season the beef.'),
            step(1, 'Sear on all sides.'),
            step(2, 'Simmer for an hour.'),
          ],
        })}
      />,
    )

    expect(stepItems().map((li) => li.querySelector('p')?.textContent)).toEqual([
      'Season the beef.',
      'Sear on all sides.',
      'Simmer for an hour.',
    ])
  })

  it('numbers them', () => {
    render(
      <RecipeView
        recipe={recipe({
          steps: [step(0, 'Season the beef.'), step(1, 'Sear.'), step(2, 'Simmer.')],
        })}
      />,
    )

    const items = stepItems()
    expect(within(items[0]).getByText('1')).toBeInTheDocument()
    expect(within(items[1]).getByText('2')).toBeInTheDocument()
    expect(within(items[2]).getByText('3')).toBeInTheDocument()
  })

  it('numbers continuously across step sections', () => {
    render(
      <RecipeView
        recipe={recipe({
          steps: [
            step(0, 'Rub the pork.', 'The day before'),
            step(1, 'Refrigerate overnight.', 'The day before'),
            step(2, 'Roast at 300°F.', 'On the day'),
          ],
        })}
      />,
    )

    expect(screen.getByRole('heading', { name: 'The day before' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'On the day' })).toBeInTheDocument()
    // A cook says "I'm on step 3", not "step 1 of the second part".
    expect(within(stepItems()[2]).getByText('3')).toBeInTheDocument()
  })
})

/**
 * The entire product claim. The user is leaving Notion because its web clipper
 * buried every recipe under a thousand words of the author's life story, and
 * cooking meant scrolling past it every single time.
 */
describe('the narrative fold', () => {
  const narrative =
    '<p>' + Array.from({ length: 240 }, (_, i) => `word${i}`).join(' ') + '</p>'

  it('collapses the story, and is not open by default', () => {
    render(<RecipeView recipe={recipe({ narrativeHtml: narrative })} />)

    const fold = screen.getByRole('group')
    expect(fold).not.toHaveAttribute('open')
    expect(screen.getByText(/word239/)).not.toBeVisible()
  })

  it('carries a visual open/closed indicator that actually reacts to the `open` attribute', () => {
    // The marker replaces the native `<details>` triangle with a static
    // one (`list-none` plus a rendered `▸`), which only means anything if
    // something rotates it open vs. closed. `group-open:` is a Tailwind
    // *variant* — it does not show up as a literal class name on the
    // marker, only as a selector inside the compiled stylesheet keyed to
    // the ancestor's `[open]` attribute — so what's checked here is the
    // wiring: the marker asks for `group-open:rotate-90`, and the
    // ancestor it needs an `[open]` to act on is marked `group`.
    render(<RecipeView recipe={recipe({ narrativeHtml: narrative })} />)

    const fold = screen.getByRole('group')
    expect(fold).toHaveClass('group')
    const marker = fold.querySelector('summary span[aria-hidden="true"]')
    expect(marker).toHaveClass('group-open:rotate-90')
  })

  it('names how long the story is, so the reader can decide before opening it', () => {
    render(<RecipeView recipe={recipe({ narrativeHtml: narrative })} />)

    expect(screen.getByText(/250 words/)).toBeInTheDocument()
  })

  it('renders no fold at all when there is no narrative', () => {
    render(<RecipeView recipe={recipe({ narrativeHtml: null })} />)

    // Not an empty <details> that opens onto nothing — a Notion-bodied recipe
    // has no narrative and must not grow a control that lies about having one.
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('renders no fold for a narrative that is only markup', () => {
    render(<RecipeView recipe={recipe({ narrativeHtml: '<div><span>   </span></div>' })} />)

    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('strips event handlers out of the stored HTML before rendering it', () => {
    // Measured in plan 1: Readability strips <script> elements but leaves
    // inline handlers intact, so this is what actually reaches the column.
    render(
      <RecipeView
        recipe={recipe({
          narrativeHtml:
            '<p onclick="steal()">The story of this soup.</p>' +
            '<img src="https://example.com/x.jpg" onerror="steal()">' +
            '<a href="javascript:steal()">tap</a>',
        })}
      />,
    )

    const fold = screen.getByRole('group')
    expect(fold.innerHTML).not.toContain('onclick')
    expect(fold.innerHTML).not.toContain('onerror')
    expect(fold.innerHTML).not.toContain('javascript:')
    expect(screen.getByText('The story of this soup.')).toBeInTheDocument()
  })
})

describe('the household notes', () => {
  it('renders our notes when there are any', () => {
    render(<RecipeView recipe={recipe({ notes: 'Halve the gochujang. Serve with rice.' })} />)

    expect(screen.getByText('Halve the gochujang. Serve with rice.')).toBeInTheDocument()
  })

  it('renders the note as text, not as markup', () => {
    render(<RecipeView recipe={recipe({ notes: '<img src=x onerror=alert(1)>' })} />)

    // Notes are typed by a person and rendered as a text node, which React
    // escapes. They never go near `dangerouslySetInnerHTML`, which is why
    // `sanitizeNarrative` has no business in a Client Component.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it('offers a way to write the first note when there are none, without an empty paragraph', () => {
    render(<RecipeView recipe={recipe({ notes: null })} />)

    // The panel is always present now — it is where the rating and the status
    // live too — but a recipe with no note must not render an empty one.
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit notes' })).not.toBeInTheDocument()
  })
})

/**
 * The four fields no extraction can produce. Everything else on this page is a
 * read of the archived source and can be regenerated; these cannot, which is
 * why every failure path below is asserted to say something out loud.
 */
describe('the edit controls', () => {
  const patchBody = (fetchMock: ReturnType<typeof stubPatch>, call = 0) =>
    JSON.parse(String(fetchMock.mock.calls[call][1]?.body))

  it('gives every rating star a full 44px tap target, not just its glyph', () => {
    // A mistap on a 24×20px star with 2px of separation writes a wrong
    // rating whose only undo is a small text link — see the "Clear"
    // target test below. jsdom cannot measure real pixels (see the note
    // on the ingredient-row test above), so this checks the classes that
    // produce the target instead.
    render(<RecipeView recipe={recipe({ rating: null })} />)

    for (const label of ['1 star', '2 stars', '3 stars', '4 stars', '5 stars']) {
      const star = screen.getByRole('button', { name: label })
      expect(star).toHaveClass('min-h-11')
      expect(star).toHaveClass('min-w-11')
    }
  })

  it('sends only the field that changed', async () => {
    const fetchMock = stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ rating: null, notes: 'Keep me.' })} />)

    await userEvent.click(screen.getByRole('button', { name: '4 stars' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/recipes/r1')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH')
    // A rating tap that also carried `notes: null` would blank a paragraph
    // nothing can regenerate.
    expect(patchBody(fetchMock)).toEqual({ rating: 4 })
  })

  it('shows the new rating immediately, before the request settles', async () => {
    let release: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(Response.json({ recipe: { id: 'r1', rating: 5 } }))
          }),
      ),
    )
    render(<RecipeView recipe={recipe({ rating: 2 })} />)

    await userEvent.click(screen.getByRole('button', { name: '5 stars' }))

    expect(screen.getByRole('button', { name: '5 stars' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    release?.()
  })

  it('offers no way to clear a rating that is not set', () => {
    render(<RecipeView recipe={recipe({ rating: null })} />)
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('offers a way to clear a rating that is set', () => {
    render(<RecipeView recipe={recipe({ rating: 4 })} />)
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
  })

  it('clears a rating to null rather than to zero', async () => {
    const fetchMock = stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ rating: 4 })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))

    // Not `{ rating: 0 }`: the filter rail has no `rating:0` row, so a
    // zero-star recipe would be invisible to every rating filter. "Unrated"
    // is the state a person means when they take a rating back.
    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ rating: null }))
  })

  it('toggles a status off when the status it already has is pressed again', async () => {
    const fetchMock = stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ status: 'made_it' })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Made it' }))

    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ status: null }))
  })

  it('saves a note and shows it without a reload', async () => {
    const fetchMock = stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ notes: null })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Our notes' }), 'Halve the gochujang.')
    await userEvent.click(screen.getByRole('button', { name: 'Save notes' }))

    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ notes: 'Halve the gochujang.' }))
    expect(await screen.findByText('Halve the gochujang.')).toBeInTheDocument()
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('takes the stored note back from the server rather than echoing the draft', async () => {
    // The endpoint trims and empty-collapses; the client has to converge on
    // what the database holds, not on what it sent.
    stubPatch(() => ({ ok: true, stored: { notes: 'Halve the gochujang.' } }))
    render(<RecipeView recipe={recipe({ notes: null })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Our notes' }),
      '   Halve the gochujang.   ',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save notes' }))

    expect(await screen.findByText('Halve the gochujang.')).toBeInTheDocument()
  })

  it('records a measured time and puts it in the chip at the top of the page', async () => {
    const fetchMock = stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ claimedTimeMinutes: 35, actualTimeMinutes: null })} />)

    expect(screen.queryByText(/took us/)).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('How long it really took'), '70')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ actualTimeMinutes: 70 }))
    // The whole point of the feature: the claim and the measurement side by
    // side, the moment the measurement exists.
    expect((await screen.findByText('claims 35m')).closest('p')?.textContent).toBe(
      'claims 35m · took us 1h 10m',
    )
  })

  it('grows the chip row for a recipe that had no times at all', async () => {
    stubPatch((patch) => ({ ok: true, stored: patch }))
    render(
      <RecipeView
        recipe={recipe({ claimedTimeMinutes: null, actualTimeMinutes: null, yieldText: null })}
      />,
    )

    await userEvent.type(screen.getByLabelText('How long it really took'), '25')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('took us 25m')).toBeInTheDocument()
  })

  it('marks a typed time as unsaved until it is saved', async () => {
    stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ actualTimeMinutes: null })} />)

    await userEvent.type(screen.getByLabelText('How long it really took'), '70')
    expect(screen.getByText('Not saved yet')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByText('Not saved yet')).not.toBeInTheDocument())
  })

  it('refuses a time that is not whole minutes, without sending it', async () => {
    const fetchMock = stubPatch((patch) => ({ ok: true, stored: patch }))
    render(<RecipeView recipe={recipe({ actualTimeMinutes: null })} />)

    await userEvent.type(screen.getByLabelText('How long it really took'), '1.5')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/whole minutes/i)
    expect(fetchMock).not.toHaveBeenCalled()
    // The entry survives being refused.
    expect(screen.getByLabelText('How long it really took')).toHaveValue(1.5)
  })
})

/**
 * The failure paths, which matter more here than anywhere else in the app: a
 * spinner that quietly gives up is how "we made this, it was a 5" gets lost,
 * and that fact exists nowhere but this row.
 */
describe('the edit controls when a save fails', () => {
  it('puts the rating back and says so', async () => {
    stubPatch(() => ({ ok: false }))
    render(<RecipeView recipe={recipe({ rating: 2 })} />)

    await userEvent.click(screen.getByRole('button', { name: '5 stars' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("We couldn't save that rating. It's back to 2 stars")
    expect(screen.getByRole('button', { name: '2 stars' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '5 stars' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('says what an unrated recipe went back to', async () => {
    stubPatch(() => ({ ok: false }))
    render(<RecipeView recipe={recipe({ rating: null })} />)

    await userEvent.click(screen.getByRole('button', { name: '5 stars' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('back to unrated')
  })

  it('puts the status back and says so', async () => {
    stubPatch(() => ({ ok: false }))
    render(<RecipeView recipe={recipe({ status: null })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Made it' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('back to not set')
    expect(screen.getByRole('button', { name: 'Made it' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the typed note in the box, and stays in the editor', async () => {
    stubPatch(() => ({ ok: false }))
    render(<RecipeView recipe={recipe({ notes: null })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Our notes' }), 'It was a 5.')
    await userEvent.click(screen.getByRole('button', { name: 'Save notes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('your text is still here')
    // The text a person typed is the one thing a failed save must never eat.
    expect(screen.getByRole('textbox', { name: 'Our notes' })).toHaveValue('It was a 5.')
    expect(screen.getByRole('button', { name: 'Save notes' })).toBeInTheDocument()
  })

  it('keeps the typed time and leaves the chip on the last stored value', async () => {
    stubPatch(() => ({ ok: false }))
    render(<RecipeView recipe={recipe({ claimedTimeMinutes: 35, actualTimeMinutes: null })} />)

    await userEvent.type(screen.getByLabelText('How long it really took'), '70')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/your entry is still here/i)
    expect(screen.getByLabelText('How long it really took')).toHaveValue(70)
    expect(screen.getByText('Not saved yet')).toBeInTheDocument()
    expect(screen.queryByText(/took us/)).not.toBeInTheDocument()
  })

  it('does not roll back a field the failed request did not carry', async () => {
    // Rate it (succeeds), then fail a notes save. The rating must survive.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
      if ('notes' in patch) return new Response('{}', { status: 500 })
      return Response.json({ recipe: { id: 'r1', ...patch } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<RecipeView recipe={recipe({ rating: null, notes: null })} />)

    await userEvent.click(screen.getByRole('button', { name: '5 stars' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '5 stars' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Our notes' }), 'It was a 5.')
    await userEvent.click(screen.getByRole('button', { name: 'Save notes' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '5 stars' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the page', () => {
  it('renders the recipe behind the slug', async () => {
    mocks.getRecipeBySlug.mockResolvedValue(recipe())

    render(await RecipePage({ params: Promise.resolve({ slug: 'gochujang-chicken' }) }))

    expect(mocks.getRecipeBySlug).toHaveBeenCalledWith({ marker: 'db' }, 'gochujang-chicken')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Slow-Roast Gochujang Chicken',
    )
  })

  it('renders the not-found page for a slug that is not in the library', async () => {
    mocks.getRecipeBySlug.mockResolvedValue(null)

    // `notFound()` works by throwing; Next catches the digest and renders the
    // nearest not-found boundary. Asserting on the digest is what proves the
    // page hands off to that boundary instead of, say, rendering an empty
    // recipe with a blank title.
    await expect(
      RecipePage({ params: Promise.resolve({ slug: 'no-such-recipe' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  })
})
