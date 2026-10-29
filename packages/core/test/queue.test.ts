import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, PgBossQueue, type Db } from '../src'
import { resetDb, TEST_DATABASE_URL } from '../src/testing'

const QUEUE = 'queue-test'
let db: Db
let close: () => Promise<void>
let queue: PgBossQueue

const jobCount = async () =>
  (await db.execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = ${QUEUE}`))[0]?.n ?? 0

beforeAll(async () => {
  ;({ db, close } = createDb(TEST_DATABASE_URL, { max: 2 }))
  queue = new PgBossQueue(TEST_DATABASE_URL)
  await queue.start()
  await queue.ensureQueue(QUEUE)
})

beforeEach(() => resetDb(db))

afterAll(async () => {
  await queue.stop()
  await close()
})

describe('PgBossQueue', () => {
  it('commits a job sent inside a transaction', async () => {
    await db.transaction(async (tx) => {
      await queue.send(QUEUE, { n: 1 }, { tx })
    })
    expect(await jobCount()).toBe(1)
  })

  it('discards a job when the transaction rolls back', async () => {
    await expect(
      db.transaction(async (tx) => {
        await queue.send(QUEUE, { n: 1 }, { tx })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await jobCount()).toBe(0)
  })

  it('delivers jobs to a worker', async () => {
    const seen = new Promise<unknown>((resolve) => {
      void queue.work<{ n: number }>(QUEUE, async ([job]) => resolve(job?.data))
    })
    await queue.send(QUEUE, { n: 42 })
    await expect(seen).resolves.toEqual({ n: 42 })
  })
})
