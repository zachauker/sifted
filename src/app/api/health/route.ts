import { NextResponse } from 'next/server'

/**
 * Whether this deployment can actually extract a recipe.
 *
 * Every extraction path — `/api/import` from the phone Shortcut, and the
 * paste-HTML retry for a blocked publisher — needs to turn HTML into a DOM.
 * That parser is loaded as an *external* module at the top of those route
 * modules, so when it cannot load the module never evaluates and the failure
 * lands before any handler code runs: a bare 500 with no job row, no logged
 * reason, and nothing in the needs-attention tray. The app looks up while
 * every save silently fails — and on a phone it surfaces only as "the network
 * connection was lost", which says nothing about where to look.
 *
 * That has happened in production, from a dependency the app does not name and
 * did not change: jsdom reached a CommonJS package that `require()`s an
 * ES-module-only one, which Vercel's runtime forbids. `parseDocument` uses
 * linkedom now for exactly that reason, and this route is what proves it —
 * `requireModule` below is still false in production, so the constraint has
 * not gone away, only stopped mattering.
 *
 * It imports nothing heavy at module scope and pulls the parser in inside the
 * handler, because it has to survive exactly the failure it exists to report.
 *
 * Unauthenticated on purpose (see the matcher in `src/proxy.ts`): a health
 * check that needs a session cannot be read when the thing you are checking is
 * whether anyone can use the app. It discloses a Node version and a boolean,
 * and nothing about the library.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  // Exercises the DOM parser through the same module the extractor uses, and
  // actually parses something rather than only importing it. Probing `jsdom`
  // by name was right when jsdom was the parser; it is wrong now that jsdom is
  // only a test dependency — it would report this route degraded forever while
  // every import worked fine, which is a worse failure than saying nothing.
  let extraction: string
  try {
    const { parseDocument } = await import('@/lib/extract/dom')
    const doc = parseDocument('<html><body><h1>ok</h1></body></html>')
    extraction = doc.querySelector('h1')?.textContent === 'ok'
      ? 'ok'
      : 'the DOM parser loaded but did not parse'
  } catch (error) {
    extraction =
      error instanceof Error
        ? `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message.split('\n')[0]}`
        : String(error)
  }

  const healthy = extraction === 'ok'

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      node: process.version,
      // False means `require()` of an ES module throws, which is fatal to
      // jsdom and therefore to every import.
      requireModule: process.features.require_module ?? null,
      // How it got that way, which decides what can fix it. A flag on the
      // command line beats NODE_OPTIONS, so if `--no-experimental-require-module`
      // shows up in execArgv there is no environment variable that can undo
      // it; if it shows up only in nodeOptions, setting NODE_OPTIONS can.
      execArgv: process.execArgv,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      extraction,
    },
    { status: healthy ? 200 : 503 },
  )
}
