'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The header's navigation, and the app's only reason for shipping JavaScript
 * to the shell.
 *
 * It exists as a client component for one thing: knowing which section you are
 * in. The header used to be four links at the same weight, size and colour,
 * which meant it told you where you could go but never where you were. A
 * server component cannot read the pathname, and this is small enough — four
 * links and a comparison — that the trade is worth it. It sits in the shell,
 * not in the recipe, so the page you actually cook from still ships as HTML
 * with no hydration of its own.
 */

const LINKS = [
  { href: '/', label: 'Library' },
  { href: '/add', label: 'Add' },
  { href: '/needs-attention', label: 'Needs attention' },
  { href: '/settings', label: 'Settings' },
] as const

/**
 * `/` matches only itself; everything else matches its own subtree, so
 * `/recipes/x` is not "Library" but `/settings/anything` is "Settings".
 * Recipe pages deliberately light nothing up — you arrived from the library
 * but you are not in it any more.
 */
function isCurrent(pathname: string | null, href: string): boolean {
  // `usePathname` is typed `string` but really is nullable — it returns null
  // wherever there is no router context, which includes a component rendered
  // straight into jsdom by a unit test. Nothing here is important enough to
  // throw over: no pathname simply means nothing is current.
  if (!pathname) return false
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppNav({ needsAttentionCount }: { needsAttentionCount: number }) {
  const pathname = usePathname()

  return (
    <nav className="flex w-max items-center gap-0.5" aria-label="Sections">
      {LINKS.map((link) => {
        const current = isCurrent(pathname, link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            // `aria-current="page"` is the part that matters: the colour and
            // weight change is for people who can see it, and this is for
            // everyone else. Both say the same thing.
            aria-current={current ? 'page' : undefined}
            // `shrink-0` and `whitespace-nowrap` together are what make the
            // scrolling row work: without them flexbox compresses the links
            // instead of overflowing, so "Needs attention" broke onto two
            // lines and "Settings" got clipped mid-word rather than either of
            // them simply scrolling out of view.
            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap transition-colors duration-(--dur-fast) ease-(--ease-out-quart) sm:px-3 ${
              current
                ? 'bg-sunken font-semibold text-ink'
                : 'text-ink-muted hover:bg-sunken hover:text-ink'
            }`}
          >
            {link.label}
            {link.href === '/needs-attention' && needsAttentionCount > 0 && (
              <span
                className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 py-0.5 font-num text-2xs font-semibold text-accent-ink tabular-nums"
                // The count is already in the link's own accessible name via
                // the visually-hidden text below, so the badge itself is
                // decoration as far as a screen reader is concerned.
                aria-hidden="true"
              >
                {needsAttentionCount}
              </span>
            )}
            {link.href === '/needs-attention' && needsAttentionCount > 0 && (
              <span className="sr-only">
                {`, ${needsAttentionCount} ${needsAttentionCount === 1 ? 'import needs' : 'imports need'} attention`}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
