import Image from 'next/image'
import Link from 'next/link'
import type { RecipeDetail } from '@/lib/db/queries/recipe-detail'
import { DEFAULT_SORT, filterStateToQuery } from '@/lib/library/filter'
import { IngredientList } from './ingredient-list'
import { NarrativeFold } from './narrative-fold'
import { StepList } from './step-list'
import { TimeChip } from './time-chip'
import { humanizeTagValue } from './format'

/**
 * The screen the entire project exists to produce.
 *
 * ## The layout, and the complaint it answers
 *
 * The user is leaving a shared Notion database whose web clipper dumps the
 * whole article, so every saved recipe sits buried under a thousand words of
 * the author's life story. Cooking from a saved recipe means scrolling past
 * that, every time, on a phone, with wet hands.
 *
 * This page inverts it. The page *is* the recipe: title, the times, the
 * ingredients pinned beside the steps on a wide screen and stacked on a
 * phone. The original article survives — collapsed, at the bottom, behind a
 * control that says how long it is. There if you want the "why", invisible if
 * you don't.
 *
 * ## Why a Server Component, with no client boundary anywhere in the tree
 *
 * Nothing on this page needs component JavaScript. The ingredient checkboxes
 * are uncontrolled native inputs (state owned by the browser, cleared by a
 * reload, which is exactly right for a cooking session) and the narrative fold
 * is a `<details>`. So the whole subtree renders on the server and ships as
 * HTML: no hydration, no bundle, nothing to go wrong on a phone on kitchen
 * wifi. The editing controls in the next task are the first thing here that
 * genuinely needs a client boundary, and it should be drawn around *them*, not
 * around this component.
 *
 * ## The scale control is Phase 2
 *
 * Deliberately absent, per the plan. It needs the parsed `quantity`/`unit`
 * columns to be reliable, and they are not yet.
 */
export function RecipeView({ recipe }: { recipe: RecipeDetail }) {
  // A `source_hero` with a stored URL, else any image with one. `blobUrl` is
  // nullable — rows ingested before the column existed have keys but no URL,
  // and a key alone cannot be turned back into a fetchable address. Those must
  // render as *no image*, never as an `<img>` with an empty src, which is the
  // browser's broken-image icon.
  const hero =
    recipe.images.find((image) => image.role === 'source_hero' && image.blobUrl) ??
    recipe.images.find((image) => image.blobUrl)

  const sourceLabel = sourceHost(recipe)
  const servings = servingsLabel(recipe)

  // Two columns only when there are two columns' worth of recipe. A recipe
  // rescued from a Notion body routinely has ingredients and no steps at all
  // — and a two-column grid with an empty right-hand two-thirds does not read
  // as "this recipe is brief", it reads as "the page failed to load".
  const twoColumn = recipe.ingredients.length > 0 && recipe.steps.length > 0

  return (
    <article className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-2xl leading-tight font-semibold sm:text-3xl">{recipe.title}</h1>

        {(recipe.publisher || recipe.author || recipe.sourceUrl) && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
            {recipe.publisher && <span>{recipe.publisher}</span>}
            {recipe.publisher && recipe.author && <span aria-hidden="true">·</span>}
            {recipe.author && <span>{recipe.author}</span>}
            {recipe.sourceUrl && (
              <a
                href={recipe.sourceUrl}
                // The source is someone else's site, so it opens in its own
                // tab and never gets a handle on this one via `window.opener`.
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200"
              >
                {sourceLabel ? `View the original on ${sourceLabel}` : 'View the original'}
              </a>
            )}
          </p>
        )}

        {recipe.description && (
          <p className="mt-3 max-w-prose text-[15px] text-neutral-600 dark:text-neutral-300">
            {recipe.description}
          </p>
        )}

        {/* Rendered only when there is something to put in it. An empty row
            still carries its top margin, and a stripe of dead space above the
            ingredients is exactly what makes the sparsest recipes — the ones
            rescued from Notion bodies, with no times and no yield — look
            broken rather than merely brief. */}
        {(recipe.claimedTimeMinutes !== null ||
          recipe.actualTimeMinutes !== null ||
          servings !== null) && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <TimeChip
              claimedMinutes={recipe.claimedTimeMinutes}
              actualMinutes={recipe.actualTimeMinutes}
            />
            {servings && (
              <p className="rounded-full bg-neutral-100 px-3 py-1 text-sm text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                {servings}
              </p>
            )}
          </div>
        )}

        {hero?.blobUrl && (
          <Image
            src={hero.blobUrl}
            // Empty on purpose: the title sits directly above as text, and a
            // hero photo of the finished dish adds nothing a screen reader
            // needs said twice. There is no alt text to borrow — nothing in
            // the pipeline captures the source page's.
            alt=""
            width={hero.width}
            height={hero.height}
            // `ingestHeroImage` already stores a 1600px-max WebP, which is the
            // widest this ever draws. Optimizing re-encodes a file that was
            // encoded for this purpose, per image, on request. Same call the
            // library cards make, for the same reason.
            unoptimized
            className="mt-5 aspect-[3/2] w-full rounded-xl object-cover"
          />
        )}

        {recipe.tags.length > 0 && (
          <ul aria-label="Tags" className="mt-4 flex flex-wrap gap-2">
            {recipe.tags.map((tag) => (
              <li key={`${tag.facet}:${tag.value}`}>
                <Link
                  // Back to the library, filtered to this tag. The query
                  // string is built by `filterStateToQuery` rather than
                  // hand-assembled, so the parameter name and its encoding
                  // stay owned by one module.
                  href={`/${filterStateToQuery({ selected: [`${tag.facet}:${tag.value}`], sort: DEFAULT_SORT })}`}
                  className="inline-block rounded-full border border-black/10 px-2.5 py-0.5 text-xs text-neutral-600 hover:border-black/25 dark:border-white/15 dark:text-neutral-300 dark:hover:border-white/35"
                >
                  {humanizeTagValue(tag.value)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </header>

      {/* The recipe itself. Ingredients pinned beside the steps from `lg` up,
          stacked below it — and stacked *ingredients first*, because that is
          the order you need them in when you are standing at the counter. */}
      <div
        className={
          twoColumn
            ? 'mt-8 grid gap-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:gap-12'
            : 'mt-8 grid gap-8'
        }
      >
        <IngredientList ingredients={recipe.ingredients} />
        <StepList steps={recipe.steps} />
        {recipe.ingredients.length > 0 && recipe.steps.length === 0 && (
          // Said out loud, because silence here is indistinguishable from a
          // bug. These are the hand-typed family recipes the migration
          // rescued: the ingredients were all anyone ever wrote down.
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No steps were saved with this recipe.
          </p>
        )}
      </div>

      {recipe.notes && (
        <section
          aria-labelledby="household-notes"
          className="mt-10 rounded-xl bg-amber-50 p-4 dark:bg-amber-950/30"
        >
          <h2
            id="household-notes"
            className="text-xs font-semibold tracking-wider text-amber-900/70 uppercase dark:text-amber-200/70"
          >
            Our notes
          </h2>
          {/* `whitespace-pre-line` because notes are typed by hand, in a
              textarea, and the line breaks someone put in are meaningful. */}
          <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-line">{recipe.notes}</p>
        </section>
      )}

      <NarrativeFold html={recipe.narrativeHtml} publisher={recipe.publisher} />
    </article>
  )
}

/** `bonappetit.com`, for the source link's label. */
function sourceHost(recipe: RecipeDetail): string | null {
  if (recipe.sourceDomain) return recipe.sourceDomain
  if (!recipe.sourceUrl) return null
  try {
    return new URL(recipe.sourceUrl).hostname.replace(/^www\./, '')
  } catch {
    // A stored URL that no longer parses is not a reason to fail the page.
    return null
  }
}

/**
 * `yieldText` first: it is the source's own phrasing ("Makes 12 rolls",
 * "Serves 4 to 6") and carries more than the integer does. `servings` is the
 * fallback for the rows where only the number survived.
 */
function servingsLabel(recipe: RecipeDetail): string | null {
  if (recipe.yieldText) return recipe.yieldText
  if (recipe.servings === null) return null
  return `${recipe.servings} ${recipe.servings === 1 ? 'serving' : 'servings'}`
}
