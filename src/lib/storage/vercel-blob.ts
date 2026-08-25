import { put, del } from '@vercel/blob'
import type { BlobStore, StoredBlob } from './index'

export function createVercelBlobStore(token = process.env.BLOB_READ_WRITE_TOKEN): BlobStore {
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set')

  return {
    async put(key, data, contentType): Promise<StoredBlob> {
      const result = await put(key, Buffer.from(data), {
        access: 'public',
        contentType,
        token,
        // Keys are derived from the recipe id, so we control uniqueness and
        // want a re-import to overwrite rather than accumulate suffixed copies.
        addRandomSuffix: false,
        allowOverwrite: true,
      })
      return { key, url: result.url, size: data.byteLength }
    },

    async get(key) {
      throw new Error(`get() is not implemented for Vercel Blob (key: ${key})`)
    },

    async delete(key) {
      await del(key, { token })
    },
  }
}
