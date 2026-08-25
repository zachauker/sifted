import { parseDurationMinutes } from './duration'

/**
 * Shared parsing rules for schema.org Recipe fields.
 *
 * `jsonld.ts` and `fromMicrodata` in `microdata.ts` map the same schema.org
 * vocabulary — JSON-LD and microdata are just two different serializations
 * of it — onto the same `PartialRecipe` contract. This module exists because
 * that overlap previously got re-implemented independently in each format
 * file, and the two copies quietly drifted apart: comma-separated tags,
 * "N dozen" servings, and the totalTime/prepTime+cookTime fallback were each
 * handled correctly in one file and wrong (or missing) in the other. Any rule
 * for turning a raw schema.org field value into a contract field belongs
 * here, not duplicated per format.
 *
 * Keep every helper here pure and format-agnostic: it must not know about
 * JSON-LD nodes or DOM elements, only about strings — that is what keeps it
 * trivially shareable and independently testable.
 */

/**
 * Splits a single schema.org field value that may hold multiple
 * comma-separated entries into individual trimmed, non-empty entries.
 *
 * Comma-joined values in one field are the dominant real-world shape for
 * `recipeCategory`, `recipeCuisine`, and `keywords` — e.g. a single
 * `<meta itemprop="keywords" content="italian, pasta, one pot">`, or a
 * JSON-LD `"keywords":"creamy garlic butter Tuscan shrimp, Shrimp, tuscan
 * shrimp"`. A value with no commas passes through as a single-entry list.
 */
export function splitCommaSeparated(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * "Dozen" yields are common on baking blogs (cookies, rolls, cinnamon buns)
 * and must be checked before the bare-digit fallback below — otherwise
 * "1 dozen" would read as 1 serving instead of 12, and "a dozen" (no leading
 * digit) would read as 0/null instead of 12.
 */
const DOZEN = /(\d+)?\s*dozen/i

/**
 * Parses a schema.org `recipeYield` string into a serving count. Handles the
 * "N dozen" idiom before falling back to the first bare integer in the text,
 * and rejects non-positive results so "0 servings" resolves to null ("no
 * data") rather than the misleading real answer of zero.
 */
export function parseServingsText(text: string): number | null {
  const dozenMatch = DOZEN.exec(text)
  if (dozenMatch) {
    const dozens = dozenMatch[1] ? Number(dozenMatch[1]) : 1
    return Number.isFinite(dozens) && dozens > 0 ? dozens * 12 : null
  }

  const match = /\d+/.exec(text)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Resolves a recipe's total claimed time in minutes from schema.org's
 * totalTime/prepTime/cookTime trio. Prefers an explicit `totalTime`, and
 * falls back to `prepTime + cookTime` when it is absent — many pages give
 * the components (10 min prep, 25 min cook) but never emit a totalTime of
 * their own.
 */
export function resolveClaimedTimeMinutes(
  totalTime: string | null | undefined,
  prepTime: string | null | undefined,
  cookTime: string | null | undefined
): number | null {
  const total = parseDurationMinutes(totalTime)
  if (total !== null) return total

  const prep = parseDurationMinutes(prepTime)
  const cook = parseDurationMinutes(cookTime)
  if (prep === null && cook === null) return null
  return (prep ?? 0) + (cook ?? 0)
}
