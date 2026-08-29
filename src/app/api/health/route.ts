import { NextResponse } from 'next/server'

/**
 * Whether this deployment can actually extract a recipe.
 *
 * Every extraction path — `/api/import` from the phone Shortcut, and the
 * paste-HTML retry for a blocked publisher — goes through `jsdom`, and jsdom
 * is loaded as an *external* CommonJS module at the top of those route
 * modules. When it cannot load, the module never evaluates, so the failure
 * lands before any handler code runs: a bare 500 with no job row, no logged
 * reason, and nothing in the needs-attention tray. The app looks like it is
 * up. Every save silently fails.
 *
 * That has now happened in production, from a dependency the app does not
 * name and did not change: jsdom reaches a CommonJS package that
 * `require()`s an ES-module-only one, which only works on Node 22.12+.
 *
 * So this route deliberately imports nothing heavy at module scope, and
 * pulls jsdom in dynamically inside the handler — it has to survive exactly
 * the failure it is here to report. `process.features.require_module` is the
 * flag that decides whether that require can work at all, which makes it the
 * single most useful number to be able to read from outside.
 *
 * Unauthenticated on purpose (see the matcher in `src/proxy.ts`): a health
 * check that needs a session cannot be read when the thing you are checking
 * is whether anyone can use the app. It discloses a Node version and a
 * boolean, and nothing about the library.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  let jsdom: string
  try {
    await import('jsdom')
    jsdom = 'ok'
  } catch (error) {
    jsdom =
      error instanceof Error
        ? `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message.split('\n')[0]}`
        : String(error)
  }

  const healthy = jsdom === 'ok'

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      node: process.version,
      // False means `require()` of an ES module throws, which is fatal to
      // jsdom and therefore to every import.
      requireModule: process.features.require_module ?? null,
      extraction: jsdom,
    },
    { status: healthy ? 200 : 503 },
  )
}
