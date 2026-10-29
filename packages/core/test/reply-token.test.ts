import { describe, expect, it } from 'vitest'
import { deriveReplyTokenKey, mintReplyToken, verifyTokenSignature } from '../src/reply-token'

const key = deriveReplyTokenKey(new Uint8Array(32).fill(7))
const did = '3f2b1a40-0000-4000-8000-000000000001'
const mint = (over: Partial<Parameters<typeof mintReplyToken>[1]> = {}) =>
  mintReplyToken(key, { deliveryId: did, allowed: ['reply'], ttlSeconds: 60, nowSeconds: 1000, ...over })

describe('reply token', () => {
  it('round trips', () => {
    const t = mint()
    const r = verifyTokenSignature(key, t.token, 1000)
    expect(r).toEqual({ ok: true, payload: { jti: t.jti, did, exp: 1060, allowed: ['reply'] } })
  })
  it('uses a different key than the OAuth state key', () => {
    expect(verifyTokenSignature(Buffer.alloc(32, 9), mint().token, 1000)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects tampering', () => {
    const [body, mac] = mint().token.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), allowed: ['post'] })).toString('base64url')
    expect(verifyTokenSignature(key, `${forged}.${mac}`, 1000)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyTokenSignature(key, `${body}.${mac.slice(0, -2)}AA`, 1000)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects expired tokens, but not at the boundary', () => {
    const t = mint()
    expect(verifyTokenSignature(key, t.token, 1060).ok).toBe(true)
    expect(verifyTokenSignature(key, t.token, 1061)).toEqual({ ok: false, reason: 'expired' })
  })
  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.']) expect(verifyTokenSignature(key, bad, 0).ok).toBe(false)
  })
})
