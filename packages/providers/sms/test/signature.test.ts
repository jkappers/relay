import { describe, expect, it } from 'vitest'
import { computeTwilioSignature, paramsFromForm, verifyTwilioSignature } from '../src'

// Vector computed independently with `openssl dgst -sha1 -hmac 12345 -binary | base64` over
// URL + sorted name+value pairs, following twilio-node's getExpectedTwilioSignature.
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2'
const PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675309',
  Digits: '1234',
  From: '+14158675309',
  To: '+18005551212',
}
const EXPECTED = 'RSOYDt4T1cUTdK1PDd93/VVr8B8='

describe('twilio signature', () => {
  it('matches the independently computed vector', () => {
    expect(computeTwilioSignature('12345', URL_, PARAMS)).toBe(EXPECTED)
  })

  it('does not depend on param order', () => {
    const shuffled = { To: PARAMS.To, Digits: PARAMS.Digits, CallSid: PARAMS.CallSid, From: PARAMS.From, Caller: PARAMS.Caller }
    expect(verifyTwilioSignature('12345', URL_, shuffled, EXPECTED)).toBe(true)
  })

  it('accepts the url with or without the default port', () => {
    const sig = computeTwilioSignature('12345', 'https://mycompany.com:443/myapp.php?foo=1&bar=2', PARAMS)
    expect(verifyTwilioSignature('12345', URL_, PARAMS, sig)).toBe(true)
    expect(verifyTwilioSignature('12345', 'https://mycompany.com:443/myapp.php?foo=1&bar=2', PARAMS, EXPECTED)).toBe(true)
  })

  it('dedupes and sorts repeated keys', () => {
    const sig = computeTwilioSignature('12345', URL_, { A: ['2', '1', '2'] })
    expect(sig).toBe(computeTwilioSignature('12345', URL_, { A: ['1', '2'] }))
    expect(paramsFromForm('A=2&A=1&A=2')).toEqual({ A: ['2', '1', '2'] })
  })

  it('rejects a tampered param, wrong url, wrong token, and a bad header', () => {
    expect(verifyTwilioSignature('12345', URL_, { ...PARAMS, Digits: '9999' }, EXPECTED)).toBe(false)
    expect(verifyTwilioSignature('12345', 'https://mycompany.com/other', PARAMS, EXPECTED)).toBe(false)
    expect(verifyTwilioSignature('54321', URL_, PARAMS, EXPECTED)).toBe(false)
    expect(verifyTwilioSignature('12345', URL_, PARAMS, 'nope')).toBe(false)
  })
})
