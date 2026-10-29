import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// OWASP Password Storage Cheat Sheet, lowest-memory scrypt option: N=2^13 (8 MiB), r=8, p=10.
export const SCRYPT_PARAMS = { N: 2 ** 13, r: 8, p: 10 } as const
const KEY_BYTES = 32
const SALT_BYTES = 16
// OpenSSL needs a little over 128 * N * r bytes; 2x leaves room and still refuses anything bigger.
const MAXMEM = 2 * 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r
export const MAX_CONCURRENT_HASHES = 4
const MAX_WAITING = 64

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 1024

export class HasherBusyError extends Error {
  override name = 'HasherBusyError'
}

let active = 0
const waiting: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_HASHES) {
    if (waiting.length >= MAX_WAITING) throw new HasherBusyError('too many password checks in flight')
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    active++
  }
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return withSlot(
    () =>
      new Promise((resolve, reject) =>
        scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...params, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
      ),
  )
}

const b64 = (b: Buffer) => b.toString('base64url')

/** Format: `scrypt$N=8192,r=8,p=10$<salt>$<hash>`, base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, SCRYPT_PARAMS)
  const { N, r, p } = SCRYPT_PARAMS
  return `scrypt$N=${N},r=${r},p=${p}$${b64(salt)}$${b64(key)}`
}

const FORMAT = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const m = FORMAT.exec(stored)
  if (!m) return false
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p) return false
  const expected = Buffer.from(m[5]!, 'base64url')
  const key = await derive(password, Buffer.from(m[4]!, 'base64url'), { N, r, p })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(stored: string, password: string): Promise<boolean>
}

export const scryptHasher: PasswordHasher = { hash: hashPassword, verify: verifyPassword }
