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

  // `includeLocalVariables` is deliberately absent, and this note is here so
  // nobody turns it back on without meeting the reason it is off.
  //
  // It attaches the value of every local variable to its stack frame, which is
  // genuinely useful — the difference between "something threw in extract" and
  // seeing the URL that broke it. But locals are whatever was in scope, so a
  // throw inside `src/lib/api-auth.ts` or an LLM call would carry a bearer
  // token or an API key into the event. Not worth it for the debugging help.
  //
  // Off across all of these projects, for consistency rather than per-repo
  // judgement. `false` is already the SDK default, so the option is omitted
  // rather than set explicitly. `sendDefaultPii` also stays off: no
  // `dataCollection` object is passed, so request bodies, cookies and user
  // info are not collected either.
})
