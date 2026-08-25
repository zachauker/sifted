import type { BlobStore, StoredBlob } from './index'

/** For tests. No network, no cleanup, isolated per instance. */
export function createMemoryStore(): BlobStore & { keys(): string[] } {
  const files = new Map<string, Uint8Array>()

  return {
    async put(key, data): Promise<StoredBlob> {
      files.set(key, data)
      return { key, url: `memory://${key}`, size: data.byteLength }
    },
    async get(key) {
      return files.get(key) ?? null
    },
    async delete(key) {
      files.delete(key)
    },
    keys: () => [...files.keys()],
  }
}
