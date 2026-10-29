import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  activeSlackSigningSecrets,
  ClientIdChangeError,
  createCipher,
  createDb,
  createProviderAppCipher,
  createProviderAppStore,
  discordBotIdFromToken,
  MetricsRegistry,
  ProviderAppFieldsError,
  providerAppEnv,
  schema,
  SIGNING_SECRET_OVERLAP_MS,
  type Db,
  type ProviderAppEnv,
} from '../src'
import { resetDb, TEST_DATABASE_URL, TEST_MASTER_KEY } from '../src/testing'

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  const h = createDb(TEST_DATABASE_URL, { max: 2 })
  db = h.db
  close = h.close
})
beforeEach(async () => {
  await resetDb(db)
})
afterAll(async () => {
  await resetDb(db)
  await close()
})

const SLACK = { clientId: '1111111111.2222222222', clientSecret: 'a'.repeat(32), signingSecret: 'b'.repeat(32) }
const BOT_ID = '1100000000000000001'
const OTHER_BOT_ID = '1100000000000000002'
const botToken = (id: string) => `${Buffer.from(id).toString('base64')}.GhIjKl.${'x'.repeat(27)}`
const DISCORD = { clientId: BOT_ID, clientSecret: 'c'.repeat(32), botToken: botToken(BOT_ID) }

const ENV: ProviderAppEnv = providerAppEnv({
  SLACK_SIGNING_SECRET: 'env-signing',
  SLACK_CLIENT_ID: 'env.client',
  SLACK_CLIENT_SECRET: 'env-secret',
  SLACK_ALLOWED_USER_IDS: ['U1'],
  DISCORD_BOT_TOKEN: 'env-bot-token',
})

function makeStore(over: { env?: ProviderAppEnv; ttlMs?: number; db?: Db; clock?: { now: number }; registry?: MetricsRegistry } = {}) {
  const clock = over.clock ?? { now: Date.now() }
  const registry = over.registry ?? new MetricsRegistry()
  const configErrors = registry.counter('relay_provider_app_config_errors_total', 'x', ['provider', 'reason'] as const)
  const store = createProviderAppStore({
    db: over.db ?? db,
    masterKey: TEST_MASTER_KEY,
    env: over.env ?? ENV,
    ttlMs: over.ttlMs ?? 5000,
    nowMs: () => clock.now,
    counters: { configErrors },
  })
  return { store, clock, configErrors }
}

async function addConnection(provider: 'slack' | 'discord', status: 'active' | 'revoked' = 'active') {
  await db.insert(schema.connections).values({ provider, teamId: `T${Math.random()}`, userId: 'U1', status })
}

describe('providerAppEnv', () => {
  it('needs all three Slack values and any Discord value', () => {
    expect(providerAppEnv({ SLACK_CLIENT_ID: 'x', SLACK_CLIENT_SECRET: 'y' }).slack).toBeNull()
    expect(providerAppEnv({}).discord).toBeNull()
    expect(ENV.slack).toMatchObject({ clientId: 'env.client', allowedUserIds: ['U1'], previousSigningSecret: null })
    expect(ENV.discord).toEqual({ clientId: null, clientSecret: null, botToken: 'env-bot-token', allowedUserIds: [] })
  })
})

describe('helpers', () => {
  it('reads the bot id from a token', () => {
    expect(discordBotIdFromToken(botToken(BOT_ID))).toBe(BOT_ID)
    expect(discordBotIdFromToken('garbage')).toBeNull()
  })

  it('accepts the previous signing secret only until it expires', () => {
    const cfg = { ...SLACK, previousSigningSecret: 'old', previousExpiresAt: new Date(2000), allowedUserIds: [] }
    expect(activeSlackSigningSecrets(cfg, new Date(1000))).toEqual([SLACK.signingSecret, 'old'])
    expect(activeSlackSigningSecrets(cfg, new Date(2000))).toEqual([SLACK.signingSecret])
  })
})

describe('provider app store', () => {
  it('falls back to env when there is no row, and reports missing without env', async () => {
    const { store } = makeStore()
    expect(await store.get('slack')).toMatchObject({ state: 'ready', source: 'env', version: 0, config: { clientId: 'env.client' } })
    const empty = makeStore({ env: { slack: null, discord: null } }).store
    expect(await empty.get('discord')).toEqual({ state: 'missing', source: null, config: null, version: 0 })
  })

  it('prefers a saved row over env and encrypts secrets with the subkey', async () => {
    const { store } = makeStore()
    const saved = await store.save('slack', { ...SLACK, allowedUserIds: ['U2', 'U2', ' U3 '] }, { updatedBy: null })
    expect(saved.fields.sort()).toEqual(['allowedUserIds', 'clientId', 'clientSecret', 'signingSecret'])
    const got = await store.get('slack')
    expect(got).toMatchObject({ state: 'ready', source: 'db', version: saved.version, config: { ...SLACK, allowedUserIds: ['U2', 'U3'] } })

    const [row] = await db.select().from(schema.providerApps)
    const raw = JSON.stringify(row)
    expect(raw).not.toContain(SLACK.clientSecret)
    expect(raw).not.toContain(SLACK.signingSecret)
    const master = await createCipher(TEST_MASTER_KEY)
    expect(() => master.decrypt(row!.clientSecretCt)).toThrow()
    expect((await createProviderAppCipher(TEST_MASTER_KEY)).decrypt(row!.clientSecretCt)).toBe(SLACK.clientSecret)
  })

  it('marks a row that does not decrypt invalid and never falls back to env', async () => {
    const { store, configErrors } = makeStore()
    await db.insert(schema.providerApps).values({ provider: 'slack', clientId: SLACK.clientId, clientSecretCt: 'v1.bm90LWEtYm94', signingSecretCt: 'v1.bm90LWEtYm94' })
    const got = await store.get('slack')
    expect(got).toMatchObject({ state: 'invalid', source: 'db', config: null, reason: 'decrypt' })
    expect(configErrors.get({ provider: 'slack', reason: 'decrypt' })).toBe(1)
  })

  it('marks a row whose values fail validation invalid', async () => {
    const { store } = makeStore()
    const cipher = await createProviderAppCipher(TEST_MASTER_KEY)
    await db.insert(schema.providerApps).values({ provider: 'discord', clientId: 'not-a-snowflake', clientSecretCt: cipher.encrypt('c'.repeat(32)), botTokenCt: cipher.encrypt(DISCORD.botToken) })
    expect(await store.get('discord')).toMatchObject({ state: 'invalid', reason: 'validate' })
  })

  it('requires every secret for a new row and names only the missing fields', async () => {
    const { store } = makeStore()
    const err = await store.save('discord', { clientId: BOT_ID, clientSecret: DISCORD.clientSecret }, { updatedBy: null }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderAppFieldsError)
    expect(err.fields).toEqual(['botToken'])
    expect(err.message).not.toContain(DISCORD.clientSecret)
  })

  it('keeps omitted secrets and bumps the version on every write, even after a delete', async () => {
    const { store } = makeStore({ env: { slack: null, discord: null } })
    const first = await store.save('discord', DISCORD, { updatedBy: null })
    const second = await store.save('discord', { clientId: BOT_ID, allowedUserIds: [OTHER_BOT_ID] }, { updatedBy: null })
    expect(second.version).toBeGreaterThan(first.version)
    expect(second.fields).toEqual(['allowedUserIds'])
    expect(await store.get('discord')).toMatchObject({ state: 'ready', config: { ...DISCORD, allowedUserIds: [OTHER_BOT_ID] } })
    expect(await store.remove('discord')).toBe(true)
    expect(await store.get('discord')).toMatchObject({ state: 'missing' })
    const third = await store.save('discord', DISCORD, { updatedBy: null })
    expect(third.version).toBeGreaterThan(second.version)
    expect(await store.remove('slack')).toBe(false)
  })

  it('serves from cache within the TTL, drops it on its own write, and reloads after the TTL', async () => {
    const { store, clock } = makeStore({ ttlMs: 1000 })
    expect((await store.get('slack')).source).toBe('env')
    const cipher = await createProviderAppCipher(TEST_MASTER_KEY)
    await db.insert(schema.providerApps).values({ provider: 'slack', clientId: SLACK.clientId, clientSecretCt: cipher.encrypt(SLACK.clientSecret), signingSecretCt: cipher.encrypt(SLACK.signingSecret) })
    expect((await store.get('slack')).source).toBe('env')
    expect((await store.get('slack', { fresh: true })).source).toBe('db')
    await db.delete(schema.providerApps)
    expect((await store.get('slack')).source).toBe('db')
    clock.now += 1001
    expect((await store.get('slack')).source).toBe('env')
    await store.save('slack', SLACK, { updatedBy: null })
    expect((await store.get('slack')).source).toBe('db')
  })

  it('keeps the last good value when the database fails, and throws with nothing cached', async () => {
    let failing = false
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === 'select' && failing) return () => { throw new Error('db down') }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const { store, clock, configErrors } = makeStore({ db: flaky, ttlMs: 10 })
    await store.save('slack', SLACK, { updatedBy: null })
    const good = await store.get('slack')
    failing = true
    clock.now += 100
    expect(await store.get('slack')).toEqual(good)
    expect(configErrors.get({ provider: 'slack', reason: 'db' })).toBe(1)
    await expect(store.get('discord')).rejects.toThrow('db down')
  })

  it('keeps the old Slack signing secret for 24 hours after a change', async () => {
    const { store, clock } = makeStore()
    await store.save('slack', SLACK, { updatedBy: null })
    const t0 = clock.now
    await store.save('slack', { clientId: SLACK.clientId, signingSecret: 'd'.repeat(32) }, { updatedBy: null })
    const got = await store.get('slack')
    if (got.state !== 'ready') throw new Error('not ready')
    expect(got.config).toMatchObject({ signingSecret: 'd'.repeat(32), previousSigningSecret: SLACK.signingSecret })
    expect(got.config.previousExpiresAt?.getTime()).toBe(t0 + SIGNING_SECRET_OVERLAP_MS)
    clock.now += SIGNING_SECRET_OVERLAP_MS + 1
    const later = await store.get('slack', { fresh: true })
    expect(later).toMatchObject({ config: { previousSigningSecret: null, previousExpiresAt: null } })
  })

  it('requires confirmation to change the client id while connections exist, including from env', async () => {
    const { store } = makeStore()
    await addConnection('slack', 'revoked')
    await store.save('slack', SLACK, { updatedBy: null })
    await addConnection('slack')
    await addConnection('slack')

    const other = { ...SLACK, clientId: '3333333333.4444444444' }
    const err = await store.save('slack', other, { updatedBy: null }).catch((e) => e)
    expect(err).toBeInstanceOf(ClientIdChangeError)
    expect(err.connections).toBe(2)
    expect(await store.get('slack', { fresh: true })).toMatchObject({ config: { clientId: SLACK.clientId } })

    await store.save('slack', { clientId: SLACK.clientId, clientSecret: 'e'.repeat(32) }, { updatedBy: null })
    await store.save('slack', other, { updatedBy: null, confirmClientIdChange: true })
    expect(await store.get('slack')).toMatchObject({ config: { clientId: other.clientId, previousSigningSecret: null } })

    const removeErr = await store.remove('slack').catch((e) => e)
    expect(removeErr).toBeInstanceOf(ClientIdChangeError)
    expect(await store.remove('slack', { confirmClientIdChange: true })).toBe(true)
  })

  it('treats a bot token from another app as an app change', async () => {
    const { store } = makeStore({ env: { slack: null, discord: null } })
    await store.save('discord', DISCORD, { updatedBy: null })
    await addConnection('discord')
    const err = await store.save('discord', { clientId: BOT_ID, botToken: botToken(OTHER_BOT_ID) }, { updatedBy: null }).catch((e) => e)
    expect(err).toBeInstanceOf(ClientIdChangeError)
    await store.save('discord', { clientId: BOT_ID, botToken: `${botToken(BOT_ID)}rotated` }, { updatedBy: null })
    const [row] = await db.select({ version: schema.providerApps.version }).from(schema.providerApps).where(eq(schema.providerApps.provider, 'discord'))
    expect(row?.version).toBeGreaterThan(0)
  })

  it('needs no confirmation when there are no connections', async () => {
    const { store } = makeStore()
    await store.save('slack', SLACK, { updatedBy: null })
    await store.save('slack', { ...SLACK, clientId: '3333333333.4444444444' }, { updatedBy: null })
    expect(await store.get('slack')).toMatchObject({ config: { clientId: '3333333333.4444444444' } })
  })
})
