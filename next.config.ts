import type { NextConfig } from 'next'

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

export default nextConfig
