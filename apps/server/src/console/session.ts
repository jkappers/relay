import { createHmac, timingSafeEqual } from 'node:crypto'
import { safeEqual } from '@relay/core'

export const SESSION_COOKIE = 'relay_console'
export const SESSION_TTL_SECONDS = 12 * 60 * 60
export const LOGIN_MAX_FAILURES = 5
export const LOGIN_WINDOW_SECONDS = 15 * 60

export function deriveSessionKey(masterKey: Uint8Array): Buffer {
  return createHmac('sha256', masterKey).update('relay/console-session/v1').digest()
}

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url')

export function createSessionToken(key: Buffer, nowSeconds: number): string {
  const payload = `v1.${nowSeconds + SESSION_TTL_SECONDS}`
  return `${payload}.${mac(key, payload)}`
}

export function checkSessionToken(key: Buffer, token: string | undefined, nowSeconds: number): boolean {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [version, expires, signature] = parts as [string, string, string]
  if (version !== 'v1' || !/^\d{1,12}$/.test(expires)) return false
  if (!safeEqual(mac(key, `${version}.${expires}`), signature)) return false
  return Number(expires) > nowSeconds
}

export function passwordMatches(key: Buffer, expected: string, given: string): boolean {
  const a = createHmac('sha256', key).update(expected).digest()
  const b = createHmac('sha256', key).update(given).digest()
  return timingSafeEqual(a, b)
}

export interface LoginLimiter {
  blocked(ip: string, nowSeconds: number): boolean
  fail(ip: string, nowSeconds: number): void
  clear(ip: string): void
}

export function createLoginLimiter(): LoginLimiter {
  const failures = new Map<string, number[]>()
  const recent = (ip: string, nowSeconds: number) => {
    const list = (failures.get(ip) ?? []).filter((t) => t > nowSeconds - LOGIN_WINDOW_SECONDS)
    if (list.length === 0) failures.delete(ip)
    else failures.set(ip, list)
    return list
  }
  return {
    blocked: (ip, now) => recent(ip, now).length >= LOGIN_MAX_FAILURES,
    fail(ip, now) {
      if (failures.size > 10_000) for (const key of failures.keys()) recent(key, now)
      failures.set(ip, [...recent(ip, now), now])
    },
    clear: (ip) => void failures.delete(ip),
  }
}
