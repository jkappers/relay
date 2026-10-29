import { sql } from 'drizzle-orm'
import { createDb } from '@relay/core'
import { TEST_DATABASE_URL } from '@relay/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireLeaderLock, GATEWAY_LOCK_NAME, type LeaderLock } from '../src/lock'

const locks: LeaderLock[] = []
const lock = (onWaiting?: () => void) => {
  const l = acquireLeaderLock(TEST_DATABASE_URL, { pollMs: 50, ...(onWaiting ? { onWaiting } : {}) })
  l.acquired.catch(() => {})
  locks.push(l)
  return l
}
const settled = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))])

afterEach(async () => {
  for (const l of locks.splice(0)) await l.release()
})

describe('gateway leader lock', () => {
  it('lets one copy lead and makes a second one wait until the first lets go', async () => {
    const first = lock()
    await first.acquired
    let waits = 0
    const second = lock(() => waits++)
    expect(await settled(second.acquired, 300)).toBe(false)
    expect(waits).toBeGreaterThan(0)
    await first.release()
    expect(await settled(second.acquired, 2000)).toBe(true)
  })

  it('reports the lock lost when its connection is killed', async () => {
    const l = lock()
    await l.acquired
    const { db, close } = createDb(TEST_DATABASE_URL, { max: 1 })
    try {
      await db.execute(sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted
        and objid = (hashtext(${GATEWAY_LOCK_NAME}) & x'ffffffff'::bigint)::oid`)
    } finally {
      await close()
    }
    expect(await settled(l.lost, 2000)).toBe(true)
  })
})
