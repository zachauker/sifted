import type { ReactNode } from 'react'
import Link from 'next/link'
import { auth, signOut } from '@/lib/auth'
import { db } from '@/lib/db'
import { listJobs } from '@/lib/db/queries/jobs'

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
  // strategy in `src/lib/auth.ts`), and `listJobs` is a single indexed
  // query. Both run on every request through this layout; for two users
  // that's negligible, but if the job list grows large enough to notice,
  // this is the place to memoize or narrow the query to `status = 'failed'`.
  const [session, jobs] = await Promise.all([auth(), listJobs(db)])
  const failedCount = jobs.filter((job) => job.status === 'failed').length

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-black/10 px-3 py-2 text-sm dark:border-white/10">
        <nav className="flex items-center gap-4">
          <Link href="/" className="font-medium">
            Library
          </Link>
          <Link href="/add">Add</Link>
          <Link href="/needs-attention">
            Needs attention
            {failedCount > 0 && (
              <span className="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">
                {failedCount}
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
