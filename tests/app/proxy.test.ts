import { describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { NextAuthRequest } from 'next-auth'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'

/**
 * `@/proxy` imports `@/lib/auth`, which imports `@/lib/db` — a real
 * libsql client that throws synchronously if `TURSO_DATABASE_URL` is unset
 * (confirmed by hand: `createClient({ url: undefined })` throws
 * `URL_INVALID` before any query ever runs). Mocked here the same way
 * `tests/api/import-route.test.ts` mocks it, so this suite never needs a
 * real database or a real `AUTH_SECRET` for the parts of the file that
 * don't touch a real session (the matcher, and `decide` called directly).
 */
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))

// `auth()` throws `MissingSecretError` if `AUTH_SECRET` is unset outside of
// `NODE_ENV=test` — vitest sets `NODE_ENV=test` itself, but this is set
// explicitly (and only here) so the one test that exercises the real
// `auth()`-wrapped handler doesn't depend on that being true forever. It is
// not a real secret and signs nothing anyone relies on.
process.env.AUTH_SECRET ??= 'middleware-test-only-not-a-real-secret'

const { config, decide, default: middleware } = await import('@/proxy')

function pageRequest(pathname: string, cookie?: string): NextRequest {
  const init: RequestInit = {}
  if (cookie) init.headers = { cookie }
  return new NextRequest(new Request(`http://localhost:3000${pathname}`, init))
}

/** Attaches `.auth` the same way NextAuth's `auth()` wrapper does before calling `decide`. */
function withAuth(request: NextRequest, auth: NextAuthRequest['auth']): NextAuthRequest {
  return Object.assign(request, { auth })
}

const fakeSession: NonNullable<NextAuthRequest['auth']> = {
  user: { id: 'u1', name: 'Test User', email: 'test@example.com' },
  expires: '2099-01-01T00:00:00.000Z',
}

describe('middleware matcher (the actual `config.matcher` the middleware runs, not a copy)', () => {
  it.each([
    ['/', true],
    ['/recipes/abc123', true],
    ['/api/library-index', true],
    ['/login', true],
  ])('runs the middleware for %s', (path, expected) => {
    expect(
      unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${path}` }),
    ).toBe(expected)
  })

  it.each([
    ['/api/import', false],
    ['/api/auth/session', false],
    ['/api/auth/callback/credentials', false],
    ['/_next/static/chunks/main.js', false],
    ['/_next/image', false],
    ['/favicon.ico', false],
  ])('never runs the middleware for %s', (path, expected) => {
    expect(
      unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${path}` }),
    ).toBe(expected)
  })
})

describe('decide (the per-request authorization decision, unit tested directly)', () => {
  it('redirects an unauthenticated request for the library root to /login', () => {
    const result = decide(withAuth(pageRequest('/'), null))
    expect(result).toBeInstanceOf(NextResponse)
    expect(result?.status).toBe(307)
    expect(result?.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it('redirects an unauthenticated request for a recipe page to /login', () => {
    const result = decide(withAuth(pageRequest('/recipes/abc123'), null))
    expect(result?.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it('401s an unauthenticated API request instead of redirecting, since an API client cannot follow a redirect', async () => {
    const result = decide(withAuth(pageRequest('/api/library-index'), null))
    expect(result?.status).toBe(401)
    expect(await result?.json()).toEqual({ error: 'Unauthorized' })
  })

  it('lets an authenticated page request through untouched', () => {
    const result = decide(withAuth(pageRequest('/'), fakeSession))
    expect(result).toBeUndefined()
  })

  it('lets an authenticated API request through untouched', () => {
    const result = decide(withAuth(pageRequest('/api/library-index'), fakeSession))
    expect(result).toBeUndefined()
  })

  it('lets /login through even when signed out, so the sign-in page itself is reachable', () => {
    const result = decide(withAuth(pageRequest('/login'), null))
    expect(result).toBeUndefined()
  })

  it('lets /login through when already signed in (the login page redirects away itself)', () => {
    const result = decide(withAuth(pageRequest('/login'), fakeSession))
    expect(result).toBeUndefined()
  })
})

describe('the real auth()-wrapped handler (src/proxy.ts default export)', () => {
  it('redirects to /login for a page request with no session cookie at all, without throwing', async () => {
    const response = await middleware(pageRequest('/'), {} as never)
    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(307)
    expect(response?.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it('401s an API request with no session cookie, without throwing', async () => {
    const response = await middleware(pageRequest('/api/library-index'), {} as never)
    expect(response?.status).toBe(401)
  })

  it('treats a malformed/garbage session cookie as signed-out and redirects, rather than 500ing', async () => {
    const response = await middleware(
      pageRequest('/', 'authjs.session-token=not-a-real-jwt-at-all'),
      {} as never,
    )
    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(307)
    expect(response?.headers.get('location')).toBe('http://localhost:3000/login')
  })
})
