import * as Sentry from '@sentry/nextjs'

/**
 * Browser-side Sentry init. Next runs this file after the document loads but
 * *before* React hydrates (see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md`),
 * which is early enough to catch a crash in the very first render.
 *
 * The DSN is not a secret — it only names the project events are sent to, and
 * it ships inside the client bundle whatever we do. It is written in here as a
 * fallback rather than read from the environment alone, because a missing env
 * var in a deployment would otherwise turn error reporting off silently, which
 * is the one failure mode monitoring must not have. Set
 * `NEXT_PUBLIC_SENTRY_DSN` to point a deployment at a different project.
 */
Sentry.init({
  dsn:
    process.env.NEXT_PUBLIC_SENTRY_DSN ??
    'https://274d0a9d6903b1d0a216ecb166917ac2@o4512329318400000.ingest.us.sentry.io/4512329337208832',

  // `VERCEL_ENV` is server-only; Vercel mirrors it into
  // `NEXT_PUBLIC_VERCEL_ENV` ('production' | 'preview' | 'development') for
  // exactly this purpose. Without it, a preview deploy's noise lands in the
  // same bucket as a real error from the phone on the counter and there is no
  // way to tell them apart after the fact.
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,

  // This app has two users, so there is no quota argument for throwing traces
  // away: 100% buys full navigation and request timing for every visit. The
  // usual 0.1 production default exists for apps with real traffic.
  tracesSampleRate: 1,

  // Replays are the thing that makes "it broke on my phone" reproducible, so
  // every session that produced an error is recorded. Text and media are
  // masked by default, which is why recording ordinary sessions at all is
  // acceptable here.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,

  integrations: [Sentry.replayIntegration()],
})

/**
 * App Router navigations happen client-side, so Sentry only sees them if Next
 * hands them over. Without this export navigation spans are missing from every
 * trace and the SDK warns about it at build time.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
