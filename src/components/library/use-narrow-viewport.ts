'use client'

import { useEffect, useState } from 'react'

/**
 * Matches the Tailwind `lg` breakpoint from JavaScript.
 *
 * The filter rail has to be one component with one state on both layouts —
 * a sidebar on a laptop, a bottom sheet on a phone — and the difference
 * between them is not purely visual: on a phone the closed sheet must be
 * out of the tab order and out of the accessibility tree, and on a laptop
 * it must never be. CSS alone cannot tell the component which it is, so it
 * asks.
 *
 * ## The query has to be the CSS's own token, not a translation of it
 *
 * Tailwind's compiled stylesheet hides the rail with `max-lg:hidden` and
 * the toggle with `lg:hidden`, which both compile to `@media (min-width:
 * 64rem)` (negated for the rail). `64rem` is *not* 1024px: it resolves
 * against the browser's root font size, which a person can change (Chrome
 * and Safari's "Large" text setting puts it at 1280px) and which page zoom
 * changes at fractional widths. A query written in `px` — the previous
 * version of this hook used `(max-width: 1023px)` — measures a different
 * thing than the CSS does, and at settings other than the browser default
 * the two disagree: CSS can hide the rail while this hook still believes
 * the viewport is wide, hiding the toggle too. No rail, no toggle, no way
 * to filter at all. Passing `matchMedia` the exact same `(min-width: 64rem)`
 * feature Tailwind emits means both are evaluated by the same engine
 * against the same root font size — they cannot disagree, whatever that
 * size is set to.
 *
 * ## The default state is biased toward "reachable"
 *
 * There is no viewport to measure on the server or on the very first
 * client paint, so this starts out assuming narrow — the toggle is shown,
 * not the rail. That is a deliberate asymmetry: guessing "narrow" and being
 * wrong means a Filters button flashes on a wide screen for one frame
 * before the effect (which runs after that paint — this is `useEffect`,
 * not `useLayoutEffect`; nothing here corrects anything *before* paint)
 * measures the real viewport and hides it again. Guessing "wide" and being
 * wrong is the lockout this hook exists to prevent: on a narrow screen the
 * toggle would stay hidden, with nothing on screen able to reach the rail.
 * A briefly-superfluous button is a cosmetic flaw; a hidden one is a dead
 * end, so the guess errs toward the button.
 *
 * The same reasoning covers `matchMedia` being absent altogether (very old
 * browsers, or a test environment that hasn't stubbed it): the effect
 * bails out early and the state never leaves its initial "narrow" guess,
 * which keeps the toggle reachable rather than silently reproducing the
 * lockout.
 */
export function useNarrowViewport(query = 'not (min-width: 64rem)'): boolean {
  const [narrow, setNarrow] = useState(true)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return narrow
}
