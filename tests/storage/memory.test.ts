import { describe, it, expect } from 'vitest'
import { createMemoryStore } from '@/lib/storage/memory'

describe('memory blob store', () => {
  it('round-trips bytes unchanged', async () => {
    const store = createMemoryStore()
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const stored = await store.put('a/b.bin', data, 'application/octet-stream')

    expect(stored.size).toBe(4)
    expect(await store.get('a/b.bin')).toEqual(data)
  })

  it('returns null for a missing key', async () => {
    expect(await createMemoryStore().get('nope')).toBeNull()
  })

  it('overwrites an existing key', async () => {
    const store = createMemoryStore()
    await store.put('k', new Uint8Array([1]), 'application/octet-stream')
    await store.put('k', new Uint8Array([2]), 'application/octet-stream')
    expect(await store.get('k')).toEqual(new Uint8Array([2]))
    expect(store.keys()).toEqual(['k'])
  })

  it('deletes', async () => {
    const store = createMemoryStore()
    await store.put('k', new Uint8Array([1]), 'application/octet-stream')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })
})
