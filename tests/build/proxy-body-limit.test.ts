import { describe, it, expect } from 'vitest'
import nextConfig from '../../next.config'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'

/**
 * `src/proxy.ts` runs in front of the photo upload route, and Next buffers a
 * body for the proxy only up to `proxyClientMaxBodySize` — beyond it, the
 * route silently receives a truncated body. Nothing fails loudly: a large
 * photo simply arrives cut short and is refused as unreadable. This holds the
 * config above the upload cap.
 */
function toBytes(limit: string | number): number {
  if (typeof limit === 'number') return limit
  const match = /^(\d+)(b|kb|mb|gb)$/i.exec(limit.trim())
  if (!match) throw new Error(`unparseable limit: ${limit}`)
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[match[2].toLowerCase() as 'b' | 'kb' | 'mb' | 'gb']
  return Number(match[1]) * unit
}

describe('proxyClientMaxBodySize', () => {
  it('admits the largest photo we accept, with room for multipart overhead', () => {
    const limit = nextConfig.experimental?.proxyClientMaxBodySize
    expect(limit).toBeDefined()
    expect(toBytes(limit!)).toBeGreaterThanOrEqual(MAX_IMAGE_BYTES + 1024 * 1024)
  })
})
