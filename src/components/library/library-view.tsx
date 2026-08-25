'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { searchEntries } from '@/lib/library/search'
import { FilterRail } from './filter-rail'
import { RecipeGrid } from './recipe-grid'
import { useNarrowViewport } from './use-narrow-viewport'

/**
 * Where the currently-shown search results came from — the thing the spec
 * insists gets said out loud rather than left to guesswork.
 *
 * `'none'`: no search text; the grid is showing whatever the filter rail
 * allows, unaffected by search. `'local'`: tier 1 — `searchEntries` over the
 * in-memory index, matching titles, publishers and tags. `'server'`: tier
 * 2 — the last completed `/api/search` response for the *current* query
 * text, matching inside ingredients, steps, notes and the narrative via
 * FTS5. A query edited after a server search reverts to `'local'`
 * automatically (see `serverSearch.query` below), because a stale server
 * answer for a different query is not this query's answer.
 */
type SearchMode = 'none' | 'local' | 'server'

type ServerSearchState = {
  status: 'idle' | 'loading' | 'done' | 'error'
  /** The query this result (or in-flight request) belongs to. */
  query: string
  ids: string[]
}

const IDLE_SERVER_SEARCH: ServerSearchState = { status: 'idle', query: '', ids: [] }

/**
 * A value that only catches up with `value` once it has stopped changing
 * for `delayMs`.
 *
 * Exists for exactly one caller: the screen-reader announcement of the
 * results summary. Typing "chicken" fires seven `onChange` events, and a
 * live region wired straight to the visible summary reads all seven
 * sentences out loud, one after another, because `aria-live="polite"`
 * queues every distinct value it ever saw rather than only the final one.
 * The visible text does *not* go through this — a sighted reader benefits
 * from the count updating on every keystroke, and only the announcement
 * needs throttling.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}

/** The subset of Tab-reachable, non-disabled elements inside `container`. */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]',
    ),
  ).filter((el) => el.tabIndex !== -1 && !el.hasAttribute('disabled'))
}

/**
 * The library screen: a persistent filter rail beside a photo grid, and on
 * a phone the same rail as a bottom sheet.
 *
 * The whole index arrives as a prop from the server component — 69KB for
 * 156 recipes — so every filter click, sort change and count update is a
 * synchronous pass over an array in memory. There is no fetch, no loading
 * state, and no cache to invalidate. Measured at well under a millisecond
 * for the real library size; see `tests/components/library-grid.test.tsx`.
 *
 * Search adds one real network call, and only one: typing narrows the grid
 * instantly via tier 1 (`searchEntries`, matching titles/publishers/tags),
 * and a clearly-labelled "Search inside recipes" control opts into tier 2
 * (`GET /api/search`, matching ingredients/steps/notes/narrative via FTS5).
 * Both tiers narrow whatever the filter rail already allows, never replace
 * it — see `displayed` below.
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
  const [query, setQuery] = useState('')
  const [serverSearch, setServerSearch] = useState<ServerSearchState>(IDLE_SERVER_SEARCH)
  const narrow = useNarrowViewport()
  const railId = useId()
  const sortId = useId()
  const searchId = useId()

  // The bottom sheet's dialog semantics: where focus goes when it opens,
  // and where it comes back to when it closes.
  const dialogRef = useRef<HTMLElement>(null)
  const filtersToggleRef = useRef<HTMLButtonElement>(null)
  const wasSheetOpenRef = useRef(false)

  const groups = useMemo(
    () => computeFacetCounts(entries, state.selected),
    [entries, state.selected],
  )
  // The filter rail's own effect, before search narrows it further. Facet
  // counts in the rail are deliberately computed from `entries` above, not
  // from this — a text search should not make filter-rail counts jump
  // around under someone's cursor while they type.
  const railFiltered = useMemo(() => applyFilterState(entries, state), [entries, state])
  const selectedValues = useMemo(
    () => groups.flatMap((group) => group.values.filter((value) => value.selected)),
    [groups],
  )

  const trimmedQuery = query.trim()
  // A server result only counts as "the answer" while it belongs to the
  // query currently in the box — editing the query after searching inside
  // recipes falls back to tier 1 for the new text rather than keeping a
  // stale answer on screen.
  const serverMatchesQuery = serverSearch.query === trimmedQuery && trimmedQuery !== ''
  const serverLoading = serverMatchesQuery && serverSearch.status === 'loading'
  const serverErrored = serverMatchesQuery && serverSearch.status === 'error'
  const serverActive = serverMatchesQuery && serverSearch.status === 'done'

  const mode: SearchMode = trimmedQuery === '' ? 'none' : serverActive ? 'server' : 'local'

  /** Filtered by the rail, then narrowed by whichever search tier is active. */
  const displayed = useMemo(() => {
    if (mode === 'server') {
      const ids = new Set(serverSearch.ids)
      return railFiltered.filter((entry) => ids.has(entry.id))
    }
    if (mode === 'local') return searchEntries(railFiltered, trimmedQuery)
    return railFiltered
  }, [mode, railFiltered, serverSearch.ids, trimmedQuery])

  /**
   * Filter state lives in the URL so a narrowed view survives a reload and
   * can be handed to the other person in the house. It is written with
   * `history.replaceState` rather than a router navigation on purpose: a
   * navigation would re-run the server component and re-send the whole
   * index on every checkbox click, which is exactly the round trip this
   * design exists to avoid. `replaceState` also keeps the back button
   * meaning "the page before this one" rather than "un-tick one box".
   *
   * Search text is deliberately not carried into the URL alongside the
   * filters: it is a transient "find it right now" tool, not a saved view,
   * and the query box is the one thing here that must never be touched by
   * an effect that runs behind the reader's back while they are mid-type.
   */
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${filterStateToQuery(state)}`,
    )
  }, [state])

  const toggle = (token: FilterToken) =>
    setState((current) => ({ ...current, selected: toggleToken(current.selected, token) }))
  const clear = () => setState((current) => ({ ...current, selected: [] }))
  const clearSearch = () => {
    setQuery('')
    setServerSearch(IDLE_SERVER_SEARCH)
  }

  /**
   * Runs tier 2. Deliberately does not touch `state` (the filter rail) or
   * re-focus/re-select the input — the whole point of the probe in the
   * task write-up is that this control must not reset filters or steal
   * focus out from under someone still typing.
   */
  async function searchInsideRecipes() {
    const q = trimmedQuery
    if (q === '') return
    setServerSearch({ status: 'loading', query: q, ids: [] })
    try {
      const res = await fetch(`/api/search?${new URLSearchParams({ q })}`)
      if (!res.ok) throw new Error(`search failed: ${res.status}`)
      const body = (await res.json()) as { ids: string[] }
      setServerSearch({ status: 'done', query: q, ids: body.ids })
    } catch {
      setServerSearch({ status: 'error', query: q, ids: [] })
    }
  }

  const sheet = narrow && sheetOpen

  /**
   * Focus, on the way in and on the way out.
   *
   * On open, focus moves into the sheet — onto the dialog container itself
   * (it carries `tabIndex={-1}` for exactly this), rather than onto some
   * particular control inside it, so a screen reader announces the dialog
   * before whatever happens to be first in it. On close, focus is expected
   * to be somewhere inside a subtree that's about to disappear (or, for
   * Escape, nowhere useful) — left alone, it drops to `<body>`, which is
   * indistinguishable from "focus went nowhere" to anyone not looking at
   * the screen. It goes back to the button that opened the sheet instead,
   * which is also exactly where a person's thumb still is.
   *
   * `wasSheetOpenRef` is what keeps this from firing on first mount, when
   * `sheet` starts `false` and there is nothing to return focus *from*.
   */
  useEffect(() => {
    if (sheet) {
      dialogRef.current?.focus()
    } else if (wasSheetOpenRef.current) {
      filtersToggleRef.current?.focus()
    }
    wasSheetOpenRef.current = sheet
  }, [sheet])

  /**
   * Keeps Tab (and Shift+Tab) cycling within the open sheet instead of
   * walking out into the 156 cards sitting behind the scrim, and keeps
   * Escape as one of the sheet's three ways to close. Both live in one
   * listener because both are "the sheet owns the keyboard while it's
   * open" — a real focus trap, not just a promise that nothing outside it
   * happens to be reachable by mouse.
   */
  useEffect(() => {
    if (!sheet) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSheetOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const container = dialogRef.current
      if (!container) return
      const focusable = focusableElements(container)
      if (focusable.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const outside = !(active instanceof Node) || !container.contains(active)
      if (event.shiftKey ? active === first || outside : active === last || outside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sheet])

  // iOS scroll-chains: reach the end of the sheet's own scroll and the
  // finger keeps scrolling, but now it's the page behind the scrim moving.
  // Locking the body's scroll for as long as the sheet is open is what
  // stops that, and it is exactly as long as the sheet actually blocks
  // interaction with the rest of the page.
  useEffect(() => {
    if (!sheet) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [sheet])

  /**
   * The compact, always-on-screen count in the toolbar. Deliberately uses
   * "Showing N — matched..." phrasing even at zero, rather than a fully
   * different sentence like "No matches found": the detailed explanation
   * and next step for a zero-result search live in the empty state below
   * instead, and giving the two spots distinct wording keeps a query like
   * `getByText(/no titles.*match/i)` from finding this one too.
   */
  function resultsSummary(): string {
    if (mode === 'server') {
      return `Showing ${displayed.length} ${displayed.length === 1 ? 'recipe' : 'recipes'} — matched inside recipes for "${trimmedQuery}"`
    }
    if (mode === 'local') {
      return `Showing ${displayed.length} ${displayed.length === 1 ? 'recipe' : 'recipes'} — matched titles, publishers, and tags for "${trimmedQuery}"`
    }
    return railFiltered.length === entries.length
      ? `Showing ${entries.length} ${entries.length === 1 ? 'recipe' : 'recipes'}`
      : `Showing ${railFiltered.length} of ${entries.length} recipes`
  }

  const summary = resultsSummary()
  // See `useDebouncedValue` above: the visible text tracks `summary`
  // exactly, keystroke for keystroke; only what gets announced lags behind
  // by half a second of silence, so a screen reader hears the sentence
  // once typing pauses rather than once per character.
  const announcedSummary = useDebouncedValue(summary, 500)

  return (
    <div className="flex flex-1 flex-col">
      {/* Visually hidden: the toolbar below is dense enough already, and
          every other route's visible `<h1>` is a page-name header this
          route deliberately has no room for. The document still needs
          exactly one, so it exists — just not on screen. */}
      <h1 className="sr-only">Recipe library</h1>

      <div
        // `inert` while the sheet is open takes the whole toolbar — search
        // box, sort, the Filters toggle itself — out of the tab order and
        // the accessibility tree along with everything else behind the
        // scrim, the other half of the focus trap below: that one stops
        // Tab from leaving the dialog, this stops a click or a screen
        // reader's virtual cursor from reaching behind it.
        inert={sheet}
        data-testid="library-toolbar"
        className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-black/10 bg-background/90 px-4 py-2 backdrop-blur dark:border-white/10"
      >
        {/* Hidden outright rather than only CSS-hidden on a wide screen, so
            it is out of the tab order there too. */}
        <button
          type="button"
          ref={filtersToggleRef}
          hidden={!narrow}
          aria-expanded={sheetOpen}
          aria-controls={railId}
          onClick={() => setSheetOpen((open) => !open)}
          className="min-h-11 rounded border border-black/15 px-3 py-1 text-sm lg:hidden dark:border-white/20"
        >
          Filters{state.selected.length > 0 ? ` (${state.selected.length})` : ''}
        </button>

        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            void searchInsideRecipes()
          }}
          className="flex items-center gap-2"
        >
          <label htmlFor={searchId} className="sr-only">
            Search recipes
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles, publishers, tags…"
            // `text-base` (16px), not `text-sm` (14px): iOS Safari zooms in
            // on focus for any input under 16px and does not zoom back out
            // on blur, leaving the whole page zoomed. `sm:text-sm` reverts
            // to the tighter size once the viewport is wide enough that
            // nothing is zooming on tap in the first place.
            className="min-h-11 w-48 rounded border border-black/15 bg-transparent px-2 py-1 text-base sm:w-64 sm:text-sm dark:border-white/20"
          />
          <button
            type="submit"
            disabled={trimmedQuery === '' || serverLoading}
            className="min-h-11 rounded border border-black/15 px-3 py-1 text-sm whitespace-nowrap disabled:opacity-50 dark:border-white/20"
          >
            {serverLoading ? 'Searching…' : 'Search inside recipes'}
          </button>
          {trimmedQuery !== '' && (
            <button
              type="button"
              onClick={clearSearch}
              className="inline-flex min-h-11 items-center px-2 text-xs underline underline-offset-2"
            >
              Clear search
            </button>
          )}
        </form>

        {/* Visible copy, unthrottled: a sighted reader benefits from the
            count updating on every keystroke. */}
        <p data-testid="results-summary" className="text-sm text-neutral-600 dark:text-neutral-400">
          {summary}
        </p>
        {/* The screen-reader announcement of the same sentence, debounced
            (see `useDebouncedValue`) so typing "chicken" produces one
            announcement after the pause instead of seven mid-word ones.
            `role="status"` carries its own implicit `aria-live="polite"`
            and `aria-atomic="true"`, so the whole sentence is read, not a
            diff of it. Separate from the visible paragraph above on
            purpose — debouncing that one too would mean the on-screen
            count lagging behind the grid it describes. */}
        <p role="status" className="sr-only">
          {announcedSummary}
        </p>

        {serverErrored && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Searching inside recipes failed. Try again.
          </p>
        )}

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
            className="min-h-11 rounded border border-black/15 bg-transparent px-2 py-1 text-base sm:text-sm dark:border-white/20"
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
          inert={sheet}
          aria-label="Active filters"
          className="flex flex-wrap gap-2 border-b border-black/10 px-4 py-2 dark:border-white/10"
        >
          {selectedValues.map((value) => (
            <li key={value.token}>
              <button
                type="button"
                onClick={() => toggle(value.token)}
                className="min-h-11 rounded-full bg-black/5 px-2.5 py-1 text-xs dark:bg-white/10"
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
          ref={dialogRef}
          aria-label="Filters"
          hidden={narrow && !sheetOpen}
          // `role="dialog"` and `aria-modal` only apply while this is
          // actually behaving like one — the bottom sheet on a phone. On a
          // laptop it's a persistent, non-modal region of the page, and
          // giving it dialog semantics there would tell a screen reader
          // the rest of the page is unavailable when it manifestly isn't.
          role={sheet ? 'dialog' : undefined}
          aria-modal={sheet ? true : undefined}
          // Lets the effect above move focus onto the sheet itself when it
          // opens, and gives the keyboard trap a container-level fallback
          // to focus if the sheet somehow opens with nothing focusable
          // inside it.
          tabIndex={sheet ? -1 : undefined}
          className={
            sheet
              ? 'fixed inset-x-0 bottom-0 z-50 max-h-[75vh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-black/10 bg-background p-4 pb-8 shadow-2xl outline-none dark:border-white/15'
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
              className="mt-5 min-h-11 w-full rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
            >
              Show {displayed.length} {displayed.length === 1 ? 'recipe' : 'recipes'}
            </button>
          )}
        </aside>

        <div inert={sheet} data-testid="library-grid-region" className="min-w-0 flex-1 p-4">
          {entries.length === 0 ? (
            <p className="py-16 text-center text-sm text-neutral-600 dark:text-neutral-400">
              Nothing in the library yet. Add a recipe with the Add link above and it will show up
              here.
            </p>
          ) : railFiltered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                No recipes match these filters.
              </p>
              <button
                type="button"
                onClick={clear}
                className="min-h-11 rounded border border-black/15 px-3 py-1 text-sm dark:border-white/20"
              >
                Clear all filters
              </button>
            </div>
          ) : displayed.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {mode === 'server'
                  ? `No matches inside recipes for "${trimmedQuery}" — searched ingredients, steps, and notes.`
                  : // The one place this ever gets seen is a title/publisher/tag
                    // miss, so it says in plain words that a second, different
                    // search is one click away — matching the "Search inside
                    // recipes" button already in the toolbar above, not a second
                    // copy of it here.
                    `No titles, publishers, or tags match "${trimmedQuery}". It may still be in there — try the "Search inside recipes" button above to look inside ingredients, steps, and notes.`}
              </p>
              {/* Not a second "Clear search" button: the toolbar's own is
                  already on screen whenever there's a query to clear, and a
                  duplicate here would be two controls doing one thing. */}
            </div>
          ) : (
            <RecipeGrid entries={displayed} />
          )}
        </div>
      </div>
    </div>
  )
}
