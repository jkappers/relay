import { eq } from 'drizzle-orm'
import { schema } from '@relay/core'
import { TEST_MASTER_KEY } from '@relay/core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scryptHasher } from '../src/accounts/password'
import { createUser, setAdmin } from '../src/accounts/users'
import { createApp } from '../src/app'
import { apiAs, CSRF, login, PASSWORD, PUBLIC_URL, SIGNING_SECRET, signIn, useHarness, type Account } from './harness'

const h = useHarness()

const SLACK = { clientId: '1111111111.2222222222', clientSecret: 'PLANTED-slack-client-secret-1', signingSecret: 'PLANTED-slack-signing-secret-2' }
const BOT_ID = '1100000000000000001'
const OTHER_ID = '1100000000000000002'
const botToken = (id: string, tail = 'PLANTEDbotTokenTail3xxxxxxxx') => `${Buffer.from(id).toString('base64')}.GhIjKl.${tail}`
const DISCORD = { clientId: BOT_ID, clientSecret: 'PLANTED-discord-client-secret-4', botToken: botToken(BOT_ID) }
const PLANTED = [SLACK.clientSecret, SLACK.signingSecret, DISCORD.clientSecret, DISCORD.botToken, 'PLANTEDbotTokenTail3', 'PLANTED bad value 5']

let logs: string[]
const bodies: string[] = []
beforeEach(() => {
  logs = []
  bodies.length = 0
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function text(res: Response | Promise<Response>): Promise<{ status: number; body: string }> {
  const r = await res
  const body = await r.text()
  bodies.push(body)
  return { status: r.status, body }
}
const json = async (res: Response | Promise<Response>): Promise<{ status: number; body: any }> => {
  const t = await text(res)
  return { status: t.status, body: t.body ? JSON.parse(t.body) : null }
}

function expectNoSecrets() {
  for (const s of PLANTED) {
    for (const b of bodies) expect(b, `response leaks ${s}`).not.toContain(s)
    for (const l of logs) expect(l, `log leaks ${s}`).not.toContain(s)
  }
}

async function signInAdmin(email = 'admin@example.com'): Promise<Account> {
  const user = await createUser(h.db, scryptHasher, { email, password: PASSWORD }, { admin: true })
  const { res, cookie } = await login(h.app, email)
  if (res.status !== 204) throw new Error(`login failed: ${res.status}`)
  return { userId: user.id, email, cookie, api: apiAs(h.app, cookie) }
}

const addConnection = (provider: 'slack' | 'discord', teamId = 'T1') =>
  h.db.insert(schema.connections).values({ provider, teamId, userId: 'U1', status: 'active' })

function stubSlack(error: string | null, status = 200) {
  h.fetch.mockImplementation(async () => Response.json(error === null ? { ok: true } : { ok: false, error }, { status }))
}

function stubDiscord(opts: { appId?: string; me?: number; token?: number; tokenError?: string } = {}) {
  h.fetch.mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('/users/@me')) return opts.me && opts.me !== 200 ? Response.json({ message: '401: Unauthorized' }, { status: opts.me }) : Response.json({ id: BOT_ID })
    if (url.endsWith('/oauth2/applications/@me')) return Response.json({ id: opts.appId ?? BOT_ID })
    if (url.endsWith('/oauth2/token')) {
      return opts.token && opts.token !== 200
        ? Response.json({ error: opts.tokenError ?? 'invalid_client' }, { status: opts.token })
        : Response.json({ access_token: 'tok', token_type: 'Bearer', expires_in: 604800, scope: 'identify' })
    }
    return new Response('unexpected', { status: 500 })
  })
}

describe('admin access', () => {
  it('answers 404 to a signed-in non-admin on every admin route, and counts it', async () => {
    const user = await signIn(h)
    const routes = h.app.routes.filter((r) => r.path.startsWith('/api/admin/') && r.method !== 'ALL')
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/admin/integrations/:provider',
      'GET /api/admin/integrations',
      'POST /api/admin/integrations/:provider/test',
      'PUT /api/admin/integrations/:provider',
    ])
    for (const r of routes) {
      const res = await json(user.api(r.method, r.path.replace(':provider', 'slack'), r.method === 'PUT' ? { ...SLACK, confirmClientIdChange: true } : undefined))
      expect(res, `${r.method} ${r.path}`).toEqual({ status: 404, body: { error: 'not_found' } })
    }
    expect((await json(user.api('GET', '/api/admin/nope'))).status).toBe(404)
    expect(h.metrics.adminDenied.get({})).toBe(routes.length + 1)
    expect(await h.db.select().from(schema.providerApps)).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('reports isAdmin in the session payload', async () => {
    const user = await signIn(h)
    const admin = await signInAdmin()
    expect((await json(user.api('GET', '/api/session'))).body.user).toMatchObject({ isAdmin: false })
    expect((await json(admin.api('GET', '/api/session'))).body.user).toMatchObject({ isAdmin: true })
  })

  it('applies a demotion on the next request, and a grant too', async () => {
    const admin = await signInAdmin()
    expect((await json(admin.api('GET', '/api/admin/integrations'))).status).toBe(200)
    await setAdmin(h.db, 'ADMIN@example.com', false)
    expect((await json(admin.api('GET', '/api/admin/integrations'))).status).toBe(404)
    expect((await json(admin.api('GET', '/api/session'))).body.user.isAdmin).toBe(false)
    await setAdmin(h.db, admin.email, true)
    expect((await json(admin.api('GET', '/api/admin/integrations'))).status).toBe(200)
  })

  it('never grants admin through HTTP sign-up, even when asked', async () => {
    const app = createApp({
      config: { PUBLIC_URL, SLACK_ALLOWED_USER_IDS: [], RELAY_MASTER_KEY: TEST_MASTER_KEY, SIGNUP_MODE: 'open' },
      db: h.db,
      queue: h.queue,
      connections: h.connections,
      cipher: h.cipher,
      consoleDistDir: h.distDir,
      metrics: h.metrics,
      fetch: h.fetch,
    })
    const res = await app.request('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF },
      body: JSON.stringify({ email: 'new@example.com', password: PASSWORD, isAdmin: true, is_admin: true, admin: true }),
    })
    expect(res.status).toBe(201)
    const [user] = await h.db.select().from(schema.users)
    expect(user!.isAdmin).toBe(false)
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    expect((await json(apiAs(app, cookie)('GET', '/api/admin/integrations'))).status).toBe(404)
  })

  it('needs the CSRF header on admin changes', async () => {
    const admin = await signInAdmin()
    for (const [method, path] of [
      ['PUT', '/api/admin/integrations/slack'],
      ['DELETE', '/api/admin/integrations/slack'],
      ['POST', '/api/admin/integrations/slack/test'],
    ] as const) {
      const res = await h.app.request(path, { method, headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify(SLACK) })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    expect(await h.db.select().from(schema.providerApps)).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown provider', async () => {
    const admin = await signInAdmin()
    expect((await json(admin.api('PUT', '/api/admin/integrations/sms', SLACK))).status).toBe(404)
    expect((await json(admin.api('DELETE', '/api/admin/integrations/sms'))).status).toBe(404)
    expect((await json(admin.api('POST', '/api/admin/integrations/sms/test'))).status).toBe(404)
  })
})

describe('integrations', () => {
  it('shows env settings as the fallback, with no secret values', async () => {
    const admin = await signInAdmin()
    await addConnection('slack')
    const { status, body } = await json(admin.api('GET', '/api/admin/integrations'))
    expect(status).toBe(200)
    expect(body.publicUrl).toBe(PUBLIC_URL)
    expect(body.warnings).toEqual(['not_https'])
    expect(body.providers.slack).toMatchObject({
      state: 'ready',
      source: 'env',
      clientId: 'client-id',
      allowedUserIds: ['U065VRX1T0'],
      secrets: {
        clientSecret: { set: true, source: 'env', updatedAt: null, updatedBy: null },
        signingSecret: { set: true, source: 'env', updatedAt: null, updatedBy: null },
      },
      urls: { redirect: `${PUBLIC_URL}/oauth/slack/callback`, events: `${PUBLIC_URL}/hooks/slack` },
      status: null,
      connections: 1,
    })
    expect(body.providers.discord).toMatchObject({ state: 'ready', source: 'env', clientId: 'discord-client-id', connections: 0 })
    for (const s of ['client-secret', SIGNING_SECRET, 'discord-client-secret', 'discord-bot-token']) expect(JSON.stringify(body)).not.toContain(s)
  })

  it('saves settings write-only, prefers them over env, and never echoes or logs a secret', async () => {
    const admin = await signInAdmin()
    const put = await text(admin.api('PUT', '/api/admin/integrations/slack', { ...SLACK, allowedUserIds: ['U1', ' U2 '] }))
    expect(put).toEqual({ status: 204, body: '' })
    expect((await text(admin.api('PUT', '/api/admin/integrations/discord', DISCORD))).status).toBe(204)
    expect(h.metrics.providerAppChanges.get({ provider: 'slack' })).toBe(1)
    expect(h.metrics.providerAppChanges.get({ provider: 'discord' })).toBe(1)

    const { body } = await json(admin.api('GET', '/api/admin/integrations'))
    expect(body.providers.slack).toMatchObject({
      state: 'ready',
      source: 'db',
      clientId: SLACK.clientId,
      allowedUserIds: ['U1', 'U2'],
      updatedBy: admin.email,
      secrets: { clientSecret: { set: true, source: 'db', updatedBy: admin.email }, signingSecret: { set: true, source: 'db' } },
    })
    expect(body.providers.discord).toMatchObject({ state: 'ready', source: 'db', clientId: BOT_ID, secrets: { botToken: { set: true, source: 'db' } } })

    const rotated = await text(admin.api('PUT', '/api/admin/integrations/slack', { clientId: SLACK.clientId, signingSecret: 'PLANTED bad value 5' }))
    expect(rotated.status).toBe(400)
    expect(JSON.parse(rotated.body)).toEqual({ error: 'validation', fields: ['signingSecret'] })

    stubSlack('invalid_code')
    await json(admin.api('POST', '/api/admin/integrations/slack/test'))
    stubDiscord()
    await json(admin.api('POST', '/api/admin/integrations/discord/test'))

    expect(logs.some((l) => l.includes('provider app saved') && l.includes('clientSecret'))).toBe(true)
    const [row] = await h.db.select({ updatedBy: schema.providerApps.updatedBy }).from(schema.providerApps).where(eq(schema.providerApps.provider, 'slack'))
    expect(row!.updatedBy).toBe(admin.userId)
    expectNoSecrets()
    const rows = JSON.stringify(await h.db.select().from(schema.providerApps))
    for (const s of PLANTED) expect(rows).not.toContain(s)
  })

  it('names only fields in validation errors', async () => {
    const admin = await signInAdmin()
    const bad = await json(admin.api('PUT', '/api/admin/integrations/slack', { clientId: 'nope', clientSecret: 'PLANTED bad value 5', signingSecret: SLACK.signingSecret }))
    expect(bad).toEqual({ status: 400, body: { error: 'validation', fields: ['clientId', 'clientSecret'] } })
    const missing = await json(admin.api('PUT', '/api/admin/integrations/slack', { clientId: SLACK.clientId, clientSecret: SLACK.clientSecret }))
    expect(missing).toEqual({ status: 400, body: { error: 'validation', fields: ['signingSecret'] } })
    const extra = await json(admin.api('PUT', '/api/admin/integrations/discord', { ...DISCORD, botToken: undefined, token: DISCORD.botToken }))
    expect(extra.status).toBe(400)
    expect(await h.db.select().from(schema.providerApps)).toEqual([])
    expectNoSecrets()
  })

  it('asks for confirmation before switching apps while connections exist', async () => {
    const admin = await signInAdmin()
    await addConnection('slack', 'T1')
    await addConnection('slack', 'T2')

    const refused = await json(admin.api('PUT', '/api/admin/integrations/slack', SLACK))
    expect(refused).toEqual({ status: 409, body: { error: 'client_id_change', connections: 2 } })
    expect(await h.db.select().from(schema.providerApps)).toEqual([])
    expect(h.metrics.providerAppChanges.get({ provider: 'slack' })).toBe(0)

    expect((await text(admin.api('PUT', '/api/admin/integrations/slack', { ...SLACK, confirmClientIdChange: true }))).status).toBe(204)
    expect((await text(admin.api('PUT', '/api/admin/integrations/slack', { clientId: SLACK.clientId, clientSecret: 'PLANTED-rotated-secret-6' }))).status).toBe(204)

    expect(await json(admin.api('DELETE', '/api/admin/integrations/slack'))).toEqual({ status: 409, body: { error: 'client_id_change', connections: 2 } })
    expect((await text(admin.api('DELETE', '/api/admin/integrations/slack?confirmClientIdChange=true'))).status).toBe(204)
    expect((await json(admin.api('GET', '/api/admin/integrations'))).body.providers.slack).toMatchObject({ source: 'env', clientId: 'client-id' })
    expect((await json(admin.api('DELETE', '/api/admin/integrations/slack'))).status).toBe(404)
    expect(h.metrics.providerAppChanges.get({ provider: 'slack' })).toBe(3)
  })

  it('treats a bot token from another Discord app as an app change', async () => {
    const admin = await signInAdmin()
    expect((await text(admin.api('PUT', '/api/admin/integrations/discord', { ...DISCORD, confirmClientIdChange: true }))).status).toBe(204)
    await addConnection('discord')
    const other = await json(admin.api('PUT', '/api/admin/integrations/discord', { clientId: BOT_ID, botToken: botToken(OTHER_ID) }))
    expect(other).toEqual({ status: 409, body: { error: 'client_id_change', connections: 1 } })
    expect((await text(admin.api('PUT', '/api/admin/integrations/discord', { clientId: BOT_ID, botToken: botToken(BOT_ID, 'PLANTEDbotTokenTail3rotated') }))).status).toBe(204)
    expectNoSecrets()
  })

  it('marks saved settings that do not decrypt invalid and never falls back to env', async () => {
    const admin = await signInAdmin()
    await h.db.insert(schema.providerApps).values({ provider: 'slack', clientId: SLACK.clientId, clientSecretCt: 'v1.AAAA', signingSecretCt: 'v1.AAAA' })
    const { body } = await json(admin.api('GET', '/api/admin/integrations'))
    expect(body.providers.slack).toMatchObject({ state: 'invalid', source: 'db', invalidReason: 'decrypt', clientId: SLACK.clientId })
    expect(h.metrics.providerAppConfigErrors.get({ provider: 'slack', reason: 'decrypt' })).toBeGreaterThan(0)
    const tested = await json(admin.api('POST', '/api/admin/integrations/slack/test'))
    expect(tested.body).toMatchObject({ ok: false, state: 'invalid', checks: [] })
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.metrics.providerAppTests.get({ provider: 'slack', result: 'not_configured' })).toBe(1)
  })
})

describe('test button', () => {
  it('never calls a provider except when an admin presses Test', async () => {
    const admin = await signInAdmin()
    await text(admin.api('PUT', '/api/admin/integrations/slack', SLACK))
    await json(admin.api('GET', '/api/admin/integrations'))
    await text(admin.api('DELETE', '/api/admin/integrations/slack'))
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('checks the Slack client id and secret with a code that cannot be valid', async () => {
    const admin = await signInAdmin()
    await text(admin.api('PUT', '/api/admin/integrations/slack', SLACK))
    await h.db.insert(schema.providerAppStatus).values({ provider: 'slack', state: 'ok', lastSignedOkAt: new Date('2026-01-02T03:04:05Z') })
    stubSlack('invalid_code')
    const ok = await json(admin.api('POST', '/api/admin/integrations/slack/test'))
    expect(ok.body).toEqual({
      provider: 'slack',
      ok: true,
      result: 'ok',
      source: 'db',
      checks: [
        { check: 'client_id', result: 'ok' },
        { check: 'client_secret', result: 'ok' },
        { check: 'signing_secret', result: 'skipped', code: 'not_testable' },
      ],
      lastSignedOkAt: '2026-01-02T03:04:05.000Z',
    })
    const [url, init] = h.fetch.mock.calls[0]!
    expect(String(url)).toBe(`${h.slack.url}/oauth.v2.access`)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SLACK.clientId}:${SLACK.clientSecret}`).toString('base64')}`)
    expect(String(init?.body)).not.toContain(SLACK.clientSecret)

    stubSlack('bad_client_secret')
    expect((await json(admin.api('POST', '/api/admin/integrations/slack/test'))).body).toMatchObject({
      ok: false,
      result: 'failed',
      checks: [{ check: 'client_id', result: 'ok' }, { check: 'client_secret', result: 'failed', code: 'bad_client_secret' }, { check: 'signing_secret' }],
    })
    stubSlack('invalid_client_id')
    expect((await json(admin.api('POST', '/api/admin/integrations/slack/test'))).body).toMatchObject({ result: 'failed', checks: [{ check: 'client_id', result: 'failed' }, {}] })
    h.fetch.mockRejectedValue(new TypeError('fetch failed'))
    expect((await json(admin.api('POST', '/api/admin/integrations/slack/test'))).body).toMatchObject({ result: 'error', checks: [{ check: 'client_id', result: 'error', code: 'network' }, {}] })
    expect(h.metrics.providerAppTests.get({ provider: 'slack', result: 'ok' })).toBe(1)
    expect(h.metrics.providerAppTests.get({ provider: 'slack', result: 'failed' })).toBe(2)
    expect(h.metrics.providerAppTests.get({ provider: 'slack', result: 'error' })).toBe(1)
    expectNoSecrets()
  })

  it('checks the Discord bot token, that it belongs to the saved app, and the client secret', async () => {
    const admin = await signInAdmin()
    await text(admin.api('PUT', '/api/admin/integrations/discord', { ...DISCORD, confirmClientIdChange: true }))
    stubDiscord()
    const ok = await json(admin.api('POST', '/api/admin/integrations/discord/test'))
    expect(ok.body).toEqual({
      provider: 'discord',
      ok: true,
      result: 'ok',
      source: 'db',
      checks: [
        { check: 'bot_token', result: 'ok' },
        { check: 'application', result: 'ok' },
        { check: 'client_secret', result: 'ok' },
      ],
    })
    const calls = h.fetch.mock.calls.map(([u, init]) => ({ url: String(u), headers: new Headers(init?.headers), body: init?.body }))
    expect(calls.map((c) => c.url)).toEqual([`${h.discord.url}/users/@me`, `${h.discord.url}/oauth2/applications/@me`, `${h.discord.url}/oauth2/token`])
    expect(calls[0]!.headers.get('authorization')).toBe(`Bot ${DISCORD.botToken}`)
    expect(calls[0]!.headers.get('user-agent')).toMatch(/^DiscordBot \(/)
    expect(calls[2]!.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${BOT_ID}:${DISCORD.clientSecret}`).toString('base64')}`)
    expect(String(calls[2]!.body)).toBe('grant_type=client_credentials&scope=identify')

    stubDiscord({ appId: OTHER_ID })
    expect((await json(admin.api('POST', '/api/admin/integrations/discord/test'))).body).toMatchObject({
      result: 'failed',
      checks: [{ check: 'bot_token', result: 'ok' }, { check: 'application', result: 'failed', code: 'app_mismatch' }, { check: 'client_secret', result: 'ok' }],
    })
    stubDiscord({ me: 401 })
    expect((await json(admin.api('POST', '/api/admin/integrations/discord/test'))).body).toMatchObject({
      result: 'failed',
      checks: [{ check: 'bot_token', result: 'failed', code: 'http_401' }, { check: 'application', result: 'skipped' }, { check: 'client_secret', result: 'ok' }],
    })
    stubDiscord({ token: 401 })
    expect((await json(admin.api('POST', '/api/admin/integrations/discord/test'))).body.checks[2]).toEqual({ check: 'client_secret', result: 'failed', code: 'invalid_client' })
    expectNoSecrets()
  })

  it('tests the env Discord app when nothing is saved', async () => {
    const admin = await signInAdmin()
    stubDiscord({ appId: 'discord-client-id' })
    const res = await json(admin.api('POST', '/api/admin/integrations/discord/test'))
    expect(res.body).toMatchObject({ source: 'env', checks: [{ check: 'bot_token', result: 'ok' }, { check: 'application', result: 'ok' }, { check: 'client_secret', result: 'ok' }] })
  })
})
