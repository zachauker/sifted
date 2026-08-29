'use client'

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'

const initialState: LoginState = null

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="min-h-11 rounded-md border border-line bg-bg px-3 text-base transition-colors duration-(--dur-fast) hover:border-line-strong focus:border-accent"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="min-h-11 rounded-md border border-line bg-bg px-3 text-base transition-colors duration-(--dur-fast) hover:border-line-strong focus:border-accent"
        />
      </div>
      {state?.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 min-h-11 rounded-md bg-accent px-4 text-base font-semibold text-accent-ink transition-colors duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-accent-hover disabled:opacity-60 disabled:hover:bg-accent"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
