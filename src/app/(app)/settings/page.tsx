import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { listTokens } from '@/lib/db/queries/tokens'
import { TokenManager } from './token-manager'

/**
 * Only thing here so far: API tokens, one per device, for the iOS Shortcut
 * (`docs/ios-shortcut.md`). Middleware already requires a session for this
 * route; the `redirect` below is belt-and-braces for the case where `auth()`
 * somehow returns nothing here anyway, so this page never renders a token
 * list for `session.user.id` when `session.user` is undefined.
 */
export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

  const tokens = await listTokens(db, session.user.id)

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="mb-1 text-xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
        API tokens for the iOS Shortcut. Each token belongs to one device, so
        losing a phone means revoking one token — everything else keeps
        working.
      </p>
      <TokenManager initialTokens={tokens} />
    </div>
  )
}
