import type { DetailIngredient } from '@/lib/db/queries/recipe-detail'

/**
 * A run of ingredients sharing one section label, in position order.
 *
 * Grouped by *consecutive* run rather than by collecting every ingredient with
 * the same label. Real recipes are written as a sequence — a few loose
 * ingredients, then "For the sauce", then "For the garnish" — and position
 * order is the author's order. Collecting by label would silently reorder a
 * recipe that reuses one ("For the dough" appearing twice, before and after a
 * filling), and reordering an ingredient list is the same class of mistake as
 * reordering steps.
 */
type Group = { section: string | null; items: DetailIngredient[] }

export function groupBySection(items: readonly DetailIngredient[]): Group[] {
  const groups: Group[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.section === item.section) last.items.push(item)
    else groups.push({ section: item.section, items: [item] })
  }
  return groups
}

/**
 * The ingredients, pinned beside the steps on a wide screen.
 *
 * ## `rawText`, and only `rawText`
 *
 * The parsed `quantity`/`unit`/`item` columns are an LLM enhancement layered
 * on top of the source line. They are frequently absent (any recipe imported
 * while the model was rate-limited has none) and occasionally wrong — "1 ½
 * cups packed dark brown sugar" has been observed parsing to
 * `{quantity: 1, unit: 'cup', item: 'brown sugar'}`, losing both the half and
 * the packing. Rendering the parse would mean a bad parse silently changes
 * what the reader cooks. The raw line is the truth and is what the page
 * shows; the parsed columns exist for scaling (Phase 2) and search.
 *
 * ## Checkboxes with no state and no JavaScript
 *
 * Ticking off ingredients is a cooking-session convenience that must not
 * persist — reopening the page tomorrow to find half the list crossed out from
 * last time would be a bug, not a feature. That makes an uncontrolled native
 * checkbox exactly right: the browser owns the state, a reload clears it, and
 * the strike-through is a `peer-checked:` CSS rule. No `useState`, no `'use
 * client'`, no hydration — the ingredient column ships zero bytes of
 * component JavaScript.
 *
 * `rawText` renders as a text node. React escapes it, which is the whole
 * defence for a third-party string: it must never reach
 * `dangerouslySetInnerHTML`.
 */
export function IngredientList({ ingredients }: { ingredients: readonly DetailIngredient[] }) {
  if (ingredients.length === 0) return null

  const groups = groupBySection(ingredients)

  return (
    <section
      aria-label="Ingredients"
      className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto"
    >
      <h2 className="text-lg font-semibold tracking-tight text-ink">
        Ingredients
      </h2>

      {groups.map((group, index) => (
        <div key={`${group.section ?? ''}-${index}`} className="mt-3">
          {group.section && (
            <h3 className="mt-4 mb-1 text-sm font-semibold text-ink-muted">
              {group.section}
            </h3>
          )}
          <ul aria-label={group.section ?? 'Ingredients'} className="space-y-1">
            {group.items.map((item) => (
              <li key={item.position}>
                {/* The most-tapped element in the product, standing at a
                    counter with wet or floury hands — `min-h-11` and
                    `py-2` bring the whole row to a full 44px tap target
                    even for a one-word ingredient, while `items-start`
                    keeps the checkbox aligned to the first line of a
                    line that wraps to two or three. */}
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md py-2 text-base leading-snug transition-colors duration-(--dur-fast) hover:bg-sunken">
                  <input
                    type="checkbox"
                    className="peer mt-1 size-[1.15em] shrink-0 self-start accent-accent"
                  />
                  <span className="transition-colors duration-(--dur-fast) peer-checked:text-ink-faint peer-checked:line-through">
                    {item.rawText}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
