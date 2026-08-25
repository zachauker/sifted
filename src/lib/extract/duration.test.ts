import { describe, it, expect } from 'vitest'
import { parseDurationMinutes } from './duration'

describe('parseDurationMinutes', () => {
  it('parses hours and minutes', () => {
    expect(parseDurationMinutes('PT1H30M')).toBe(90)
  })

  it('parses minutes alone', () => {
    expect(parseDurationMinutes('PT45M')).toBe(45)
  })

  it('parses hours alone', () => {
    expect(parseDurationMinutes('PT2H')).toBe(120)
  })

  it('parses days', () => {
    expect(parseDurationMinutes('P1DT2H')).toBe(1560)
  })

  it('rounds seconds up to the nearest minute', () => {
    expect(parseDurationMinutes('PT90S')).toBe(2)
  })

  it('returns null for a zero duration', () => {
    expect(parseDurationMinutes('PT0M')).toBeNull()
  })

  it('returns null for malformed or missing input', () => {
    expect(parseDurationMinutes('')).toBeNull()
    expect(parseDurationMinutes(undefined)).toBeNull()
  })

  it('returns null above the reasonable ceiling', () => {
    expect(parseDurationMinutes('PT99999H')).toBeNull()
  })

  it('accepts exactly 30 days at the boundary', () => {
    expect(parseDurationMinutes('PT720H')).toBe(43200)
  })

  it('returns null just past the 30 day boundary', () => {
    expect(parseDurationMinutes('PT721H')).toBeNull()
  })

  it('accepts a real 18-hour overnight recipe (no-knead focaccia)', () => {
    expect(parseDurationMinutes('PT18H')).toBe(1080)
  })
})

describe('parseDurationMinutes — freeform fallback (Bon Appétit and friends)', () => {
  it('parses the motivating Bon Appétit case: plain hours', () => {
    expect(parseDurationMinutes('3 hours')).toBe(180)
  })

  it('parses singular hour', () => {
    expect(parseDurationMinutes('1 hour')).toBe(60)
  })

  it('parses plain minutes', () => {
    expect(parseDurationMinutes('45 minutes')).toBe(45)
  })

  it('parses abbreviated "mins"', () => {
    expect(parseDurationMinutes('20 mins')).toBe(20)
  })

  it('parses abbreviated "min"', () => {
    expect(parseDurationMinutes('10 min')).toBe(10)
  })

  it('parses "hr min" combined form', () => {
    expect(parseDurationMinutes('1 hr 30 min')).toBe(90)
  })

  it('parses "hour minutes" combined form', () => {
    expect(parseDurationMinutes('1 hour 30 minutes')).toBe(90)
  })

  it('parses single-letter "h m" combined form', () => {
    expect(parseDurationMinutes('2 h 15 m')).toBe(135)
  })

  it('parses decimal hours', () => {
    expect(parseDurationMinutes('1.5 hours')).toBe(90)
  })

  it('parses mixed-number hours', () => {
    expect(parseDurationMinutes('1 1/2 hours')).toBe(90)
  })

  it('treats a bare number with no unit as minutes', () => {
    expect(parseDurationMinutes('45')).toBe(45)
  })

  it('is case-insensitive and tolerant of extra whitespace', () => {
    expect(parseDurationMinutes('  1   HOUR   30   MIN  ')).toBe(90)
  })

  it('returns null when no number is recoverable', () => {
    expect(parseDurationMinutes('overnight')).toBeNull()
    expect(parseDurationMinutes('varies')).toBeNull()
    expect(parseDurationMinutes('')).toBeNull()
    expect(parseDurationMinutes('about an hour')).toBeNull()
  })

  it('returns null for a freeform zero duration', () => {
    expect(parseDurationMinutes('0 minutes')).toBeNull()
  })

  it('returns null for a freeform value above the 30-day ceiling', () => {
    expect(parseDurationMinutes('800 hours')).toBeNull()
  })

  it('accepts a freeform value exactly at the 30-day ceiling', () => {
    expect(parseDurationMinutes('720 hours')).toBe(43_200)
  })

  it('trap: "1 hour 30" is ambiguous (no unit on the trailing number) and returns null', () => {
    // Could plausibly mean 90 minutes, but it could just as easily be a typo or
    // truncated feed. Per "a wrong time is worse than no time," this is treated
    // as unresolvable rather than guessed at.
    expect(parseDurationMinutes('1 hour 30')).toBeNull()
  })

  it('trap: a sentence with an unrelated number does not latch onto the wrong value', () => {
    // "4" (serves count) has no duration unit and sits outside any matched
    // token, so the string never fully resolves to duration content and the
    // whole thing is rejected rather than risk pulling the wrong number.
    expect(parseDurationMinutes('Serves 4, ready in 30 minutes')).toBeNull()
  })

  it('returns null for a number attached to a non-duration concept', () => {
    expect(parseDurationMinutes('Serves 4')).toBeNull()
    expect(parseDurationMinutes('350 degrees')).toBeNull()
  })

  it('still tries the ISO path first and unchanged', () => {
    expect(parseDurationMinutes('PT1H30M')).toBe(90)
  })
})
