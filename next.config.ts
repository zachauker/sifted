import type { NextConfig } from 'next'
// v11 moved this out of the package root into its own entry point.
import { withSentryConfig } from '@sentry/nextjs/config'

const nextConfig: NextConfig = {
  images: {
    // Hero images live in blob storage on a different host, so next/image
    // needs them allowlisted. Recipe cards currently pass `unoptimized`,
    // because ingestHeroImage already writes exactly the 480px WebP rendition
    // a card draws and re-encoding a purpose-built file buys nothing.
    //
    // This entry exists anyway: without it, dropping that prop is a *runtime*
    // failure in production that no test or build catches, and every card
    // breaks at once. Cheap insurance against a one-word edit.
    remotePatterns: [
      { protocol: 'https', hostname: '**.public.blob.vercel-storage.com' },
    ],
  },
  experimental: {
    // `src/proxy.ts` sits in front of every `/api/recipes/*` route, and Next
    // buffers a body for the proxy only up to this limit (10 MB by default).
    // Past it the route handler gets a *truncated* body with no error — a
    // large phone photo would arrive cut short and be refused as unreadable.
    // Photo uploads are capped at 15 MB (`MAX_IMAGE_BYTES`); this leaves room
    // for the multipart envelope. `tests/build/proxy-body-limit.test.ts`
    // holds the two together.
    proxyClientMaxBodySize: '17mb',
  },
}

export default withSentryConfig(nextConfig, {
  org: 'willowbrook',
  project: 'sifted',

  // Build-time secret, and a different thing from the DSN: it authorizes
  // uploading source maps. Absent (local builds), the build still succeeds and
  // simply skips the upload.
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Without this, frames from Next's own code and from dependencies stay
  // minified, which is exactly where a hydration or router error lands.
  widenClientFileUpload: true,

  // Ad blockers block requests to `*.sentry.io` outright, and a browser that
  // does so reports nothing at all — silently. Routing events through our own
  // origin instead is the only way client errors and replays survive that.
  // The path is fixed rather than `true` (which randomizes it per build)
  // because `proxy.ts`'s matcher has to name it, and matchers are static.
  tunnelRoute: '/monitoring',

  // Quiet locally, verbose in CI where the output is the only record.
  silent: !process.env.CI,
})
