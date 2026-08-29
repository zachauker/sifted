import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * `engines.node` must pin a runtime that can `require()` an ES module.
 *
 * This is not housekeeping. `jsdom` — which every extraction path goes
 * through — reaches `html-encoding-sniffer@6`, which is CommonJS and does:
 *
 *   const { getBOMEncoding } = require("@exodus/bytes/encoding-lite.js")
 *
 * and `@exodus/bytes` is `"type": "module"`. Node only made `require()` of an
 * ES module work in 22.12; below that it throws ERR_REQUIRE_ESM. Nothing in
 * this repo's own code is wrong, and no test catches it, because the failure
 * is a property of the *deployed runtime* rather than of the source:
 *
 *   Failed to load external module jsdom-4cccfac9827ebcfe:
 *   ERR_REQUIRE_ESM: require() of ES Module @exodus/bytes/encoding-lite.js
 *   from html-encoding-sniffer/lib/html-encoding-sniffer.js not supported
 *
 * That is a real production 500, taken from `/api/jobs/[id]/retry`. It takes
 * down every route that extracts: the paste-HTML recovery for a blocked
 * publisher, and `/api/import`, which is the phone Shortcut — i.e. the whole
 * app, on any host that defaults to an older Node.
 *
 * A dashboard setting cannot be the fix, because it is invisible from here and
 * silently reverts to a platform default on a new project or a new host. The
 * repo has to state its own requirement.
 *
 * Reproduce the failure on any Node with:
 *   node --no-experimental-require-module -e "require('jsdom')"
 */
const MIN_MAJOR = 22
const MIN_MINOR = 12

describe('engines.node', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { engines?: { node?: string } }

  it('is declared', () => {
    expect(pkg.engines?.node).toBeTypeOf('string')
  })

  it('cannot be satisfied by a Node that throws ERR_REQUIRE_ESM', () => {
    const range = pkg.engines?.node ?? ''
    const match = /(\d+)(?:\.(\d+))?/.exec(range)
    expect(match, `could not read a minimum version out of "${range}"`).not.toBeNull()

    const major = Number(match![1])
    const minor = Number(match![2] ?? 0)
    // `24.x` and `>=24` both parse to 24.0, which is fine: any Node 24 can
    // require an ES module. Only a range that admits something below 22.12
    // fails here.
    expect(
      major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR),
      `engines.node is "${range}", which allows a Node older than ` +
        `${MIN_MAJOR}.${MIN_MINOR} — jsdom cannot load there, so every ` +
        'extraction route returns 500',
    ).toBe(true)
  })
})
