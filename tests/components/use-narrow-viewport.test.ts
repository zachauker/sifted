// @vitest-environment jsdom
//
// `useNarrowViewport` decides whether the filter rail renders as a sidebar
// or a bottom sheet, and Defect 1 (the lockout) lived entirely in what
// query it asked and what it assumed before the answer arrived. Both are
// unit-testable in isolation from the rail itself.
//
// What this file cannot cover: jsdom does not implement `matchMedia` at
// all (`window.matchMedia` is `undefined` here — confirmed by probing it
// directly), so no test in this repo can drive a *real* `rem`-vs-`px`
// media-query mismatch the way a browser with a non-default root font size
// would. `tests/components/filter-rail.test.tsx` stubs `matchMedia` to
// return a fixed `matches` value regardless of the query string, which
// exercises the rail's narrow/wide *behaviour* but not the query text
// itself. This file closes that gap the other way: it asserts on the exact
// string handed to `matchMedia`, so a future edit that reintroduces a `px`
// query (or any query other than the one Tailwind's `lg` breakpoint
// compiles to) fails a test even though no test file can run a real
// browser's media-query engine.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useNarrowViewport } from '@/components/library/use-narrow-viewport'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the query useNarrowViewport asks', () => {
  it('asks matchMedia the same feature Tailwind\'s compiled `max-lg:hidden` / `lg:hidden` use', () => {
    // Tailwind's default `lg` breakpoint is `64rem`, compiled to
    // `@media (min-width: 64rem)` (and, negated, to what `max-lg:hidden`
    // uses). `rem` is not a fixed number of pixels — it tracks the
    // browser's root font size, a user-controllable accessibility setting
    // — so a hook that asked in `px` (the previous, buggy version asked
    // `(max-width: 1023px)`) was measuring a different thing than the CSS,
    // and the two could disagree. Asking `matchMedia` for the identical
    // token removes the possibility of disagreement: whatever the root
    // font size, the browser's own media-query engine evaluates both the
    // same way.
    const seen: string[] = []
    vi.stubGlobal('matchMedia', (query: string) => {
      seen.push(query)
      return {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }
    })

    renderHook(() => useNarrowViewport())

    expect(seen).toEqual(['not (min-width: 64rem)'])
  })
})

describe('the state before the effect has run', () => {
  it('defaults to narrow — reachable-toggle-on-a-wide-screen beats a hidden rail', () => {
    // No matchMedia stub at all: this is the state on the very first
    // render, server or client, before any effect has had a chance to
    // measure the real viewport. A wide-screen default here means a wrong
    // guess hides the toggle with nothing on screen able to reach the
    // rail (Defect 1); a narrow-screen default means a wrong guess shows a
    // superfluous button for one frame. The hook is required to guess
    // narrow.
    vi.stubGlobal('matchMedia', undefined)

    const { result } = renderHook(() => useNarrowViewport())

    expect(result.current).toBe(true)
  })

  it('stays narrow when matchMedia is unavailable, rather than reproducing the lockout silently', () => {
    // The old implementation returned early and left `narrow` at its
    // default of `false` (wide) when `matchMedia` didn't exist — hiding
    // the toggle exactly the way the rem/px mismatch did, just via a
    // different door. The default is now narrow, so the same early return
    // leaves the toggle reachable instead.
    vi.stubGlobal('matchMedia', undefined)

    const { result, rerender } = renderHook(() => useNarrowViewport())
    rerender()

    expect(result.current).toBe(true)
  })
})

describe('once matchMedia answers', () => {
  function stubMatches(matches: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
  }

  it('reports narrow when the query matches', () => {
    stubMatches(true)
    const { result } = renderHook(() => useNarrowViewport())
    expect(result.current).toBe(true)
  })

  it('reports wide when the query does not match', () => {
    stubMatches(false)
    const { result } = renderHook(() => useNarrowViewport())
    expect(result.current).toBe(false)
  })

  it('updates when the media query change event fires', () => {
    let changeHandler: (() => void) | undefined
    let matches = false
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, handler: () => void) => {
        changeHandler = handler
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))

    const { result, rerender } = renderHook(() => useNarrowViewport())
    expect(result.current).toBe(false)

    matches = true
    act(() => changeHandler?.())
    rerender()

    expect(result.current).toBe(true)
  })
})
