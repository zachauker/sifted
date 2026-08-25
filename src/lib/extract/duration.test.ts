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
    expect(parseIsoDurationMinutes('')).toBeNull()
    expect(parseIsoDurationMinutes(undefined)).toBeNull()
  })

  it('returns null above the reasonable ceiling', () => {
    expect(parseIsoDurationMinutes('PT99999H')).toBeNull()
  })

  it('accepts exactly 30 days at the boundary', () => {
    expect(parseIsoDurationMinutes('PT720H')).toBe(43200)
  })

  it('returns null just past the 30 day boundary', () => {
    expect(parseIsoDurationMinutes('PT721H')).toBeNull()
  })

  it('accepts a real 18-hour overnight recipe (no-knead focaccia)', () => {
    expect(parseIsoDurationMinutes('PT18H')).toBe(1080)
  })
})

describe('parseIsoDurationMinutes — freeform fallback (Bon Appétit and friends)', () => {
  it('parses the motivating Bon Appétit case: plain hours', () => {
    expect(parseIsoDurationMinutes('3 hours')).toBe(180)
  })

  it('parses singular hour', () => {
    expect(parseIsoDurationMinutes('1 hour')).toBe(60)
  })

  it('parses plain minutes', () => {
    expect(parseIsoDurationMinutes('45 minutes')).toBe(45)
  })

  it('parses abbreviated "mins"', () => {
    expect(parseIsoDurationMinutes('20 mins')).toBe(20)
  })

  it('parses abbreviated "min"', () => {
    expect(parseIsoDurationMinutes('10 min')).toBe(10)
  })

  it('parses "hr min" combined form', () => {
    expect(parseIsoDurationMinutes('1 hr 30 min')).toBe(90)
  })

  it('parses "hour minutes" combined form', () => {
    expect(parseIsoDurationMinutes('1 hour 30 minutes')).toBe(90)
  })

  it('parses single-letter "h m" combined form', () => {
    expect(parseIsoDurationMinutes('2 h 15 m')).toBe(135)
  })

  it('parses decimal hours', () => {
    expect(parseIsoDurationMinutes('1.5 hours')).toBe(90)
  })

  it('parses mixed-number hours', () => {
    expect(parseIsoDurationMinutes('1 1/2 hours')).toBe(90)
  })

  it('treats a bare number with no unit as minutes', () => {
    expect(parseIsoDurationMinutes('45')).toBe(45)
  })

  it('is case-insensitive and tolerant of extra whitespace', () => {
    expect(parseIsoDurationMinutes('  1   HOUR   30   MIN  ')).toBe(90)
  })

  it('returns null when no number is recoverable', () => {
    expect(parseIsoDurationMinutes('overnight')).toBeNull()
    expect(parseIsoDurationMinutes('varies')).toBeNull()
    expect(parseIsoDurationMinutes('')).toBeNull()
    expect(parseIsoDurationMinutes('about an hour')).toBeNull()
  })

  it('returns null for a freeform zero duration', () => {
    expect(parseIsoDurationMinutes('0 minutes')).toBeNull()
  })

  it('returns null for a freeform value above the 30-day ceiling', () => {
    expect(parseIsoDurationMinutes('800 hours')).toBeNull()
  })

  it('accepts a freeform value exactly at the 30-day ceiling', () => {
    expect(parseIsoDurationMinutes('720 hours')).toBe(43_200)
  })

  it('trap: "1 hour 30" is ambiguous (no unit on the trailing number) and returns null', () => {
    // Could plausibly mean 90 minutes, but it could just as easily be a typo or
    // truncated feed. Per "a wrong time is worse than no time," this is treated
    // as unresolvable rather than guessed at.
    expect(parseIsoDurationMinutes('1 hour 30')).toBeNull()
  })

  it('trap: a sentence with an unrelated number does not latch onto the wrong value', () => {
    // "4" (serves count) has no duration unit and sits outside any matched
    // token, so the string never fully resolves to duration content and the
    // whole thing is rejected rather than risk pulling the wrong number.
    expect(parseIsoDurationMinutes('Serves 4, ready in 30 minutes')).toBeNull()
  })

  it('returns null for a number attached to a non-duration concept', () => {
    expect(parseIsoDurationMinutes('Serves 4')).toBeNull()
    expect(parseIsoDurationMinutes('350 degrees')).toBeNull()
  })

  it('still tries the ISO path first and unchanged', () => {
    expect(parseIsoDurationMinutes('PT1H30M')).toBe(90)
  })
})
