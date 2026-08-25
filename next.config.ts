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
}

export default nextConfig
