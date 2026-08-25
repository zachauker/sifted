export type StoredBlob = { key: string; url: string; size: number }

/**
 * Everything that writes bytes goes through this interface, so moving from
 * Vercel Blob to Cloudflare R2 is a one-module change rather than a search
 * across the codebase. A 156-recipe library needs roughly 150MB of hero
 * images, thumbnails, and gzipped source; if that exceeds the free tier, this
 * is the seam where it gets swapped.
 */
export type BlobStore = {
  put(key: string, data: Uint8Array, contentType: string): Promise<StoredBlob>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}
