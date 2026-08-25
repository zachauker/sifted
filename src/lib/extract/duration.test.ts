import { describe, it, expect } from 'vitest'
import { parseIsoDurationMinutes } from './duration'

describe('parseIsoDurationMinutes', () => {
  it('parses hours and minutes', () => {
    expect(parseIsoDurationMinutes('PT1H30M')).toBe(90)
  })

  it('parses minutes alone', () => {
    expect(parseIsoDurationMinutes('PT45M')).toBe(45)
  })

  it('parses hours alone', () => {
    expect(parseIsoDurationMinutes('PT2H')).toBe(120)
  })

  it('parses days', () => {
    expect(parseIsoDurationMinutes('P1DT2H')).toBe(1560)
  })

  it('rounds seconds up to the nearest minute', () => {
    expect(parseIsoDurationMinutes('PT90S')).toBe(2)
  })

  it('returns null for a zero duration', () => {
    expect(parseIsoDurationMinutes('PT0M')).toBeNull()
  })

  it('returns null for malformed or missing input', () => {
    expect(parseIsoDurationMinutes('45 minutes')).toBeNull()
    expect(parseIsoDurationMinutes('')).toBeNull()
    expect(parseIsoDurationMinutes(undefined)).toBeNull()
  })
})
