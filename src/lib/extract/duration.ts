const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i

/**
 * Recipes legitimately span days — sourdough, cured meats, long ferments — so the
 * ceiling is deliberately generous. Beyond it, the value is certainly a malformed
 * feed rather than a real cook time, and null ("no data") is more useful than a
 * number that would distort every time filter it lands in.
 */
const MAX_REASONABLE_MINUTES = 43_200 // 30 days

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
  if (rounded <= 0 || rounded > MAX_REASONABLE_MINUTES) return null
  return rounded
}
