// @vitest-environment jsdom
//
// jsdom, opted into per file the way `tests/components/library-grid.test.tsx`
// does — see the note in `vitest.config.mts` for why there is no second
// Vitest project.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { RecipeView } from '@/components/recipe/recipe-view'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The page module reaches for a real libsql client through `@/lib/db`, which
// throws `URL_INVALID` when `TURSO_DATABASE_URL` is unset. Mocked the same way
// `tests/app/proxy.test.ts` and the route tests mock it.
const mocks = vi.hoisted(() => ({ getRecipeBySlug: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/recipe-detail', () => ({ getRecipeBySlug: mocks.getRecipeBySlug }))

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

  it('renders no notes section when there are none', () => {
    render(<RecipeView recipe={recipe({ notes: null })} />)

    expect(screen.queryByRole('heading', { name: /our notes/i })).not.toBeInTheDocument()
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
