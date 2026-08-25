import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { LoginForm } from './login-form'

export default async function LoginPage() {
  // Already signed in: middleware lets /login through unconditionally (see
  // src/middleware.ts), so this is the one place that has to send a
  // signed-in visitor back out again rather than showing them a sign-in
  // form for an account they're already using.
  const session = await auth()
  if (session?.user) redirect('/')

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-xl font-semibold">Sign in</h1>
        <LoginForm />
      </div>
    </div>
  )
}
