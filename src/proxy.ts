import { NextResponse } from 'next/server'
import type { NextAuthRequest } from 'next-auth'
import { auth } from '@/lib/auth'

/**
 * Every page and API route requires a session, with three exceptions:
 *
 *  - `/login` — has to be reachable while signed out, obviously. The
 *    already-signed-in-visits-`/login` case is handled by the login page
 *    itself (`src/app/login/page.tsx`), not here — this function only ever
 *    has to decide "let it through" for that path.
 *  - `/api/auth/*` — NextAuth's own sign-in/callback/session endpoints.
 *    They must be reachable unauthenticated, or nobody could ever sign in.
 *  - `/api/import` — the iOS Shortcut that shares a recipe from a phone has
 *    no session cookie, so it authenticates with a bearer token instead
 *    (see `src/lib/api-auth.ts`). It never reaches the check below: the
 *    matcher excludes it outright, the same way it excludes `/api/auth/*`.
 *    If this ever started passing through `decide`, a bearer-only client
 *    would get redirected or 401'd before its own auth even ran.
 *
 * Getting this wrong in the permissive direction exposes the whole recipe
 * library, so the decision itself is a small, pure function that is unit
 * tested directly (see `tests/app/middleware.test.ts`), independent of the
 * `auth()` wrapper below that supplies `req.auth`.
 */
export function decide(req: NextAuthRequest): NextResponse | undefined {
  // Signed in — or /login, where it doesn't matter either way — passes
  // through unchanged.
  if (req.auth || req.nextUrl.pathname === '/login') return undefined

  // An API client can't follow a 3xx to an HTML login form, so it gets a
  // 401 it can actually act on instead of a redirect it can't.
  if (req.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.redirect(new URL('/login', req.nextUrl))
}

export default auth(decide)

/**
 * `/api/auth` and `/api/import` are excluded here, in the matcher, rather
 * than inside `decide` — that makes the exclusion a build-time-checkable
 * fact about which requests this file ever sees at all, rather than a
 * runtime `if` that a future edit to `decide` could quietly weaken. Static
 * assets are excluded too, so a phone loading the app shell doesn't pay for
 * a session check (and a JWT decode) per JS chunk and optimized image.
 *
 * Note this does *not* cover every file under `public/` — only Next's own
 * `_next/static`, `_next/image`, and `favicon.ico`. Nothing in this app
 * currently references a public asset outside those (no logo, no manifest
 * icon), so it hasn't mattered yet; adding one later would need either an
 * addition here or would otherwise require a session to load, which for an
 * image would fail silently rather than loudly.
 */
export const config = {
  matcher: ['/((?!api/auth|api/import|_next/static|_next/image|favicon.ico).*)'],
}
