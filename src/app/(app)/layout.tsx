import type { ReactNode } from 'react'
import Link from 'next/link'
import { auth, signOut } from '@/lib/auth'
import { db } from '@/lib/db'
import { countJobsNeedingAttention } from '@/lib/db/queries/jobs'
import { AppNav } from '@/components/shell/app-nav'

/**
 * The app shell: a wordmark, four section links, and who's signed in.
 *
 * This is a two-person app used mostly on a phone in a kitchen, so the header
 * has to fit a narrow viewport without resorting to a hamburger menu.
 * `flex-wrap` lets the identity/sign-out group drop to its own line on the
 * narrowest phones rather than truncating or overflowing, and the signed-in
 * name itself hides below the `sm` breakpoint since sign-out (not the name) is
 * the part that has to stay reachable. The nav scrolls horizontally rather
 * than wrapping, which keeps the row one line tall at any width.
 *
 * Every target in here is 44px tall. They were 20px — a text link's own line
 * box — which is not a size you can hit with a knuckle while holding a pan.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Two independent reads, not two round trips: `auth()` decodes the JWT
  // cookie already sent with the request (no DB query — see the session
  // strategy in `src/lib/auth.ts`), and `countJobsNeedingAttention` is a
  // single indexed `count(*)` with no rows to materialize. Both run on every
  // request through this layout.
  //
  // Deliberately not `listJobs(db)` filtered client-side for `status ===
  // 'failed'`, which is what this used to be: `listJobs` defaults to the
  // newest 50 rows of *every* status, so a failed job sitting behind 50+
  // newer successes — the 156-recipe migration burst is exactly this shape —
  // falls out of that window, and the badge reads 0 while `/needs-attention`
  // still lists the failure (see `tests/app/layout.test.tsx`). Counting with
  // the same status filter the tray itself queries on
  // (`listJobsNeedingAttention`'s `failed` / `running` / `queued`) is the fix
  // for the same reason it was the fix there: it has no row cap to fall out
  // of, and the badge and the tray agree on what "needs attention" means.
  const [session, needsAttentionCount] = await Promise.all([auth(), countJobsNeedingAttention(db)])

  return (
    <div className="flex min-h-full flex-col">
      {/*
        One row that never wraps, at every width.
        
        The earlier version let the whole header wrap, which on a 375px phone
        broke "Needs attention" across two lines and pushed "Sign out" onto a
        third — a three-line header above a grid you are trying to read while
        cooking. Now the brand and the sign-out control are fixed at the ends
        (`shrink-0`) and only the nav between them gives way, by scrolling.
      */}
      <header className="flex items-center gap-2 border-b border-line px-3 py-1.5 sm:gap-3 sm:px-4">
        <Link
          href="/"
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-1 text-base font-semibold tracking-tight text-ink"
        >
          <SiftedMark />
          {/* The mark alone identifies the app once the viewport is tight
              enough that the wordmark would cost the nav a link. */}
          <span className="max-[380px]:sr-only">Sifted</span>
        </Link>

        {/* Scrolls instead of wrapping. The scrollbar is hidden because a 3px
            horizontal bar under a nav row reads as a rendering fault rather
            than an affordance; the row is still swipeable and still tabbable. */}
        <div className="-mx-1 min-w-0 flex-1 overflow-x-auto px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <AppNav needsAttentionCount={needsAttentionCount} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {session?.user?.name && (
            <span className="hidden text-sm text-ink-muted sm:inline">{session.user.name}</span>
          )}
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/login' })
            }}
          >
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-md px-2 text-sm whitespace-nowrap text-ink-muted transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-sunken hover:text-ink sm:px-2.5"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  )
}

/**
 * The sifter from `public/icon.svg`, at 18px and inheriting the accent.
 *
 * The app has had this mark since the beginning and has never once shown it to
 * the person using the app — it lived only in the favicon and the home-screen
 * icon. Redrawn here rather than loaded as an image so it takes the token
 * colour and needs no network request.
 */
function SiftedMark() {
  return (
    <svg
      viewBox="0 0 512 512"
      className="h-[18px] w-[18px] text-accent-text"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M138 186h236" strokeWidth="34" strokeLinecap="round" />
      <path d="M150 204a106 104 0 0 0 212 0" strokeWidth="34" strokeLinecap="round" />
      <circle cx="206" cy="372" r="15" fill="currentColor" stroke="none" />
      <circle cx="256" cy="416" r="15" fill="currentColor" stroke="none" />
      <circle cx="306" cy="368" r="15" fill="currentColor" stroke="none" />
    </svg>
  )
}
