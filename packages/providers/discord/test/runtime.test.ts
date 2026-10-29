import { ActionError, createCipher, createConnectionStore, createDb, schema, type ActionContext, type Connection, type ConnectionStore, type Db, type Envelope, type ProviderRuntime } from '@relay/core'
import { resetDb, startDiscordStub, TEST_DATABASE_URL, TEST_MASTER_KEY, DISCORD_STUB_BOT_ID, type DiscordStub } from '@relay/core/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDiscordRuntime, DISCORD_USER_AGENT } from '../src'
import { GUILD_ID, INSTALLER_ID } from './fixtures'

let db: Db
let close: () => Promise<void>
let store: ConnectionStore
let stub: DiscordStub
let runtime: ProviderRuntime
let connection: Connection

const tokenOf = (token: string | undefined) => async () => token

const envelope = (patch: Partial<Envelope['context']> = {}, actor: string | null = INSTALLER_ID): Envelope => ({
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'discord',
  connectionId: connection.id,
  type: 'discord.message.mention',
  subtype: null,
  occurredAt: new Date().toISOString(),
  actor,
  context: { channelId: '290926798999357250', threadId: null, messageId: '334385199974967042', ...patch },
  text: 'hi',
  raw: {},
})
const ctx = (env = envelope()): ActionContext => ({ envelope: env, connection, credentials: {}, fetch })
const run = (action: string, params: unknown, c = ctx()) => {
  const def = runtime.actions[action]!
  return def.run(c, def.params.parse(params))
}
const rejection = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ActionError)
  return err as ActionError
}

beforeAll(async () => {
  const h = createDb(TEST_DATABASE_URL, { max: 2 })
  db = h.db
  close = h.close
  store = createConnectionStore(db, await createCipher(TEST_MASTER_KEY))
  stub = await startDiscordStub()
})
beforeEach(async () => {
  await resetDb(db)
  stub.reset()
  runtime = createDiscordRuntime({ db, botToken: tokenOf('bot-token'), apiBase: stub.url })
  connection = await store.upsertInstall({ provider: 'discord', identity: 'team', teamId: GUILD_ID, userId: INSTALLER_ID, name: 'Discord SomeTest', ownerUserId: null })
})
afterAll(async () => {
  await stub.close()
  await close()
})

describe('discord runtime actions', () => {
  it('replies with a message reference, no mentions, the bot token, and a DiscordBot user agent', async () => {
    const out = await run('reply', { text: '@everyone hello' })
    const [req] = stub.calls('createMessage')
    expect(req!.path).toBe('/channels/290926798999357250/messages')
    expect(req!.body).toEqual({
      content: '@everyone hello',
      allowed_mentions: { parse: [] },
      message_reference: { message_id: '334385199974967042', fail_if_not_exists: false },
    })
    expect(req!.headers.authorization).toBe('Bot bot-token')
    expect(req!.headers['user-agent']).toBe(DISCORD_USER_AGENT)
    expect(out.sentMessage).toEqual({ channel: '290926798999357250', ts: (out.result as { messageId: string }).messageId })
  })

  it('posts without a reference and still blocks mentions', async () => {
    await run('post', { text: 'hello' })
    expect(stub.calls('createMessage')[0]!.body).toEqual({ content: 'hello', allowed_mentions: { parse: [] } })
  })

  it('reacts with a URL-encoded emoji', async () => {
    await run('react', { emoji: '👍' })
    await run('react', { emoji: 'party_blob:123456789012345678' })
    const paths = stub.calls('createReaction').map((r) => r.path)
    expect(paths).toEqual([
      `/channels/290926798999357250/messages/334385199974967042/reactions/${encodeURIComponent('👍')}/@me`,
      '/channels/290926798999357250/messages/334385199974967042/reactions/party_blob%3A123456789012345678/@me',
    ])
    expect(runtime.actions.react!.params.safeParse({ emoji: 'thumbsup' }).success).toBe(false)
    expect(runtime.actions.react!.params.safeParse({ emoji: '../x' }).success).toBe(false)
  })

  it('edits only messages Relay sent', async () => {
    expect((await rejection(run('update', { messageId: '1', text: 'x' }))).code).toBe('message_not_sent_by_relay')
    await db.insert(schema.sentMessages).values({ connectionId: connection.id, channel: '290926798999357250', ts: '1300000000000000001' })
    await run('update', { messageId: '1300000000000000001', text: 'edited' })
    const [req] = stub.calls('editMessage')
    expect(req!.path).toBe('/channels/290926798999357250/messages/1300000000000000001')
    expect(req!.body).toEqual({ content: 'edited', allowed_mentions: { parse: [] } })
  })

  it('reads history oldest first', async () => {
    const out = await run('thread.history', { limit: 2 })
    expect(stub.calls('getMessages')[0]!.path).toBe('/channels/290926798999357250/messages?limit=2')
    expect((out.result as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual(['older', 'newer'])
  })

  it('fails with no_credentials when no bot token is set', async () => {
    runtime = createDiscordRuntime({ db, botToken: tokenOf(undefined), apiBase: stub.url })
    expect((await rejection(run('post', { text: 'x' }))).code).toBe('no_credentials')
    expect(stub.requests).toHaveLength(0)
  })
})

describe('discord runtime error mapping', () => {
  it('maps 429 to a retryable error using retry_after seconds', async () => {
    stub.on('createMessage', () => ({ status: 429, json: { message: 'You are being rate limited.', retry_after: 1.5, global: false } }))
    const err = await rejection(run('post', { text: 'x' }))
    expect([err.code, err.retryable, err.retryAfterMs]).toEqual(['ratelimited', true, 1500])
  })

  it('falls back to X-RateLimit-Reset-After on 429', async () => {
    stub.on('createMessage', () => ({ status: 429, headers: { 'x-ratelimit-reset-after': '2.25' }, body: 'not json' }))
    const err = await rejection(run('post', { text: 'x' }))
    expect([err.code, err.retryable, err.retryAfterMs]).toEqual(['ratelimited', true, 2250])
  })

  it('maps 50013 missing permissions to a non-retryable error', async () => {
    stub.on('createMessage', () => ({ status: 403, json: { message: 'Missing Permissions', code: 50013 } }))
    const err = await rejection(run('reply', { text: 'x' }))
    expect([err.code, err.retryable]).toEqual(['missing_permissions', false])
  })

  it('maps unknown codes, 5xx, and network errors', async () => {
    stub.on('createMessage', () => ({ status: 400, json: { message: 'x', code: 99999 } }))
    expect((await rejection(run('post', { text: 'x' }))).code).toBe('discord_99999')
    stub.on('createMessage', () => ({ status: 502, body: 'bad gateway' }))
    const e5 = await rejection(run('post', { text: 'x' }))
    expect([e5.code, e5.retryable]).toEqual(['http_502', true])
    runtime = createDiscordRuntime({ db, botToken: tokenOf('t'), apiBase: 'http://127.0.0.1:1/api/v10' })
    const net = await rejection(run('post', { text: 'x' }))
    expect([net.code, net.retryable]).toEqual(['network_error', true])
  })
})

describe('discord isSelfEcho', () => {
  it('is true for a message Relay sent or one written by the bot user', async () => {
    runtime = createDiscordRuntime({ db, botToken: tokenOf('bot-token'), apiBase: stub.url, fetch })
    expect(await runtime.isSelfEcho(envelope(), connection)).toBe(false)
    expect(await runtime.isSelfEcho(envelope({}, DISCORD_STUB_BOT_ID), connection)).toBe(true)
    await db.insert(schema.sentMessages).values({ connectionId: connection.id, channel: '290926798999357250', ts: '334385199974967042' })
    expect(await runtime.isSelfEcho(envelope(), connection)).toBe(true)
    expect(stub.calls('getCurrentUser')).toHaveLength(1)
  })

  it('looks the bot user up again after the token changes', async () => {
    let token: string | undefined = 'bot-token'
    runtime = createDiscordRuntime({ db, botToken: async () => token, apiBase: stub.url, fetch })
    expect(await runtime.isSelfEcho(envelope({}, DISCORD_STUB_BOT_ID), connection)).toBe(true)
    expect(await runtime.isSelfEcho(envelope({}, DISCORD_STUB_BOT_ID), connection)).toBe(true)
    expect(stub.calls('getCurrentUser')).toHaveLength(1)
    token = 'rotated-token'
    expect(await runtime.isSelfEcho(envelope({}, DISCORD_STUB_BOT_ID), connection)).toBe(true)
    expect(stub.calls('getCurrentUser')).toHaveLength(2)
    token = undefined
    expect(await runtime.isSelfEcho(envelope({}, DISCORD_STUB_BOT_ID), connection)).toBe(false)
  })
})

describe('discord runtime token getter', () => {
  it('reads the token on every call, so a change applies at once', async () => {
    let token: string | undefined
    runtime = createDiscordRuntime({ db, botToken: async () => token, apiBase: stub.url })
    expect((await rejection(run('post', { text: 'x' }))).code).toBe('no_credentials')
    token = 'first-token'
    await run('post', { text: 'x' })
    token = 'second-token'
    await run('post', { text: 'y' })
    expect(stub.calls('createMessage').map((r) => r.headers.authorization)).toEqual(['Bot first-token', 'Bot second-token'])
  })

  it('fails retryably when the token cannot be read', async () => {
    runtime = createDiscordRuntime({ db, botToken: () => Promise.reject(new Error('db down')), apiBase: stub.url })
    const err = await rejection(run('post', { text: 'x' }))
    expect([err.code, err.retryable]).toEqual(['credentials_unavailable', true])
    expect(stub.requests).toHaveLength(0)
  })
})
