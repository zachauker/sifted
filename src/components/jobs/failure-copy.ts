import type { FailureKind } from '@/lib/db/queries/jobs'

/**
 * How a person can recover from a given `FailureKind`. This is the whole
 * point of `FailureKind` existing: `blocked` needs HTML pasted from a real
 * browser, `no_recipe` needs the job dropped rather than retried, and
 * everything else is worth an ordinary retry.
 */
export type RecoveryAction = 'retry' | 'paste-html' | 'remove'

export type FailureExplanation = {
  /** Short label naming what happened. */
  heading: string
  /** Plain-language sentence a person in a kitchen can read at a glance. */
  body: string
  action: RecoveryAction
  /** Only meaningful when `action === 'retry'`. */
  retryLabel?: string
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // Not expected — `import_jobs.url` is only ever written from a URL that
    // already parsed once, in the import route. Falls back to something
    // readable rather than crashing the tray over a malformed row.
    return 'This site'
  }
}

/**
 * The per-kind copy the needs-attention tray shows.
 *
 * A `Record<FailureKind, ...>` rather than a `switch` with a `default`: if a
 * sixth kind is ever added to the `failure_kind` enum in the schema, leaving
 * it out of this map is a compile error here, not a card that silently
 * renders no explanation. A kind with no explanation is worse than no tray
 * at all, because it looks handled.
 */
export const FAILURE_COPY: Record<
  FailureKind,
  (job: { url: string; error: string | null }) => FailureExplanation
> = {
  blocked: (job) => ({
    heading: 'Blocked by the publisher',
    body:
      `${hostnameOf(job.url)} won't let our server open this page — it refuses requests ` +
      'it thinks come from a datacenter, even though a browser on a home connection would ' +
      "get through fine. Retrying without changing anything will fail the same way, so this " +
      'one needs the page pasted in by hand instead.',
    action: 'paste-html',
  }),
  fetch_failed: () => ({
    heading: "Couldn't reach the page",
    body:
      'A network or server problem stopped the page from loading. This is usually ' +
      'temporary — an ordinary retry is worth trying.',
    action: 'retry',
    retryLabel: 'Retry',
  }),
  llm_failed: () => ({
    heading: 'Recipe reader was unavailable',
    body:
      "The page loaded fine — the recipe just wasn't read out of it. The tool that does " +
      'that was temporarily unavailable or busy. It usually works on a second try.',
    action: 'retry',
    retryLabel: 'Try again in a bit',
  }),
  no_recipe: () => ({
    heading: 'No recipe on this page',
    body:
      "We read the whole page and didn't find a recipe on it. Retrying won't change that " +
      "— the content simply isn't there. It's safe to remove this from the list.",
    action: 'remove',
  }),
  internal: (job) => ({
    heading: 'Something went wrong on our end',
    body: job.error
      ? `An unexpected error happened while importing this page: ${job.error}`
      : 'An unexpected error happened while importing this page.',
    action: 'retry',
    retryLabel: 'Retry',
  }),
}

/**
 * `failureKind` is nullable in the schema even though `markFailed` always
 * sets one — a defensive fallback for a `failed` row that somehow has none,
 * rather than letting that row throw or render blank.
 */
export function explainFailure(job: {
  url: string
  error: string | null
  failureKind: FailureKind | null
}): FailureExplanation {
  if (job.failureKind) return FAILURE_COPY[job.failureKind](job)
  return {
    heading: 'Import failed',
    body: job.error
      ? `This import failed and wasn't categorized. Raw error: ${job.error}`
      : "This import failed and wasn't categorized, and no further detail was recorded.",
    action: 'retry',
    retryLabel: 'Retry',
  }
}
