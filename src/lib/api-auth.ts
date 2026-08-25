import { db } from '@/lib/db'
import { verifyToken, type VerifiedToken } from '@/lib/db/queries/tokens'

/**
 * Authenticates a request carrying `Authorization: Bearer <token>`. Used by the
 * iOS Shortcut, which has no session cookie.
 */
export async function authenticateBearer(request: Request): Promise<VerifiedToken | null> {
  const header = request.headers.get('authorization') ?? ''
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null
  return verifyToken(db, value)
}
