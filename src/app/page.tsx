import { auth, signOut } from '@/lib/auth'

/**
 * A deliberately bare stand-in for the library grid.
 *
 * This file has to live here, outside `src/app/(app)/`, rather than as
 * `src/app/(app)/page.tsx`: the two would both resolve to the same URL
 * (`/`, since route groups don't add a URL segment) and collide, and a
 * later task builds the real library grid at `(app)/page.tsx` — a file this
 * task is explicitly scoped to leave alone. So this page does not get the
 * app shell header from `(app)/layout.tsx`; it only exists to replace the
 * create-next-app scaffold with something real, and to prove — by actually
 * rendering the signed-in user and a working sign-out control — that
 * middleware, the session, and sign-out all work end to end. Once the
 * library grid lands at `(app)/page.tsx`, this file should be deleted.
 *
 * Reaching this component at all already implies a session: the middleware
 * (`src/proxy.ts`) redirects any unauthenticated request for `/` to
 * `/login` before this ever renders.
 */
export default async function Home() {
  const session = await auth()

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-lg">Signed in as {session?.user?.name ?? session?.user?.email}.</p>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        The library view is coming soon.
      </p>
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
  )
}
