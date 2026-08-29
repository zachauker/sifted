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
 * Lines with the section each one belongs to. Header lines are consumed, never
 * stored — a header is the `section` value on the rows beneath it.
 *
 * A real ingredient ending in a colon would be misread as a header. That
 * string does not occur in practice, and an escape syntax is one more thing to
 * remember for a case that never happens.
 */
export function parseSectionedLines(raw: string | null | undefined): SectionedLine[] {
  const out: SectionedLine[] = []
  let section: string | null = null

  for (const line of parseLines(raw)) {
    const label = headerLabel(line)
    if (label !== null) {
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
