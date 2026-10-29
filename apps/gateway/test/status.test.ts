import { eq } from 'drizzle-orm'
import { createDb, schema, type Db } from '@relay/core'
import { resetDb, TEST_DATABASE_URL } from '@relay/core/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createStatusWriter } from '../src/status'

let db: Db
let close: () => Promise<void>

beforeAll(() => {
  const h = createDb(TEST_DATABASE_URL, { max: 2 })
  db = h.db
  close = h.close
})
beforeEach(() => resetDb(db))
afterAll(() => close())

const row = async () => (await db.select().from(schema.providerAppStatus).where(eq(schema.providerAppStatus.provider, 'discord')))[0]

describe('gateway status writer', () => {
  it('creates the Discord row, then updates only the fields given', async () => {
    const status = createStatusWriter(db)
    const readyAt = new Date('2026-10-01T12:00:00Z')
    await status.write({ state: 'connecting' })
    expect(await row()).toMatchObject({ state: 'connecting', lastReadyAt: null, lastCloseCode: null })
    await status.write({ state: 'ready', lastReadyAt: readyAt })
    await status.write({ state: 'auth_failed', lastCloseCode: 4004 })
    expect(await row()).toMatchObject({ state: 'auth_failed', lastReadyAt: readyAt, lastCloseCode: 4004 })
    await status.write({ state: 'reconnecting', lastCloseCode: null })
    expect(await row()).toMatchObject({ state: 'reconnecting', lastReadyAt: readyAt, lastCloseCode: null })
  })

  it('leaves the Slack row alone', async () => {
    const at = new Date('2026-10-01T12:00:00Z')
    await db.insert(schema.providerAppStatus).values({ provider: 'slack', state: 'ready', lastSignedOkAt: at })
    await createStatusWriter(db).write({ state: 'ready' })
    const [slack] = await db.select().from(schema.providerAppStatus).where(eq(schema.providerAppStatus.provider, 'slack'))
    expect(slack).toMatchObject({ state: 'ready', lastSignedOkAt: at })
  })
})
