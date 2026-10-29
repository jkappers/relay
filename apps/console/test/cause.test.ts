import { describe, expect, it } from 'vitest'
import { condenseCause } from '../src/cause'

describe('condenseCause', () => {
  it.each([
    ['fetch failed: connect ECONNREFUSED 127.0.0.1:4555', 'ECONNREFUSED :4555'],
    ['fetch failed: getaddrinfo ENOTFOUND hooks.example.test', 'ENOTFOUND hooks.example.test'],
    ['fetch failed: read ECONNRESET', 'ECONNRESET'],
    ['HTTP 422', 'HTTP 422'],
    ['HTTP 503', 'HTTP 503'],
    ['Request failed with status code 404', 'HTTP 404'],
    ['500 Internal Server Error', 'HTTP 500'],
    ['timeout after 10000ms', 'timeout 10s'],
    ['timeout after 2500ms', 'timeout 2.5s'],
    ['The operation timed out', 'timeout'],
    ['destination disabled', 'destination disabled'],
    ['not_retried_after_mutation', 'not retried after mutation'],
    ['a very long error message that keeps going past the limit', 'a very long error message t…'],
    ['first line\nsecond line', 'first line'],
  ])('%s', (input, expected) => {
    expect(condenseCause(input)).toBe(expected)
  })

  it('falls back to "failed" without text', () => {
    expect(condenseCause(null)).toBe('failed')
    expect(condenseCause(undefined)).toBe('failed')
    expect(condenseCause('   ')).toBe('failed')
  })

  it('stays short', () => {
    for (const s of ['x'.repeat(500), 'connect EHOSTUNREACH some host with spaces', 'E'.repeat(3)]) expect(condenseCause(s).length).toBeLessThanOrEqual(28)
  })
})
