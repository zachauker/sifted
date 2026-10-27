import * as Sentry from '@sentry/nextjs'

/**
 * Node-runtime Sentry init — route handlers, Server Components, Server
 * Actions, and the `proxy.ts` session check (Proxy runs on Node by default as
 * of Next 16). Loaded by `src/instrumentation.ts`, which Next calls once per
 * server instance before it serves a single request.
 *
 * The release name is deliberately not set here: the SDK reads
 * `VERCEL_GIT_COMMIT_SHA` on its own (see
 * `@sentry/core/.../utils/commitEnv.js`), so every production event is already
 * tagged with the commit that produced it — which is what makes regression
 * detection and "resolve in next release" work.
 */
Sentry.init({
  dsn:
    process.env.SENTRY_DSN ??
    'https://274d0a9d6903b1d0a216ecb166917ac2@o4512329318400000.ingest.us.sentry.io/4512329337208832',

  // Separates production from preview deploys and from local dev.
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,

  // Two users; see the note in `instrumentation-client.ts`.
  tracesSampleRate: 1,

  // Attaches the value of each local variable to its stack frame, which is
  // the difference between "something threw in extract" and seeing the actual
  // URL that broke it.
  //
  // NOTE: this is why it is worth knowing about — locals include whatever was
  // in scope, so a throw inside `src/lib/api-auth.ts` or an LLM call could put
  // a bearer token or an API key into the event. Those events only go to our
  // own Sentry project, and `sendDefaultPii` stays off (no `dataCollection`
  // object is passed below, so request bodies, cookies and user info are not
  // collected), but set this to `false` if that trade stops being worth it.
  includeLocalVariables: true,
})
