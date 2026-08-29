/**
 * The line format the recipe editor and the manual-entry route both speak: one
 * ingredient or step per line, with a line ending in a colon acting as a
 * section header for everything beneath it.
 *
 * Pure — no I/O, no database, no React — so the rules live in one testable
 * place. `parseLines` moved here from `src/app/api/recipes/manual/route.ts`
 * for exactly that reason: two write paths quietly disagreeing about what a
 * blank line means is the drift its own comment warned about.
 */

export type SectionedLine = { section: string | null; text: string }

/**
 * One entry per non-blank line, trimmed.
 *
 * A blank line — including one that is only whitespace — is dropped rather
 * than stored as an empty ingredient or step row; a stray blank line from
 * pasting a recipe out of Notes or an email must not become a phantom row
 * with nothing in it.
 *
 * Splits on `\r\n`, `\r`, and `\n` so a textarea's value survives a paste
 * from Windows (`\r\n`) as cleanly as from anywhere else — a lone `\r` left
 * in would otherwise ride along inside the last "line" of a `\r\n`-joined
 * paste, or turn a single logical line into two.
 */
export function parseLines(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * The section label a line declares, or null if it is an ordinary line.
 *
 * A bare `:` is not a header: it declares an empty label, which would render
 * as a nameless heading on the recipe page.
 */
function headerLabel(line: string): string | null {
  if (!line.endsWith(':')) return null
  const label = line.slice(0, -1).trim()
  return label.length > 0 ? label : null
}

/**
 * Lines with the section each one belongs to. A header line is consumed, never
 * stored, only when at least one row ends up beneath it — a header is the
 * `section` value on those rows. A header-shaped line with nothing beneath it
 * (the last line in the text, or immediately followed by another header) is
 * not treated as a header at all: it is stored as an ordinary line, carrying
 * whatever section was already in effect.
 *
 * No line's text may be silently discarded — that is the rule, full stop. A
 * hand-typed ingredient ending in a colon is not the reason: nobody types
 * that. The population this format actually meets is extractor output, and
 * `src/lib/extract/index.ts` stores every extracted ingredient with
 * `section: null`, so a source that spells its sections as pseudo-ingredient
 * rows ("For the sauce:", "Optional toppings:") already has those rows in
 * this library as ordinary ingredient rows. One in the middle of the list
 * converts harmlessly into a real heading; one at the end — or immediately
 * followed by another such row — has no rows to attach to, and treating it as
 * a header would delete it on the next save with no error and no trace. This
 * function requires a lookahead of exactly one line to tell the two cases
 * apart.
 */
export function parseSectionedLines(raw: string | null | undefined): SectionedLine[] {
  const out: SectionedLine[] = []
  const lines = parseLines(raw)
  let section: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const label = headerLabel(line)
    // A header only counts as a header if a next line exists and is not
    // itself a header — i.e. at least one row will land beneath it.
    if (label !== null && i + 1 < lines.length && headerLabel(lines[i + 1]) === null) {
      section = label
      continue
    }
    out.push({ section, text: line })
  }

  return out
}

/**
 * Stored rows back into textarea text, emitting a header wherever the section
 * changes and a blank line before each one for readability (blank lines are
 * dropped on the way back in, so they cost nothing).
 *
 * Lossy in one direction, on purpose: a row with no section that follows a
 * sectioned row cannot be expressed — this format has no closing marker — so
 * it is absorbed into the section above. Extraction produces
 * unsectioned-then-sectioned, never the reverse.
 */
export function renderSectionedLines(rows: readonly SectionedLine[]): string {
  const out: string[] = []
  let section: string | null = null

  for (const row of rows) {
    if (row.section !== null && row.section !== section) {
      if (out.length > 0) out.push('')
      out.push(`${row.section}:`)
      section = row.section
    }
    out.push(row.text)
  }

  return out.join('\n')
}
