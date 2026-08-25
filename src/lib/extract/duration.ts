const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i

/**
 * Recipes legitimately span days — sourdough, cured meats, long ferments — so the
 * ceiling is deliberately generous. Beyond it, the value is certainly a malformed
 * feed rather than a real cook time, and null ("no data") is more useful than a
 * number that would distort every time filter it lands in.
 */
const MAX_REASONABLE_MINUTES = 43_200 // 30 days

/**
 * A single "<number> <unit>" chunk inside a freeform duration string, e.g. the
 * "1 hr" and "30 min" halves of "1 hr 30 min". The number half accepts a plain
 * integer, a decimal ("1.5"), a mixed number ("1 1/2"), or a bare fraction
 * ("1/2"). The unit half is deliberately narrow (hour/hr/h, minute/min/m) so it
 * never accidentally swallows an unrelated word.
 */
const FREEFORM_TOKEN = /(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/g

const BARE_NUMBER = /^\d+(?:\.\d+)?$/

/** Separator text allowed between (or around) freeform tokens: whitespace, commas, "and". */
const SEPARATOR_ONLY = /^[\s,]*(?:and)?[\s,]*$/

/**
 * Applies the same rounding and range rules to a raw minute total that the ISO
 * path has always used, so freeform and ISO results are indistinguishable to
 * callers: zero and negative totals collapse to null (never confused with "no
 * data" vs "zero minutes"), and anything past the 30-day ceiling is treated as
 * malformed rather than trusted.
 */
function finalizeMinutes(totalMinutes: number): number | null {
  const rounded = Math.ceil(totalMinutes)
  if (rounded <= 0 || rounded > MAX_REASONABLE_MINUTES) return null
  return rounded
}

/** Parses "12" or "1.5" or "1 1/2" or "1/2" into a plain number of that unit. */
function parseFreeformNumber(raw: string): number {
  const mixed = raw.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) {
    const [, whole, numerator, denominator] = mixed
    return Number(whole) + Number(numerator) / Number(denominator)
  }
  const fraction = raw.match(/^(\d+)\/(\d+)$/)
  if (fraction) {
    const [, numerator, denominator] = fraction
    return Number(numerator) / Number(denominator)
  }
  return Number(raw)
}

/**
 * Freeform fallback for recipe sites that don't emit ISO 8601 durations. Bon
 * Appétit — 28% of recipes seen in the wild — puts plain English straight into
 * schema.org's totalTime field instead: `"totalTime":"3 hours"`. Without this
 * fallback every one of those recipes silently loses its cook time.
 *
 * The whole (trimmed) string must resolve to duration content: either a bare
 * number (treated as minutes — the overwhelming convention when a recipe site
 * omits a unit), or one or more "<number> <hour|minute unit>" tokens separated
 * only by whitespace, commas, or "and". Anything left over — stray words,
 * numbers with no unit, numbers attached to a different concept entirely —
 * fails the match and returns null.
 *
 * That "no leftovers" rule is deliberate, not incidental: a wrong duration
 * silently corrupts a time filter the user trusts, while null is at least
 * visibly absent, so ambiguous input is rejected rather than guessed at. It is
 * also what keeps this from mis-parsing "Serves 4, ready in 30 minutes" (the
 * unrelated "4" leaves unmatched text around the real duration) and from
 * guessing at "1 hour 30" (the trailing bare "30" has no unit, so it could be
 * minutes, seconds, or a typo — this returns null rather than assume 90).
 */
function parseFreeformDurationMinutes(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (BARE_NUMBER.test(trimmed)) {
    return finalizeMinutes(Number(trimmed))
  }

  const lower = trimmed.toLowerCase()
  const tokenRegex = new RegExp(FREEFORM_TOKEN)
  let match: RegExpExecArray | null
  let cursor = 0
  let totalMinutes = 0
  let matchedAny = false

  while ((match = tokenRegex.exec(lower)) !== null) {
    const between = lower.slice(cursor, match.index)
    if (!SEPARATOR_ONLY.test(between)) return null

    const [full, numberText, unitText] = match
    const amount = parseFreeformNumber(numberText)
    totalMinutes += unitText.startsWith('h') ? amount * 60 : amount

    matchedAny = true
    cursor = match.index + full.length
  }

  if (!matchedAny) return null
  if (!SEPARATOR_ONLY.test(lower.slice(cursor))) return null

  return finalizeMinutes(totalMinutes)
}

/**
 * Converts a schema.org duration value to whole minutes. Tries the strict ISO
 * 8601 format first (schema.org's documented format for totalTime, prepTime,
 * cookTime); if that fails, falls back to freeform English durations that
 * real-world feeds emit instead — see parseFreeformDurationMinutes for why
 * that fallback exists and what it will and won't guess at. Returns null for
 * absent, malformed, or zero durations so that "no data" and "zero minutes"
 * are never confused.
 */
export function parseIsoDurationMinutes(value: string | undefined | null): number | null {
  if (!value) return null

  const match = ISO_DURATION.exec(value.trim())
  if (match) {
    const [, days, hours, minutes, seconds] = match
    if (!days && !hours && !minutes && !seconds) return null

    const total =
      Number(days ?? 0) * 24 * 60 +
      Number(hours ?? 0) * 60 +
      Number(minutes ?? 0) +
      Number(seconds ?? 0) / 60

    return finalizeMinutes(total)
  }

  return parseFreeformDurationMinutes(value)
}
