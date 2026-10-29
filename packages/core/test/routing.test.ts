import { describe, expect, it } from 'vitest'
import { computeBackoffMs, matchRoute, parseRetryAfterMs, validateRegex, type RouteMatchFields } from '../src'

const CONN = '11111111-1111-4111-8111-111111111111'
const route = (o: Partial<RouteMatchFields> = {}): RouteMatchFields => ({
  enabled: true,
  connectionId: CONN,
  eventType: 'slack.message.im',
  textContains: null,
  textRegex: null,
  includeSubtypes: false,
  ...o,
})
const env = (o: Partial<{ type: string; subtype: string | null; text: string | null; connectionId: string }> = {}) => ({
  connectionId: CONN,
  type: 'slack.message.im',
  subtype: null,
  text: 'Deploy finished',
  ...o,
})

describe('matchRoute', () => {
  it('matches an exact type only', () => {
    expect(matchRoute(route(), env())).toBe(true)
    expect(matchRoute(route(), env({ type: 'slack.message.channels' }))).toBe(false)
  })

  it('matches a trailing wildcard as a prefix', () => {
    const r = route({ eventType: 'slack.message.*' })
    expect(matchRoute(r, env({ type: 'slack.message.channels' }))).toBe(true)
    expect(matchRoute(r, env({ type: 'slack.reaction.added' }))).toBe(false)
    expect(matchRoute(route({ eventType: '*' }), env({ type: 'anything' }))).toBe(true)
  })

  it('matches contains case-insensitively', () => {
    expect(matchRoute(route({ textContains: 'DEPLOY' }), env())).toBe(true)
    expect(matchRoute(route({ textContains: 'rollback' }), env())).toBe(false)
    expect(matchRoute(route({ textContains: 'x' }), env({ text: null }))).toBe(false)
  })

  it('matches a regex', () => {
    expect(matchRoute(route({ textRegex: '^Deploy\\s+\\w+$' }), env())).toBe(true)
    expect(matchRoute(route({ textRegex: '^deploy' }), env())).toBe(false)
    expect(matchRoute(route({ textRegex: 'x' }), env({ text: null }))).toBe(false)
  })

  it('requires both contains and regex when both are set', () => {
    expect(matchRoute(route({ textContains: 'deploy', textRegex: 'finished$' }), env())).toBe(true)
    expect(matchRoute(route({ textContains: 'nope', textRegex: 'finished$' }), env())).toBe(false)
  })

  it('excludes subtypes by default and includes them on request', () => {
    expect(matchRoute(route(), env({ subtype: 'message_changed' }))).toBe(false)
    expect(matchRoute(route({ includeSubtypes: true }), env({ subtype: 'message_changed' }))).toBe(true)
    expect(matchRoute(route({ includeSubtypes: true }), env())).toBe(true)
  })

  it('never matches a disabled route', () => {
    expect(matchRoute(route({ enabled: false }), env())).toBe(false)
  })

  it('filters by connection', () => {
    expect(matchRoute(route({ connectionId: CONN }), env())).toBe(true)
    expect(matchRoute(route({ connectionId: '22222222-2222-4222-8222-222222222222' }), env())).toBe(false)
  })

  it('does not match when the stored regex is invalid', () => {
    expect(matchRoute(route({ textRegex: '(' }), env())).toBe(false)
  })
})

describe('validateRegex', () => {
  it('accepts valid and rejects invalid or long patterns', () => {
    expect(validateRegex('^a+$')).toBeNull()
    expect(validateRegex('(')).toMatch(/does not compile/)
    expect(validateRegex('a'.repeat(201))).toMatch(/at most 200/)
    expect(validateRegex('a'.repeat(200))).toBeNull()
  })
})

describe('backoff', () => {
  it('uses full jitter under an exponential ceiling', () => {
    const o = { baseMs: 5000, capMs: 900_000 }
    expect(computeBackoffMs(1, { ...o, random: () => 0.999999 })).toBeLessThan(5000)
    expect(computeBackoffMs(3, { ...o, random: () => 0.999999 })).toBeLessThan(20_000)
    expect(computeBackoffMs(3, { ...o, random: () => 0.999999 })).toBeGreaterThan(19_000)
    expect(computeBackoffMs(20, { ...o, random: () => 0.999999 })).toBeLessThan(900_000)
    expect(computeBackoffMs(5, { ...o, random: () => 0 })).toBe(0)
  })

  it('parses numeric Retry-After only', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000)
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
  })
})
