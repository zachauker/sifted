import * as Sentry from '@sentry/nextjs'

/**
 * Next calls `register` once when a server instance starts, and waits for it
 * before serving anything — so Sentry is initialized before any request can
 * throw. The two runtimes need separate `init` calls with different options,
 * which is what `NEXT_RUNTIME` picks between.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

/**
 * Next hands server-side render and route errors to this hook rather than
 * letting them reach a process-level handler, so without it the whole
 * App Router half of the app would report nothing. `captureRequestError` also
 * attaches the route and router kind Next passes alongside the error.
 */
export const onRequestError = Sentry.captureRequestError
