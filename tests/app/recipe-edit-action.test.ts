import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateRecipeContent: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/db/queries/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/recipes')>()
  return { ...actual, updateRecipeContent: mocks.updateRecipeContent }
})
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

const { saveRecipeEdits } = await import('@/app/(app)/recipes/[slug]/edit/actions')

const TARGET = { id: 'r1', slug: 'gochujang-chicken' }

/** A complete, valid submission; override just the part under test. */
function form(over: Record<string, string | string[]> = {}): FormData {
  const base: Record<string, string | string[]> = {
    title: 'Slow-Roast Gochujang Chicken',
    description: 'A whole chicken.',
    publisher: 'Bon Appétit',
    author: 'Molly Baz',
    sourceUrl: 'https://www.bonappetit.com/recipe/gochujang-chicken',
    claimedTimeMinutes: '180',
    servings: '4',
    yieldText: '4 servings',
    ingredients: '2 Tbsp. gochujang\n1 whole chicken',
    steps: 'Roast low for three hours.',
    tag: [],
    freeTags: '',
    ...over,
  }

  const data = new FormData()
  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) for (const v of value) data.append(key, v)
    else data.set(key, value)
  }
  return data
}

/** Runs the action, turning the redirect throw back into a value. */
async function run(data: FormData) {
  try {
    return { state: await saveRecipeEdits(TARGET, null, data), redirected: null as string | null }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('NEXT_REDIRECT:')) {
      return { state: null, redirected: message.slice('NEXT_REDIRECT:'.length) }
    }
    throw error
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.updateRecipeContent.mockResolvedValue({ ok: true })
})

describe('saveRecipeEdits', () => {
  it('refuses an unauthenticated save and writes nothing', async () => {
    mocks.auth.mockResolvedValue(null)

    const { state } = await run(form())

    expect(state?.message).toMatch(/signed in/i)
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('passes the parsed recipe through to the query layer', async () => {
    await run(form())

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        title: 'Slow-Roast Gochujang Chicken',
        claimedTimeMinutes: 180,
        servings: 4,
        ingredients: [
          { section: null, text: '2 Tbsp. gochujang' },
          { section: null, text: '1 whole chicken' },
        ],
        steps: [{ section: null, text: 'Roast low for three hours.' }],
      }),
    )
  })

  it('redirects to the recipe on success', async () => {
    const { redirected } = await run(form())
    expect(redirected).toBe('/recipes/gochujang-chicken')
  })

  it('applies colon section headers to the lines beneath them', async () => {
    await run(form({ ingredients: 'For the sauce:\n2 Tbsp. gochujang' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        ingredients: [{ section: 'For the sauce', text: '2 Tbsp. gochujang' }],
      }),
    )
  })

  it('rejects an empty title and hands back everything that was typed', async () => {
    const { state } = await run(form({ title: '   ', steps: 'Do not lose me.' }))

    expect(state?.fieldErrors.title).toMatch(/title/i)
    expect(state?.values.steps).toBe('Do not lose me.')
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('normalizes the source URL and derives the domain from it', async () => {
    await run(form({ sourceUrl: 'https://www.bonappetit.com/recipe/x?utm_source=news' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        sourceUrl: 'https://bonappetit.com/recipe/x',
        sourceDomain: 'bonappetit.com',
      }),
    )
  })

  it('stores an empty source URL as no source at all', async () => {
    await run(form({ sourceUrl: '  ' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ sourceUrl: null, sourceDomain: null }),
    )
  })

  it('rejects a source URL that is not one', async () => {
    const { state } = await run(form({ sourceUrl: 'not a url' }))

    expect(state?.fieldErrors.sourceUrl).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('names the collision when another recipe owns that source URL', async () => {
    mocks.updateRecipeContent.mockResolvedValue({ ok: false, reason: 'source_url_taken' })

    const { state } = await run(form())

    expect(state?.fieldErrors.sourceUrl).toMatch(/another recipe/i)
    expect(state?.values.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('names the collision when the source URL check loses a race and the write throws a UNIQUE violation', async () => {
    // `updateRecipeContent` pre-checks for a source-URL collision before
    // writing, but the check and the write are not atomic: a second save that
    // slips in between them hits the database's own UNIQUE constraint on
    // `recipes.source_url` instead of the returned `source_url_taken` result.
    // This is the backstop for that lost race, not a substitute for the
    // pre-check — the pre-check is what gives an unhurried user the message
    // without ever touching the database.
    //
    // Shaped the way it actually arrives, not the way it originates: Drizzle
    // wraps the driver's error in a `DrizzleQueryError` whose own `.message`
    // is the SQL text, and puts the real `LibsqlError` — carrying
    // `extendedCode` and the SQLite engine's own message — on `.cause`.
    mocks.updateRecipeContent.mockRejectedValue(
      Object.assign(new Error('Failed query: update "recipes" set "source_url" = ?\nparams: ...'), {
        cause: Object.assign(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: recipes.source_url'), {
          code: 'SQLITE_CONSTRAINT',
          extendedCode: 'SQLITE_CONSTRAINT_UNIQUE',
        }),
      }),
    )

    const { state } = await run(form())

    expect(state?.fieldErrors.sourceUrl).toMatch(/another recipe/i)
    expect(state?.values.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('also recognizes the collision from a bare driver error with no wrapper', async () => {
    // Belt-and-suspenders alongside the wrapped case above: `isSourceUrlCollision`
    // walks the `.cause` chain, but it should still recognize the violation if
    // some future call site ever hands it the unwrapped error directly.
    mocks.updateRecipeContent.mockRejectedValue(
      new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: recipes.source_url'),
    )

    const { state } = await run(form())

    expect(state?.fieldErrors.sourceUrl).toMatch(/another recipe/i)
    expect(state?.values.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('gives a generic message, not a guess, when the write throws something unrecognized', async () => {
    mocks.updateRecipeContent.mockRejectedValue(new Error('the network dropped'))

    const { state } = await run(form())

    expect(state?.fieldErrors.sourceUrl).toBeUndefined()
    expect(state?.message).toBeTruthy()
    expect(state?.values.title).toBe('Slow-Roast Gochujang Chicken')
  })

  it('rejects a non-numeric time without losing the rest of the form', async () => {
    const { state } = await run(form({ claimedTimeMinutes: 'about an hour' }))

    expect(state?.fieldErrors.claimedTimeMinutes).toBeTruthy()
    expect(state?.values.ingredients).toBe('2 Tbsp. gochujang\n1 whole chicken')
  })

  it('rejects a time beyond the ceiling the extractor uses', async () => {
    const { state } = await run(form({ claimedTimeMinutes: '99999999' }))
    expect(state?.fieldErrors.claimedTimeMinutes).toBeTruthy()
  })

  it('rejects zero minutes, which is a typo rather than an instant recipe', async () => {
    const { state } = await run(form({ claimedTimeMinutes: '0' }))
    expect(state?.fieldErrors.claimedTimeMinutes).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('rejects zero servings, which is a typo rather than a quantity', async () => {
    const { state } = await run(form({ servings: '0' }))
    expect(state?.fieldErrors.servings).toBeTruthy()
  })

  it('treats blank numbers as absent rather than zero', async () => {
    await run(form({ claimedTimeMinutes: '', servings: '' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ claimedTimeMinutes: null, servings: null }),
    )
  })

  it('accepts checked vocabulary tags', async () => {
    await run(form({ tag: ['course:main', 'cuisine:korean'] }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({
        tags: [
          { facet: 'course', value: 'main' },
          { facet: 'cuisine', value: 'korean' },
        ],
      }),
    )
  })

  it('rejects a tag outside the vocabulary rather than dropping it silently', async () => {
    const { state } = await run(form({ tag: ['course:brunchy'] }))

    expect(state?.fieldErrors.vocabularyTags).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('routes a free-form entry into its proper facet when the taxonomy knows it', async () => {
    await run(form({ freeTags: 'Thanksgiving' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'tag', value: 'holiday' }] }),
    )
  })

  it('keeps an unrecognized free-form entry as a kebab-cased open tag', async () => {
    await run(form({ freeTags: 'Kid Approved, ' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'tag', value: 'kid-approved' }] }),
    )
  })

  it('keeps a non-Latin free-form tag rather than dropping it', async () => {
    // A library that holds Korean and Italian recipes needs "고추장" to
    // survive as a tag, not be stripped down to '' by an ASCII-only filter.
    await run(form({ freeTags: '고추장' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'tag', value: '고추장' }] }),
    )
  })

  it('rejects a free-form entry with no usable characters instead of silently dropping it', async () => {
    const { state } = await run(form({ freeTags: '!!!' }))

    expect(state?.fieldErrors.freeTags).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('normalizes a forged tag-facet chip value instead of storing it verbatim', async () => {
    // A Server Action is a public POST endpoint: a `tag` chip value did not
    // necessarily come from this app's own checkboxes, which only ever emit
    // already-kebab-cased values. Run it through the same normalization the
    // free-tag box uses so it dedupes with a matching typed entry and never
    // stores raw whitespace or mixed case.
    await run(form({ tag: ['tag:Kid Approved'] }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'tag', value: 'kid-approved' }] }),
    )
  })

  it('rejects a tag-facet chip that normalizes to nothing, such as pure whitespace', async () => {
    const { state } = await run(form({ tag: ['tag: '] }))

    expect(state?.fieldErrors.vocabularyTags).toBeTruthy()
    expect(mocks.updateRecipeContent).not.toHaveBeenCalled()
  })

  it('does not store the same tag twice when a chip and a typed tag agree', async () => {
    await run(form({ tag: ['course:dessert'], freeTags: 'dessert' }))

    expect(mocks.updateRecipeContent).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      expect.objectContaining({ tags: [{ facet: 'course', value: 'dessert' }] }),
    )
  })

  it('reports a recipe that vanished while the form was open', async () => {
    mocks.updateRecipeContent.mockResolvedValue({ ok: false, reason: 'not_found' })

    const { state } = await run(form())

    expect(state?.message).toMatch(/no longer/i)
  })

  it('rejects more lines than a recipe could plausibly have', async () => {
    const { state } = await run(form({ ingredients: Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n') }))
    expect(state?.fieldErrors.ingredients).toBeTruthy()
  })
})
