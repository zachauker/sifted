'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/lib/auth'

export type LoginState = { error: string } | null

/**
 * Deliberately the same message whether the email doesn't match any account
 * or the password is wrong for one that does. `src/lib/auth.ts` compares
 * against a dummy bcrypt hash in constant time specifically so a failed
 * attempt can't be used to tell those two cases apart — a more specific
 * error here ("no account with that email" vs. "wrong password") would leak
 * exactly what that comparison exists to hide. Do not split this into
 * per-case messages, however helpful that might look.
 */
const GENERIC_ERROR = 'Email or password is incorrect.'

export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get('email')
  const password = formData.get('password')

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return { error: GENERIC_ERROR }
  }

  try {
    await signIn('credentials', { email, password, redirectTo: '/' })
  } catch (error) {
    // `signIn` throws Next's internal redirect signal on success — that is
    // not an `AuthError` and must propagate so the redirect actually
    // happens, hence the rethrow in the `else` branch below.
    if (error instanceof AuthError) {
      return { error: GENERIC_ERROR }
    }
    throw error
  }

  return null
}
