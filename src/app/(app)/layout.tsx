import type { ReactNode } from 'react'
import Link from 'next/link'
import { auth, signOut } from '@/lib/auth'
import { db } from '@/lib/db'
import { countJobsNeedingAttention } from '@/lib/db/queries/jobs'

/**
 * The app shell: a single-row header with four things in it — a link to the
 * library, a link to add a recipe, a needs-attention link that surfaces a
 * failed-import count, and who's signed in with a way to sign out. Nothing
 * else. This is a two-person app used mostly on a phone in a kitchen, so the
 * header has to fit a narrow viewport without resorting to a hamburger menu:
 * `flex-wrap` lets the identity/sign-out group drop to its own line on the
 * narrowest phones rather than truncating or overflowing, and the signed-in
 * name itself hides below the `sm` breakpoint since sign-out (not the name)
 * is the part that has to stay reachable.
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
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-black/10 px-3 py-2 text-sm dark:border-white/10">
        <nav className="flex items-center gap-4">
          <Link href="/" className="font-medium">
            Library
          </Link>
          <Link href="/add">Add</Link>
          <Link href="/settings">Settings</Link>
          <Link href="/needs-attention">
            Needs attention
            {needsAttentionCount > 0 && (
              <span className="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">
                {needsAttentionCount}
              </span>
            )}
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          {session?.user?.name && (
            <span className="hidden text-neutral-500 sm:inline dark:text-neutral-400">
              {session.user.name}
            </span>
          )}
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/login' })
            }}
          >
            <button type="submit" className="underline underline-offset-2">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  )
}
