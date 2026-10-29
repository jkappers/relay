import { createHmac, randomBytes } from 'node:crypto'
import { safeEqual } from '@relay/core'

export const STATE_TTL_SECONDS = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function deriveStateKey(masterKey: Uint8Array): Buffer {
  return createHmac('sha256', masterKey).update('relay/oauth-state/v2').digest()
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

/** The state binds the Relay user who started OAuth. The browser nonce cookie binds it to that browser. */
export function createState(key: Buffer, userId: string, nowSeconds: number): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url')
  const payload = `${nonce}.${userId}.${nowSeconds + STATE_TTL_SECONDS}`
  return { state: `${payload}.${sign(key, payload)}`, nonce }
}

/** Returns the Relay user id from a valid state, else null. */
export function checkState(key: Buffer, state: string, cookieNonce: string | undefined, nowSeconds: number): string | null {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [nonce, userId, expires, mac] = parts as [string, string, string, string]
  if (!safeEqual(sign(key, `${nonce}.${userId}.${expires}`), mac)) return null
  if (!UUID.test(userId) || !/^\d+$/.test(expires) || Number(expires) < nowSeconds) return null
  if (cookieNonce === undefined || !safeEqual(nonce, cookieNonce)) return null
  return userId
}
