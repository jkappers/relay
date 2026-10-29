import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { createCipher, createConnectionStore, createDb, PgBossQueue, QUEUES, schema, type ConnectionStore, type Db, type Envelope, type GatewayDispatch } from '@relay/core'
import { resetDb, TEST_DATABASE_URL, TEST_MASTER_KEY } from '@relay/core/testing'
import { createDiscordAdapter } from '@relay/provider-discord'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GATEWAY_INTENTS } from '../src/config'
import { createDispatchHandler } from '../src/handler'
import { createGatewayMetrics, type GatewayMetrics } from '../src/metrics'

const GUILD = '2909267986347357250'
const INSTALLER = '53908099506183680'
const BOT = '1100000000000000001'

const fixture = (name: string): GatewayDispatch =>
  JSON.parse(readFileSync(new URL(`../../../packages/providers/discord/test/fixtures/${name}.json`, import.meta.url), 'utf8'))

let db: Db
let close: () => Promise<void>
let queue: PgBossQueue
let store: ConnectionStore
let metrics: GatewayMetrics
let botUserId: string | null
let handle: ReturnType<typeof createDispatchHandler>

const install = (teamId = GUILD, userId = INSTALLER) =>
  store.upsertInstall({ provider: 'discord', identity: 'team', teamId, userId, name: `Discord ${teamId}`, ownerUserId: null })
const events = () => db.select().from(schema.events).orderBy(schema.events.receivedAt)
const routeJobs = async () =>
  (await db.execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.route}`))[0]?.n ?? 0

beforeAll(async () => {
  const h = createDb(TEST_DATABASE_URL, { max: 4 })
  db = h.db
  close = h.close
  store = createConnectionStore(db, await createCipher(TEST_MASTER_KEY))
  queue = new PgBossQueue(TEST_DATABASE_URL)
  await queue.start()
  await queue.ensureQueue(QUEUES.route)
})
beforeEach(async () => {
  await resetDb(db)
  metrics = createGatewayMetrics()
  botUserId = null
  handle = createDispatchHandler({
    db,
    queue,
    metrics,
    adapter: createDiscordAdapter({ connections: store, botUserId: () => botUserId }),
    onReady: (id) => (botUserId = id),
  })
})
afterAll(async () => {
  await queue.stop()
  await close()
})

describe('gateway dispatch handler', () => {
  it('requests only the non-privileged intents', () => {
    expect(GATEWAY_INTENTS).toBe(1 | 512 | 4096)
    expect(GATEWAY_INTENTS & (1 << 15)).toBe(0)
  })

  it('learns the bot user from READY and drops messages before it', async () => {
    await install()
    await handle(fixture('message_create_mention'))
    expect(await events()).toHaveLength(0)
    expect(metrics.messages.get({ outcome: 'no_bot_user' })).toBe(1)
    await handle(fixture('ready'))
    expect(botUserId).toBe(BOT)
  })

  it('stores and enqueues a mention once, even when Discord sends it again', async () => {
    const conn = await install()
    await handle(fixture('ready'))
    await handle(fixture('message_create_mention'))
    await handle(fixture('message_create_mention'))
    const rows = await events()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'discord', connectionId: conn.id, dedupKey: `${conn.id}:334385199974967042` })
    expect((rows[0]!.envelope as Envelope).type).toBe('discord.message.mention')
    expect((rows[0]!.envelope as Envelope).text).toBe('Supa Hot')
    expect(await routeJobs()).toBe(1)
    expect(metrics.messages.get({ outcome: 'accepted' })).toBe(1)
    expect(metrics.messages.get({ outcome: 'duplicate' })).toBe(1)
    expect(metrics.dispatches.get({ type: 'MESSAGE_CREATE' })).toBe(2)
  })

  it('fans a DM out to each install by the author, and counts a DM nobody routes', async () => {
    const a = await install('111')
    const b = await install('222')
    await handle(fixture('ready'))
    await handle(fixture('message_create_dm'))
    expect((await events()).map((e) => e.connectionId).sort()).toEqual([a.id, b.id].sort())
    expect(metrics.messages.get({ outcome: 'accepted' })).toBe(2)

    await store.revoke('discord', '111')
    await store.revoke('discord', '222')
    const other = fixture('message_create_dm')
    ;(other.d as { id: string }).id = '334385199974967099'
    await handle(other)
    expect(await events()).toHaveLength(2)
    expect(metrics.dmUnrouted.get({})).toBe(1)
    expect(metrics.messages.get({ outcome: 'dm_unrouted' })).toBe(1)
  })

  it('drops bot authors, unmentioned messages, and servers with no connection', async () => {
    await handle(fixture('ready'))
    await handle(fixture('message_create_mention'))
    await install()
    await handle(fixture('message_create_bot_author'))
    await handle(fixture('message_create_no_mention'))
    expect(await events()).toHaveLength(0)
    expect(metrics.messages.get({ outcome: 'unknown_connection' })).toBe(1)
    expect(metrics.messages.get({ outcome: 'bot_author' })).toBe(1)
    expect(metrics.messages.get({ outcome: 'not_mentioned' })).toBe(1)
  })

  it('revokes the connection on GUILD_DELETE without unavailable, and not on an outage', async () => {
    const conn = await install()
    await handle(fixture('guild_delete_unavailable'))
    expect((await store.findById(conn.id))?.status).toBe('active')
    await handle(fixture('guild_delete_removed'))
    expect((await store.findById(conn.id))?.status).toBe('revoked')
    expect(metrics.connectionsRevoked.get({ provider: 'discord' })).toBe(1)

    await handle(fixture('ready'))
    await handle(fixture('message_create_mention'))
    expect(await events()).toHaveLength(0)
  })

  it('counts a failure instead of throwing', async () => {
    const broken = createDispatchHandler({
      db,
      queue,
      metrics,
      adapter: { ...createDiscordAdapter({ connections: store, botUserId: () => BOT }), resolveConnections: async () => Promise.reject(new Error('db down')) },
      onReady: () => {},
    })
    await expect(broken(fixture('message_create_mention'))).resolves.toBeUndefined()
    expect(metrics.messages.get({ outcome: 'error' })).toBe(1)
    expect((await db.select().from(schema.connections).where(eq(schema.connections.provider, 'discord'))).length).toBe(0)
  })
})
