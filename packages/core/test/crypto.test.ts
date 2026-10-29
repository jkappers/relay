import { describe, expect, it } from 'vitest'
import { coreEnvSchema, createCipher, DecryptError, loadConfig } from '../src'

describe('crypto', () => {
  it('round-trips', async () => {
    const cipher = await createCipher(new Uint8Array(32).fill(1))
    const ct = cipher.encrypt('xoxp-secret-token')
    expect(ct).not.toContain('xoxp')
    expect(cipher.decrypt(ct)).toBe('xoxp-secret-token')
  })

  it('uses a fresh nonce each time', async () => {
    const cipher = await createCipher(new Uint8Array(32).fill(1))
    expect(cipher.encrypt('a')).not.toBe(cipher.encrypt('a'))
  })

  it('fails with the wrong key', async () => {
    const a = await createCipher(new Uint8Array(32).fill(1))
    const b = await createCipher(new Uint8Array(32).fill(2))
    expect(() => b.decrypt(a.encrypt('hello'))).toThrow(DecryptError)
  })

  it('fails on tampered ciphertext', async () => {
    const cipher = await createCipher(new Uint8Array(32).fill(1))
    const ct = cipher.encrypt('hello')
    const flipped = ct.slice(0, -2) + (ct.at(-2) === 'A' ? 'B' : 'A') + ct.at(-1)
    expect(() => cipher.decrypt(flipped)).toThrow(DecryptError)
  })

  it('rejects keys of the wrong length', async () => {
    await expect(createCipher(new Uint8Array(16))).rejects.toThrow()
  })
})

describe('config master key', () => {
  const base = { DATABASE_URL: 'postgres://x' }

  it('accepts 32 bytes of base64', () => {
    const key = Buffer.alloc(32, 9).toString('base64')
    expect(loadConfig(coreEnvSchema, { ...base, RELAY_MASTER_KEY: key }).RELAY_MASTER_KEY).toHaveLength(32)
  })

  it.each([
    ['missing', undefined],
    ['too short', Buffer.alloc(16).toString('base64')],
    ['not base64', '!!!not-base64!!!'],
  ])('fails fast when %s', (_, value) => {
    expect(() => loadConfig(coreEnvSchema, { ...base, RELAY_MASTER_KEY: value })).toThrow(/RELAY_MASTER_KEY/)
  })
})
