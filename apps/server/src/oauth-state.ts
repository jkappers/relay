import { createHmac, randomBytes } from 'node:crypto'
import { safeEqual } from '@relay/core'

export const STATE_TTL_SECONDS = 600

export function deriveStateKey(masterKey: Uint8Array): Buffer {
  return createHmac('sha256', masterKey).update('relay/oauth-state/v1').digest()
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

export function createState(key: Buffer, nowSeconds: number): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url')
  const payload = `${nonce}.${nowSeconds + STATE_TTL_SECONDS}`
  return { state: `${payload}.${sign(key, payload)}`, nonce }
}

export function checkState(key: Buffer, state: string, cookieNonce: string | undefined, nowSeconds: number): boolean {
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [nonce, expires, mac] = parts as [string, string, string]
  if (!safeEqual(sign(key, `${nonce}.${expires}`), mac)) return false
  if (!/^\d+$/.test(expires) || Number(expires) < nowSeconds) return false
  return cookieNonce !== undefined && safeEqual(nonce, cookieNonce)
}
