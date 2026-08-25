'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import type { LibraryEntry } from '@/lib/db/queries/library'
import { computeFacetCounts } from '@/lib/library/facets'
import {
  SORTS,
  SORT_LABELS,
  applyFilterState,
  filterStateToQuery,
  toggleToken,
  type FilterState,
  type FilterToken,
  type SortKey,
} from '@/lib/library/filter'
import { FilterRail } from './filter-rail'
import { RecipeGrid } from './recipe-grid'
import { useNarrowViewport } from './use-narrow-viewport'

/**
 * The library screen: a persistent filter rail beside a photo grid, and on
 * a phone the same rail as a bottom sheet.
 *
 * The whole index arrives as a prop from the server component — 69KB for
 * 156 recipes — so every filter click, sort change and count update is a
 * synchronous pass over an array in memory. There is no fetch, no loading
 * state, and no cache to invalidate. Measured at well under a millisecond
 * for the real library size; see `tests/components/library-grid.test.tsx`.
 */
export function LibraryView({
  entries,
  initialState,
}: {
  entries: LibraryEntry[]
  initialState: FilterState
}) {
  const [state, setState] = useState<FilterState>(initialState)
  const [sheetOpen, setSheetOpen] = useState(false)
  const narrow = useNarrowViewport()
  const railId = useId()
  const sortId = useId()

  const groups = useMemo(
    () => computeFacetCounts(entries, state.selected),
    [entries, state.selected],
  )
  const visible = useMemo(() => applyFilterState(entries, state), [entries, state])
  const selectedValues = useMemo(
    () => groups.flatMap((group) => group.values.filter((value) => value.selected)),
    [groups],
  )

  /**
   * Filter state lives in the URL so a narrowed view survives a reload and
   * can be handed to the other person in the house. It is written with
   * `history.replaceState` rather than a router navigation on purpose: a
   * navigation would re-run the server component and re-send the whole
   * index on every checkbox click, which is exactly the round trip this
   * design exists to avoid. `replaceState` also keeps the back button
   * meaning "the page before this one" rather than "un-tick one box".
   */
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${filterStateToQuery(state)}`,
    )
  }, [state])

  useEffect(() => {
    if (!sheetOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSheetOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sheetOpen])

  const toggle = (token: FilterToken) =>
    setState((current) => ({ ...current, selected: toggleToken(current.selected, token) }))
  const clear = () => setState((current) => ({ ...current, selected: [] }))

  const sheet = narrow && sheetOpen

  return (
    <div className="flex flex-1 flex-col">
      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-black/10 bg-background/90 px-4 py-2 backdrop-blur dark:border-white/10">
        {/* Hidden outright rather than only CSS-hidden on a wide screen, so
            it is out of the tab order there too. */}
        <button
          type="button"
          hidden={!narrow}
          aria-expanded={sheetOpen}
          aria-controls={railId}
          onClick={() => setSheetOpen((open) => !open)}
          className="rounded border border-black/15 px-3 py-1 text-sm lg:hidden dark:border-white/20"
        >
          Filters{state.selected.length > 0 ? ` (${state.selected.length})` : ''}
        </button>

        <p aria-live="polite" className="text-sm text-neutral-600 dark:text-neutral-400">
          {visible.length === entries.length
            ? `Showing ${entries.length} ${entries.length === 1 ? 'recipe' : 'recipes'}`
            : `Showing ${visible.length} of ${entries.length} recipes`}
        </p>

        <div className="ml-auto flex items-center gap-2">
          <label htmlFor={sortId} className="text-sm text-neutral-600 dark:text-neutral-400">
            Sort
          </label>
          <select
            id={sortId}
            value={state.sort}
            onChange={(event) =>
              setState((current) => ({ ...current, sort: event.target.value as SortKey }))
            }
            className="rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
          >
            {SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedValues.length > 0 && (
        <ul
          aria-label="Active filters"
          className="flex flex-wrap gap-2 border-b border-black/10 px-4 py-2 dark:border-white/10"
        >
          {selectedValues.map((value) => (
            <li key={value.token}>
              <button
                type="button"
                onClick={() => toggle(value.token)}
                className="rounded-full bg-black/5 px-2.5 py-1 text-xs dark:bg-white/10"
              >
                {value.label}
                <span aria-hidden="true"> ×</span>
                <span className="sr-only">, remove filter</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-1 items-start">
        {sheet && (
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setSheetOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          id={railId}
          aria-label="Filters"
          hidden={narrow && !sheetOpen}
          className={
            sheet
              ? 'fixed inset-x-0 bottom-0 z-50 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-black/10 bg-background p-4 pb-8 shadow-2xl dark:border-white/15'
              : 'w-56 shrink-0 self-stretch border-r border-black/10 p-4 max-lg:hidden lg:sticky lg:top-12 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto dark:border-white/10'
          }
        >
          <FilterRail
            groups={groups}
            onToggle={toggle}
            onClear={clear}
            selectedCount={state.selected.length}
          />
          {sheet && (
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="mt-5 w-full rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
            >
              Show {visible.length} {visible.length === 1 ? 'recipe' : 'recipes'}
            </button>
          )}
        </aside>

        <div className="min-w-0 flex-1 p-4">
          {entries.length === 0 ? (
            <p className="py-16 text-center text-sm text-neutral-600 dark:text-neutral-400">
              Nothing in the library yet. Add a recipe with the Add link above and it will show up
              here.
            </p>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                No recipes match these filters.
              </p>
              <button
                type="button"
                onClick={clear}
                className="rounded border border-black/15 px-3 py-1 text-sm dark:border-white/20"
              >
                Clear all filters
              </button>
            </div>
          ) : (
            <RecipeGrid entries={visible} />
          )}
        </div>
      </div>
    </div>
  )
}
