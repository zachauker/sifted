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
 * Renders as "wide" on the server and on the first client paint, because
 * there is no viewport to measure yet; the effect corrects it before paint
 * on a narrow screen. The rail also carries `max-lg:hidden` while closed,
 * so CSS hides it on a phone even in that first frame — the two agree, and
 * neither depends on the other having run.
 */
export function useNarrowViewport(query = '(max-width: 1023px)'): boolean {
  const [narrow, setNarrow] = useState(false)

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
