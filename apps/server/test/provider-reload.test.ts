import { eq } from 'drizzle-orm'
import { createProviderAppStore, providerAppEnv, schema, type ProviderAppStore } from '@relay/core'
import { TEST_MASTER_KEY } from '@relay/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { createLiveApps } from '../src/live-apps'
import { apiAs, PUBLIC_URL, SIGNING_SECRET, signIn, slackRequest, useHarness } from './harness'

const h = useHarness()

const SLACK = { clientId: '1111111111.2222222222', clientSecret: 'slack-client-secret-1', signingSecret: 'slack-signing-secret-A' }
const ROTATED = 'slack-signing-secret-B'
const BOT_ID = '1100000000000000001'
const DISCORD = { clientId: BOT_ID, clientSecret: 'discord-client-secret-1', botToken: `${Buffer.from(BOT_ID).toString('base64')}.GhIjKl.${'x'.repeat(27)}` }
const HANDSHAKE = JSON.stringify({ type: 'url_verification', token: 't', challenge: 'challenge-123' })

const store = (opts: { nowMs?: () => number; ttlMs?: number } = {}) =>
  createProviderAppStore({ db: h.db, masterKey: TEST_MASTER_KEY, env: providerAppEnv({}), ttlMs: opts.ttlMs ?? 5000, ...(opts.nowMs ? { nowMs: opts.nowMs } : {}) })

/** An install with no provider app settings in env, as a console-managed instance runs. */
function bareApp(opts: { providerApps?: ProviderAppStore; nowSeconds?: () => number } = {}) {
  return createApp({
    config: { PUBLIC_URL, SLACK_ALLOWED_USER_IDS: [], RELAY_MASTER_KEY: TEST_MASTER_KEY, SIGNUP_MODE: 'closed', DISCORD_API_BASE_URL: h.discord.url },
    db: h.db,
    queue: h.queue,
    connections: h.connections,
    cipher: h.cipher,
    consoleDistDir: h.distDir,
    metrics: h.metrics,
    fetch: h.fetch,
    ...(opts.providerApps ? { providerApps: opts.providerApps } : {}),
    ...(opts.nowSeconds ? { nowSeconds: opts.nowSeconds } : {}),
  })
}

const location = (res: Response) => new URL(res.headers.get('location')!)
const signedStatus = async () => (await h.db.select().from(schema.providerAppStatus).where(eq(schema.providerAppStatus.provider, 'slack')))[0]

describe('provider app settings reload at runtime', () => {
  it('serves 404 for Slack and Discord routes until settings exist', async () => {
    const app = bareApp()
    const me = await signIn(h)
    expect((await slackRequest(app, HANDSHAKE)).status).toBe(404)
    expect((await apiAs(app, me.cookie)('GET', '/oauth/slack/start')).status).toBe(404)
    expect((await apiAs(app, me.cookie)('GET', '/oauth/slack/callback?code=x&state=y')).status).toBe(404)
    expect((await apiAs(app, me.cookie)('GET', '/oauth/discord/start')).status).toBe(404)
    expect(await (await apiAs(app, me.cookie)('GET', '/api/connections/providers')).json()).toEqual({ slack: null, discord: null })
  })

  it('makes routes live once settings are saved, without a restart', async () => {
    let now = Date.now()
    const appStore = store({ nowMs: () => now })
    const app = bareApp({ providerApps: appStore })
    const me = await signIn(h)
    const api = apiAs(app, me.cookie)
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })).status).toBe(404)

    // Saved by another process (the admin API elsewhere): this store sees it after its TTL.
    const other = store()
    await other.save('slack', SLACK, { updatedBy: null })
    await other.save('discord', DISCORD, { updatedBy: null })
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })).status).toBe(404)
    now += 5001

    const hook = await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })
    expect(hook.status).toBe(200)
    expect(await hook.text()).toBe('challenge-123')
    expect((await slackRequest(app, HANDSHAKE, { secret: SIGNING_SECRET })).status).toBe(401)

    const slackStart = await api('GET', '/oauth/slack/start')
    expect(slackStart.status).toBe(302)
    expect(location(slackStart).searchParams.get('client_id')).toBe(SLACK.clientId)
    expect(location(slackStart).searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/oauth/slack/callback`)
    const discordStart = await api('GET', '/oauth/discord/start')
    expect(discordStart.status).toBe(302)
    expect(location(discordStart).searchParams.get('client_id')).toBe(BOT_ID)
    expect(await (await api('GET', '/api/connections/providers')).json()).toEqual({
      slack: `${PUBLIC_URL}/oauth/slack/start`,
      discord: `${PUBLIC_URL}/oauth/discord/start`,
    })

    await other.remove('slack')
    now += 5001
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })).status).toBe(404)
  })

  it('applies a save through the same store at once', async () => {
    const appStore = store()
    const app = bareApp({ providerApps: appStore })
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })).status).toBe(404)
    await appStore.save('slack', SLACK, { updatedBy: null })
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })).status).toBe(200)
  })

  it('answers 503 and counts it when saved settings cannot be used', async () => {
    const app = bareApp()
    const me = await signIn(h)
    await h.db.insert(schema.providerApps).values({ provider: 'slack', clientId: SLACK.clientId, clientSecretCt: 'v1.AAAA', signingSecretCt: 'v1.AAAA' })
    await h.db.insert(schema.providerApps).values({ provider: 'discord', clientId: BOT_ID, clientSecretCt: 'v1.AAAA', botTokenCt: 'v1.AAAA' })
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret })).status).toBe(503)
    expect((await apiAs(app, me.cookie)('GET', '/oauth/slack/start')).status).toBe(503)
    expect((await apiAs(app, me.cookie)('GET', '/oauth/discord/start')).status).toBe(503)
    expect(h.metrics.providerAppConfigErrors.get({ provider: 'slack', reason: 'unavailable' })).toBe(2)
    expect(h.metrics.providerAppConfigErrors.get({ provider: 'discord', reason: 'unavailable' })).toBe(1)
    expect(await (await apiAs(app, me.cookie)('GET', '/api/connections/providers')).json()).toEqual({ slack: null, discord: null })
  })

  it('keeps an env-only install working exactly as before', async () => {
    const me = await signIn(h)
    const api = apiAs(h.app, me.cookie)
    const hook = await slackRequest(h.app, HANDSHAKE)
    expect(hook.status).toBe(200)
    expect(await hook.text()).toBe('challenge-123')
    expect((await slackRequest(h.app, HANDSHAKE, { secret: 'not-the-secret' })).status).toBe(401)
    expect(location(await api('GET', '/oauth/slack/start')).searchParams.get('client_id')).toBe('client-id')
    expect(location(await api('GET', '/oauth/discord/start')).searchParams.get('client_id')).toBe('discord-client-id')
    expect(await (await api('GET', '/api/connections/providers')).json()).toEqual({
      slack: `${PUBLIC_URL}/oauth/slack/start`,
      discord: `${PUBLIC_URL}/oauth/discord/start`,
    })
    expect(h.metrics.providerAppConfigErrors.get({ provider: 'slack', reason: 'unavailable' })).toBe(0)
  })

  it('treats env Discord settings without both ids as not set up for install', async () => {
    const app = createApp({
      config: { PUBLIC_URL, SLACK_ALLOWED_USER_IDS: [], RELAY_MASTER_KEY: TEST_MASTER_KEY, SIGNUP_MODE: 'closed', DISCORD_BOT_TOKEN: 'only-a-bot-token' },
      db: h.db,
      queue: h.queue,
      connections: h.connections,
      cipher: h.cipher,
      consoleDistDir: h.distDir,
      metrics: h.metrics,
    })
    const me = await signIn(h)
    expect((await apiAs(app, me.cookie)('GET', '/oauth/discord/start')).status).toBe(404)
    expect(await (await apiAs(app, me.cookie)('GET', '/api/connections/providers')).json()).toEqual({ slack: null, discord: null })
  })
})

describe('Slack signing secret rotation', () => {
  it('accepts the previous secret until it expires, and counts it', async () => {
    const realNow = Math.floor(Date.now() / 1000)
    let now = realNow
    const appStore = store()
    const app = bareApp({ providerApps: appStore, nowSeconds: () => now })
    await appStore.save('slack', SLACK, { updatedBy: null })
    await appStore.save('slack', { clientId: SLACK.clientId, signingSecret: ROTATED }, { updatedBy: null })

    expect((await slackRequest(app, HANDSHAKE, { secret: ROTATED, timestamp: now })).status).toBe(200)
    expect(h.metrics.slackSignaturePrevious.get({})).toBe(0)
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret, timestamp: now })).status).toBe(200)
    expect(h.metrics.slackSignaturePrevious.get({})).toBe(1)
    expect((await slackRequest(app, HANDSHAKE, { secret: 'never-used-secret', timestamp: now })).status).toBe(401)

    now = realNow + 24 * 60 * 60 + 60
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret, timestamp: now })).status).toBe(401)
    expect((await slackRequest(app, HANDSHAKE, { secret: ROTATED, timestamp: now })).status).toBe(200)
    expect(h.metrics.slackSignaturePrevious.get({})).toBe(1)
    expect(h.metrics.ingressRequests.get({ provider: 'slack', outcome: 'bad_signature' })).toBe(2)
  })

  it('still rejects an old timestamp signed with either secret', async () => {
    const now = Math.floor(Date.now() / 1000)
    const appStore = store()
    const app = bareApp({ providerApps: appStore })
    await appStore.save('slack', SLACK, { updatedBy: null })
    await appStore.save('slack', { clientId: SLACK.clientId, signingSecret: ROTATED }, { updatedBy: null })
    expect((await slackRequest(app, HANDSHAKE, { secret: ROTATED, timestamp: now - 301 })).status).toBe(401)
    expect((await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret, timestamp: now - 301 })).status).toBe(401)
  })

  it('records the last signed request at most once a minute', async () => {
    const start = Math.floor(Date.now() / 1000)
    let now = start
    const appStore = store()
    const app = bareApp({ providerApps: appStore, nowSeconds: () => now })
    await appStore.save('slack', SLACK, { updatedBy: null })

    expect((await slackRequest(app, HANDSHAKE, { secret: 'wrong-secret-x', timestamp: now })).status).toBe(401)
    expect(await signedStatus()).toBeUndefined()

    await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret, timestamp: now })
    await vi.waitFor(async () => expect((await signedStatus())?.lastSignedOkAt?.getTime()).toBe(start * 1000))

    now = start + 30
    await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret, timestamp: now })
    now = start + 61
    await slackRequest(app, HANDSHAKE, { secret: SLACK.signingSecret, timestamp: now })
    await vi.waitFor(async () => expect((await signedStatus())?.lastSignedOkAt?.getTime()).toBe((start + 61) * 1000))
    expect((await signedStatus())?.state).toBe('ready')
  })
})

describe('per-request app objects', () => {
  it('reuses the built provider until the settings version changes', async () => {
    const appStore = store()
    const live = createLiveApps({
      db: h.db,
      store: appStore,
      connections: h.connections,
      metrics: h.metrics,
      ingress: { db: h.db, queue: h.queue, metrics: h.metrics },
      nowSeconds: () => Math.floor(Date.now() / 1000),
    })
    expect(await live.slackOAuth()).toEqual({ kind: 'missing' })
    await appStore.save('slack', SLACK, { updatedBy: null })
    const first = await live.slackOAuth()
    const again = await live.slackOAuth()
    expect(first.kind).toBe('ready')
    expect(again.kind === 'ready' && first.kind === 'ready' && again.provider === first.provider).toBe(true)
    await appStore.save('slack', { clientId: SLACK.clientId, clientSecret: 'slack-client-secret-2' }, { updatedBy: null })
    const after = await live.slackOAuth()
    expect(after.kind === 'ready' && first.kind === 'ready' && after.provider !== first.provider).toBe(true)
  })
})
