import postgres from 'postgres'
import { log } from '@relay/core'

/** One gateway session per bot token. Two would double-ingest and burn the daily IDENTIFY budget. */
export const GATEWAY_LOCK_NAME = 'relay:gateway:discord'
const QUERY_TIMEOUT_MS = 10_000

export interface LeaderLock {
  /** Resolves when this process holds the lock. Polls until then. Rejects if released while waiting. */
  acquired: Promise<void>
  /** Resolves if the lock is lost after it was acquired (its connection died or was replaced). */
  lost: Promise<void>
  release(): Promise<void>
}

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lock query timed out')), QUERY_TIMEOUT_MS).unref())])

/**
 * A session-level Postgres advisory lock held on a dedicated one-connection client. A second copy waits.
 * The client never recycles its connection (no lifetime limit; idle timeout is off by default), because Postgres frees the lock with it.
 * If the connection dies anyway, the next check runs on a new backend pid, and `lost` resolves.
 */
export function acquireLeaderLock(url: string, opts: { pollMs: number; onWaiting?: () => void }): LeaderLock {
  const sql = postgres(url, { max: 1, max_lifetime: null, onnotice: () => {} })
  let stopped = false
  let heldPid: number | null = null
  let timer: NodeJS.Timeout | undefined
  let markLost: () => void = () => {}
  const lost = new Promise<void>((r) => (markLost = r))

  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      timer = setTimeout(r, ms)
    })

  const check = async () => {
    const [row] = await withTimeout(sql<{ pid: number; held: boolean }[]>`
      select pg_backend_pid() as pid, exists (
        select 1 from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()
          and objid = (hashtext(${GATEWAY_LOCK_NAME}) & x'ffffffff'::bigint)::oid
      ) as held`)
    return row
  }

  const acquired = (async () => {
    while (!stopped) {
      try {
        const [row] = await withTimeout(
          sql<{ ok: boolean; pid: number }[]>`select pg_try_advisory_lock(hashtext(${GATEWAY_LOCK_NAME})) as ok, pg_backend_pid() as pid`,
        )
        if (row?.ok) {
          heldPid = row.pid
          break
        }
        opts.onWaiting?.()
      } catch (err) {
        log.warn('gateway lock: could not try the lock', { err: err instanceof Error ? err.message : String(err) })
      }
      await sleep(opts.pollMs)
    }
    if (stopped || heldPid === null) throw new Error('lock wait stopped')
    void (async () => {
      while (!stopped) {
        await sleep(opts.pollMs)
        if (stopped) return
        try {
          const row = await check()
          if (row?.pid === heldPid && row.held) continue
        } catch {
          // the connection is gone or stuck
        }
        if (!stopped) {
          log.error('gateway lock: lost the leader lock')
          markLost()
        }
        return
      }
    })()
  })()

  return {
    acquired,
    lost,
    async release() {
      stopped = true
      if (timer) clearTimeout(timer)
      if (heldPid !== null) {
        try {
          await withTimeout(sql`select pg_advisory_unlock(hashtext(${GATEWAY_LOCK_NAME}))`)
        } catch {
          // the lock goes with the connection anyway
        }
      }
      await sql.end({ timeout: 5 })
    },
  }
}
