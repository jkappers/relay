import { createCipher, createConnectionStore, createDb, type ConnectionStore, type Db } from '@relay/core'
import { resetDb, TEST_DATABASE_URL, TEST_MASTER_KEY } from '@relay/core/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDiscordAdapter } from '../src'
import { BOT_ID, fixture, GUILD_ID, INSTALLER_ID } from './fixtures'

let db: Db
let close: () => Promise<void>
let store: ConnectionStore
let botId: string | null

const adapter = () => createDiscordAdapter({ connections: store, botUserId: () => botId })
const install = (teamId = GUILD_ID, userId = INSTALLER_ID) =>
  store.upsertInstall({ provider: 'discord', identity: 'team', teamId, userId, name: `Discord ${teamId}`, ownerUserId: null })

beforeAll(async () => {
  const h = createDb(TEST_DATABASE_URL, { max: 2 })
  db = h.db
  close = h.close
  store = createConnectionStore(db, await createCipher(TEST_MASTER_KEY))
})
beforeEach(async () => {
  await resetDb(db)
  botId = BOT_ID
})
afterAll(() => close())

describe('discord resolveConnections', () => {
  it('routes a mention to the connection for its server', async () => {
    const conn = await install()
    await install('999', INSTALLER_ID)
    const r = await adapter().resolveConnections(fixture('message_create_mention'))
    expect(r).toEqual({ kind: 'ingest', connections: [expect.objectContaining({ id: conn.id })] })
  })

  it('reports a mention in a server with no connection', async () => {
    expect(await adapter().resolveConnections(fixture('message_create_mention'))).toEqual({ kind: 'ingest', connections: [], reason: 'unknown_connection' })
  })

  it('routes a DM to every active install by that installer', async () => {
    const a = await install('111')
    const b = await install('222')
    await install('333', '42')
    const revoked = await install('444')
    await store.revoke('discord', '444')
    const r = await adapter().resolveConnections(fixture('message_create_dm'))
    expect(r.kind).toBe('ingest')
    const ids = r.kind === 'ingest' ? r.connections.map((c) => c.id).sort() : []
    expect(ids).toEqual([a.id, b.id].sort())
    expect(ids).not.toContain(revoked.id)
  })

  it('reports a DM from someone who installed nothing as unrouted', async () => {
    await install(GUILD_ID, '42')
    expect(await adapter().resolveConnections(fixture('message_create_dm'))).toEqual({ kind: 'ingest', connections: [], reason: 'dm_unrouted' })
  })

  it('ignores non-message dispatches, bot authors, and messages before READY', async () => {
    await install()
    expect(await adapter().resolveConnections(fixture('ready'))).toEqual({ kind: 'ignore', reason: 'not_message' })
    expect(await adapter().resolveConnections(fixture('message_create_bot_author'))).toEqual({ kind: 'ignore', reason: 'bot_author' })
    expect(await adapter().resolveConnections({ t: 'MESSAGE_CREATE', d: { nope: 1 } })).toEqual({ kind: 'ignore', reason: 'invalid_payload' })
    botId = null
    expect(await adapter().resolveConnections(fixture('message_create_mention'))).toEqual({ kind: 'ignore', reason: 'no_bot_user' })
  })

  it('keys dedup by connection and message id', async () => {
    const conn = await install()
    expect(adapter().dedupKey(fixture('message_create_mention'), conn)).toBe(`${conn.id}:334385199974967042`)
  })
})

describe('discord lifecycle', () => {
  it('revokes the connection when the bot is removed from the server', async () => {
    const conn = await install()
    expect(await adapter().lifecycle!(fixture('guild_delete_removed'))).toEqual({ kind: 'revoked', count: 1 })
    expect((await store.findById(conn.id))?.status).toBe('revoked')
  })

  it('does not revoke on an outage or on other dispatches', async () => {
    const conn = await install()
    expect(await adapter().lifecycle!(fixture('guild_delete_unavailable'))).toBeNull()
    expect(await adapter().lifecycle!(fixture('message_create_mention'))).toBeNull()
    expect((await store.findById(conn.id))?.status).toBe('active')
  })
})
