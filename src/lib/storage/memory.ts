import type { BlobStore, StoredBlob } from './index'

/** For tests. No network, no cleanup, isolated per instance. */
export function createMemoryStore(): BlobStore & { keys(): string[] } {
  const files = new Map<string, Uint8Array>()

  return {
    async put(key, data): Promise<StoredBlob> {
      // Copy, matching the real store: createVercelBlobStore passes the bytes
      // through Buffer.from(), which snapshots them. A double that aliased the
      // caller's array would let a mutate-after-store bug pass tests and fail
      // in production.
      const copy = data.slice()
      files.set(key, copy)
      return { key, url: `memory://${key}`, size: copy.byteLength }
    },
    async get(key) {
      // Copy on the way out too: a caller mutating what it read should not
      // corrupt the store for the next reader, matching the isolation a real
      // network round-trip would give for free.
      const stored = files.get(key)
      return stored ? stored.slice() : null
    },
    async delete(key) {
      files.delete(key)
    },
    keys: () => [...files.keys()],
  }
}
