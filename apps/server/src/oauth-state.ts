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

/** What a state authorizes: the bot install (optionally for one server) or the identify step. */
export type StateStep = 'install' | 'identify' | `install-${string}`
const STEP = /^(install|identify|install-\d{1,20})$/

/** The state binds the Relay user and the step. The browser nonce cookie binds it to that browser. */
export function createState(key: Buffer, userId: string, nowSeconds: number, step: StateStep = 'install'): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url')
  const payload = `${nonce}.${userId}.${nowSeconds + STATE_TTL_SECONDS}.${step}`
  return { state: `${payload}.${sign(key, payload)}`, nonce }
}

/** Returns the Relay user id and step from a valid state, else null. */
export function checkState(key: Buffer, state: string, cookieNonce: string | undefined, nowSeconds: number): { userId: string; step: StateStep } | null {
  const parts = state.split('.')
  if (parts.length !== 5) return null
  const [nonce, userId, expires, step, mac] = parts as [string, string, string, string, string]
  if (!safeEqual(sign(key, `${nonce}.${userId}.${expires}.${step}`), mac)) return null
  if (!UUID.test(userId) || !STEP.test(step) || !/^\d+$/.test(expires) || Number(expires) < nowSeconds) return null
  if (cookieNonce === undefined || !safeEqual(nonce, cookieNonce)) return null
  return { userId, step: step as StateStep }
}

const GRANT_TTL_SECONDS = 900

export function deriveGrantKey(masterKey: Uint8Array): Buffer {
  return createHmac('sha256', masterKey).update('relay/discord-guild-grant/v1').digest()
}

export interface GuildGrant {
  /** The Relay user the grant was issued to. */
  userId: string
  /** The Discord user who proved they manage the servers. */
  discordUserId: string
  guilds: { id: string; name: string }[]
}

/** A signed, expiring list of servers a Discord user was shown to manage. Not stored; the signature is the proof. */
export function createGuildGrant(key: Buffer, grant: GuildGrant, nowSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ u: grant.userId, d: grant.discordUserId, g: grant.guilds.map((g) => [g.id, g.name]), e: nowSeconds + GRANT_TTL_SECONDS })).toString('base64url')
  return `${body}.${sign(key, body)}`
}

/** Returns the grant only if the signature holds, it has not expired, and it was issued to `userId`. */
export function checkGuildGrant(key: Buffer, token: string, userId: string, nowSeconds: number): GuildGrant | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, mac] = parts as [string, string]
  if (!safeEqual(sign(key, body), mac)) return null
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; d?: unknown; g?: unknown; e?: unknown }
    if (raw.u !== userId || typeof raw.d !== 'string' || typeof raw.e !== 'number' || raw.e < nowSeconds || !Array.isArray(raw.g)) return null
    const guilds = raw.g.map((x) => (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string' ? { id: x[0], name: x[1] } : null))
    if (guilds.some((g) => g === null)) return null
    return { userId: raw.u, discordUserId: raw.d, guilds: guilds as { id: string; name: string }[] }
  } catch {
    return null
  }
}
