import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { schema, type Db } from '@relay/core'

export const SESSION_COOKIE = 'relay_console'
export const SESSION_TTL_SECONDS = 12 * 60 * 60
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/
const TOUCH_AFTER_MS = 60_000

const { sessions } = schema

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export interface SessionStore {
  create(userId: string): Promise<string>
  lookup(token: string | undefined): Promise<{ userId: string } | null>
  revoke(token: string | undefined): Promise<void>
}

export function createSessionStore(db: Db, nowSeconds: () => number): SessionStore {
  const now = () => new Date(nowSeconds() * 1000)
  return {
    async create(userId) {
      const token = randomBytes(32).toString('base64url')
      await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now())))
      await db.insert(sessions).values({
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date((nowSeconds() + SESSION_TTL_SECONDS) * 1000),
        createdAt: now(),
        lastSeenAt: now(),
      })
      return token
    },

    async lookup(token) {
      if (!token || !TOKEN_FORMAT.test(token)) return null
      const at = now()
      const [row] = await db
        .select({ id: sessions.id, userId: sessions.userId, lastSeenAt: sessions.lastSeenAt })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, at)))
      if (!row) return null
      if (at.getTime() - row.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
        await db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, row.id))
      }
      return { userId: row.userId }
    },

    async revoke(token) {
      if (!token || !TOKEN_FORMAT.test(token)) return
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
    },
  }
}

export const LOGIN_WINDOW_SECONDS = 15 * 60
export const IP_MAX_FAILURES = 5
export const EMAIL_MAX_FAILURES = 10

export interface LoginLimiter {
  blocked(key: string, nowSeconds: number): boolean
  fail(key: string, nowSeconds: number): void
  clear(key: string): void
}

export function createLoginLimiter(maxFailures: number): LoginLimiter {
  const failures = new Map<string, number[]>()
  const recent = (key: string, nowSeconds: number) => {
    const list = (failures.get(key) ?? []).filter((t) => t > nowSeconds - LOGIN_WINDOW_SECONDS)
    if (list.length === 0) failures.delete(key)
    else failures.set(key, list)
    return list
  }
  return {
    blocked: (key, now) => recent(key, now).length >= maxFailures,
    fail(key, now) {
      if (failures.size > 10_000) for (const k of failures.keys()) recent(k, now)
      failures.set(key, [...recent(key, now), now])
    },
    clear: (key) => void failures.delete(key),
  }
}
