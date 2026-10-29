import { SignatureError } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { computeSlackSignature, verifySlackSignature } from '../src'

const secret = 'test-signing-secret'
const body = '{"type":"event_callback","event_id":"Ev1"}'
const now = 1_700_000_000
const ts = String(now)

const verify = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({
    signingSecrets: [secret],
    timestamp: ts,
    signature: computeSlackSignature(secret, ts, body),
    rawBody: body,
    nowSeconds: now,
    ...overrides,
  })

describe('slack signature', () => {
  it('accepts a valid signature', () => {
    expect(() => verify()).not.toThrow()
  })

  it('rejects a tampered body', () => {
    expect(() => verify({ rawBody: body.replace('Ev1', 'Ev2') })).toThrow(SignatureError)
  })

  it('rejects the wrong secret', () => {
    expect(() => verify({ signature: computeSlackSignature('other-secret', ts, body) })).toThrow(SignatureError)
  })

  it('rejects a stale timestamp', () => {
    const old = String(now - 301)
    expect(() => verify({ timestamp: old, signature: computeSlackSignature(secret, old, body) })).toThrow(/window/)
  })

  it('rejects a future timestamp beyond the window', () => {
    const future = String(now + 301)
    expect(() => verify({ timestamp: future, signature: computeSlackSignature(secret, future, body) })).toThrow(/window/)
  })

  it('accepts the edge of the window', () => {
    const edge = String(now - 300)
    expect(() => verify({ timestamp: edge, signature: computeSlackSignature(secret, edge, body) })).not.toThrow()
  })

  it('returns which secret signed the request', () => {
    expect(verify({ signingSecrets: [secret, 'old-secret'] })).toBe(0)
    expect(verify({ signingSecrets: ['new-secret', secret] })).toBe(1)
    expect(() => verify({ signingSecrets: ['new-secret', 'old-secret'] })).toThrow(SignatureError)
    expect(() => verify({ signingSecrets: [] })).toThrow(SignatureError)
  })

  it('checks the window before any secret', () => {
    const old = String(now - 301)
    expect(() => verify({ signingSecrets: ['x', secret], timestamp: old, signature: computeSlackSignature(secret, old, body) })).toThrow(/window/)
  })

  it('rejects missing headers', () => {
    expect(() => verify({ signature: null })).toThrow(SignatureError)
    expect(() => verify({ timestamp: null })).toThrow(SignatureError)
  })

  // Slack's documented example: https://docs.slack.dev/authentication/verifying-requests-from-slack
  it('matches the known-good vector from Slack docs', () => {
    const docBody =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'
    const expected = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503'
    expect(computeSlackSignature('8f742231b10e8888abcd99yyyzzz85a5', '1531420618', docBody)).toBe(expected)
    expect(() =>
      verifySlackSignature({
        signingSecrets: ['8f742231b10e8888abcd99yyyzzz85a5'],
        timestamp: '1531420618',
        signature: expected,
        rawBody: docBody,
        nowSeconds: 1531420618,
      }),
    ).not.toThrow()
  })
})
