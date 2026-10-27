import * as Sentry from '@sentry/nextjs'

/**
 * Edge-runtime Sentry init. Nothing in this app targets the edge today —
 * Proxy defaults to Node in Next 16 and no route opts out — so this file is a
 * safety net: if a route ever does set `runtime = 'edge'`, its errors are
 * captured from the first deploy instead of vanishing until someone notices
 * the gap.
 *
 * The edge runtime has no `includeLocalVariables` (that needs the Node
 * debugger), hence the shorter config than `sentry.server.config.ts`.
 */
Sentry.init({
  dsn:
    process.env.SENTRY_DSN ??
    'https://274d0a9d6903b1d0a216ecb166917ac2@o4512329318400000.ingest.us.sentry.io/4512329337208832',

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,

  tracesSampleRate: 1,
})
