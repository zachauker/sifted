'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'
import './globals.css'

/**
 * Next catches a throw from the root layout (or from a render that no nearer
 * `error.tsx` boundary covers) and renders this instead — which means Sentry
 * never sees it from the global handler, because React already handled it.
 * The `captureException` below is the only reason the error is reported at
 * all; without this file, the worst class of client failure in the app is the
 * one class Sentry would miss.
 *
 * It replaces the root layout entirely, so it has to supply its own `html`
 * and `body` and import the stylesheet itself.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm">
            <h1 className="mb-2 text-xl font-semibold">Something went wrong</h1>
            <p className="mb-6 text-sm text-neutral-600">
              The error has been reported. Reloading usually clears it.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
            >
              Reload
            </button>
            {/*
              The digest is the only handle on a server-render failure that
              appears in both the browser and the server log, so it is shown
              rather than swallowed.
            */}
            {error.digest ? (
              <p className="mt-6 font-mono text-xs text-neutral-400">{error.digest}</p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  )
}
