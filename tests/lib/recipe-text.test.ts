import { describe, it, expect } from 'vitest'
import {
  parseLines,
  parseSectionedLines,
  renderSectionedLines,
  type SectionedLine,
} from '@/lib/recipe-text'

describe('parseLines', () => {
  it('returns one trimmed entry per non-blank line', () => {
    expect(parseLines('  1 cup flour  \n2 eggs\n')).toEqual(['1 cup flour', '2 eggs'])
  })

  it('drops blank and whitespace-only lines rather than storing empty rows', () => {
    expect(parseLines('a\n\n   \nb')).toEqual(['a', 'b'])
  })

  it('splits a Windows paste on CRLF without leaving a stray carriage return', () => {
    expect(parseLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
  })

  it('treats null and undefined as no lines at all', () => {
    expect(parseLines(null)).toEqual([])
    expect(parseLines(undefined)).toEqual([])
  })
})

describe('parseSectionedLines', () => {
  it('leaves lines before any header unsectioned', () => {
    expect(parseSectionedLines('2 eggs\n1 cup flour')).toEqual([
      { section: null, text: '2 eggs' },
      { section: null, text: '1 cup flour' },
    ])
  })

  it('applies a colon-terminated header to every line beneath it', () => {
    expect(parseSectionedLines('For the sauce:\n2 Tbsp. gochujang\n1 tsp. honey')).toEqual([
      { section: 'For the sauce', text: '2 Tbsp. gochujang' },
      { section: 'For the sauce', text: '1 tsp. honey' },
    ])
  })

  it('switches sections at the next header and never stores the header itself', () => {
    const lines = parseSectionedLines('For the sauce:\ngochujang\n\nFor the chicken:\n1 chicken')
    expect(lines).toEqual([
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the chicken', text: '1 chicken' },
    ])
    expect(lines.some((line) => line.text.endsWith(':'))).toBe(false)
  })

  it('treats a bare colon as an ordinary line, not an empty section', () => {
    expect(parseSectionedLines(':')).toEqual([{ section: null, text: ':' }])
  })
})

describe('renderSectionedLines', () => {
  it('emits a header wherever the section changes, blank-line separated', () => {
    const rows: SectionedLine[] = [
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the chicken', text: '1 chicken' },
    ]
    expect(renderSectionedLines(rows)).toBe('For the sauce:\ngochujang\n\nFor the chicken:\n1 chicken')
  })

  it('emits no header at all for wholly unsectioned rows', () => {
    expect(
      renderSectionedLines([
        { section: null, text: '2 eggs' },
        { section: null, text: '1 cup flour' },
      ]),
    ).toBe('2 eggs\n1 cup flour')
  })

  it('round-trips: parse(render(rows)) returns the rows unchanged', () => {
    const rows: SectionedLine[] = [
      { section: null, text: 'flaky salt' },
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the sauce', text: 'honey' },
      { section: 'For the chicken', text: '1 chicken' },
    ]
    expect(parseSectionedLines(renderSectionedLines(rows))).toEqual(rows)
  })

  it('absorbs a trailing unsectioned row into the section above it, which is lossy on purpose', () => {
    // A return to "no section" cannot be spelled in this format — there is no
    // closing marker. Extraction produces unsectioned-then-sectioned, never the
    // reverse, so this is documented rather than defended against.
    const rows: SectionedLine[] = [
      { section: 'For the sauce', text: 'gochujang' },
      { section: null, text: 'flaky salt' },
    ]
    expect(parseSectionedLines(renderSectionedLines(rows))).toEqual([
      { section: 'For the sauce', text: 'gochujang' },
      { section: 'For the sauce', text: 'flaky salt' },
    ])
  })

  it('renders nothing for no rows', () => {
    expect(renderSectionedLines([])).toBe('')
  })
})
