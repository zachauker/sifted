const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i

/**
 * Converts an ISO 8601 duration (schema.org's format for totalTime, prepTime,
 * cookTime) to whole minutes. Returns null for absent, malformed, or zero
 * durations so that "no data" and "zero minutes" are never confused.
 */
export function parseIsoDurationMinutes(value: string | undefined | null): number | null {
  if (!value) return null
  const match = ISO_DURATION.exec(value.trim())
  if (!match) return null

  const [, days, hours, minutes, seconds] = match
  if (!days && !hours && !minutes && !seconds) return null

  const total =
    Number(days ?? 0) * 24 * 60 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Number(seconds ?? 0) / 60

  const rounded = Math.ceil(total)
  return rounded > 0 ? rounded : null
}
