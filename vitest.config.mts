import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    // Node stays the default: all but ~30 of the tests here are database,
    // extraction and route tests that neither need nor want a DOM. The
    // component tests under `tests/components/` opt into jsdom per file
    // with a `// @vitest-environment jsdom` docblock, which is why there is
    // no second Vitest project — a project split would mean maintaining two
    // copies of the alias and `server.deps` config below, and would make
    // `npx vitest run <one file>` behave differently depending on which
    // project claimed the file. One config, one include list, one opt-in
    // line at the top of the two files that need it.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // `next-auth` and `@auth/core` are pure ESM (`"type": "module"`) and
    // import the bare specifier `next/server` internally. `next` ships that
    // as plain CommonJS with no `exports` field in its `package.json` —
    // Next's own bundler special-cases resolving it, but by default Vitest
    // loads already-ESM packages via Node's native loader rather than
    // Vite's, and Node's loader can't find an extensionless `next/server`
    // that way ("Cannot find module '.../next/server'... Did you mean
    // "next/server.js"?"). Inlining forces these two through Vite's own
    // resolver instead, which resolves it fine. Needed by anything that
    // imports `@/lib/auth` (e.g. `tests/app/middleware.test.ts`).
    server: {
      deps: {
        inline: ['next-auth', '@auth/core'],
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
