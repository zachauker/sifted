import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
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
