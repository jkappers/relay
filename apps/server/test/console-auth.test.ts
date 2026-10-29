import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { schema } from '@relay/core'
import { TEST_MASTER_KEY } from '@relay/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { scryptHasher, type PasswordHasher } from '../src/accounts/password'
import { createUser, setPassword } from '../src/accounts/users'
import { createApp, type AppDeps } from '../src/app'
import { SESSION_COOKIE } from '../src/console/session'
import { apiAs, CSRF, login, PASSWORD, PUBLIC_URL, signIn, useHarness } from './harness'

const h = useHarness()

function appWith(over: { publicUrl?: string; signup?: 'open' | 'closed'; nowSeconds?: () => number; hasher?: PasswordHasher } = {}) {
  const deps: AppDeps = {
    config: {
      PUBLIC_URL: over.publicUrl ?? PUBLIC_URL,
      SLACK_SIGNING_SECRET: 's',
      SLACK_CLIENT_ID: 'c',
      SLACK_CLIENT_SECRET: 'c',
      SLACK_ALLOWED_USER_IDS: [],
      RELAY_MASTER_KEY: TEST_MASTER_KEY,
      SIGNUP_MODE: over.signup ?? 'closed',
    },
    db: h.db,
    queue: h.queue,
    connections: h.connections,
    cipher: h.cipher,
    consoleDistDir: h.distDir,
    metrics: h.metrics,
    ...(over.nowSeconds ? { nowSeconds: over.nowSeconds } : {}),
    ...(over.hasher ? { hasher: over.hasher } : {}),
  }
  return createApp(deps)
}

const fromIp = (app: ReturnType<typeof createApp>, ip: string, body: unknown) =>
  app.request(
    '/api/session',
    { method: 'POST', headers: { 'content-type': 'application/json', ...CSRF }, body: JSON.stringify(body) },
    { incoming: { socket: { remoteAddress: ip } } },
  )

const signup = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request('/api/users', { method: 'POST', headers: { 'content-type': 'application/json', ...CSRF }, body: JSON.stringify(body) })

describe('console auth', () => {
  it('requires a session on every /api route except login and sign-up', async () => {
    const open = new Set(['POST /api/session', 'POST /api/users'])
    const routes = h.app.routes.filter((r) => r.path.startsWith('/api') && r.method !== 'ALL' && !open.has(`${r.method} ${r.path}`))
    expect(routes.length).toBeGreaterThan(25)
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, randomUUID())
      const res = await h.app.request(path, { method: r.method, headers: { ...CSRF, 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' })
      expect(res.status, `${r.method} ${r.path}`).toBe(401)
    }
    const unknown = await h.app.request('/api/does-not-exist', { headers: CSRF })
    expect(unknown.status).toBe(401)
  })

  it('logs in with email and password, sets a locked-down cookie, and stores only a hash of the token', async () => {
    await createUser(h.db, scryptHasher, { email: 'Owner@Example.com', password: PASSWORD })
    const { res, cookie } = await login(h.app, 'owner@example.COM')
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`))
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=43200')
    expect(setCookie).not.toContain('Secure')
    const token = cookie.split('=')[1]!
    const [row] = await h.db.select().from(schema.sessions)
    expect(row!.tokenHash).not.toContain(token)
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(h.metrics.consoleLogins.get({ outcome: 'success' })).toBe(1)
    const [user] = await h.db.select().from(schema.users)
    expect(user!.passwordHash).toMatch(/^scrypt\$N=8192,r=8,p=10\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
  })

  it('marks the cookie Secure when PUBLIC_URL is https', async () => {
    await createUser(h.db, scryptHasher, { email: 'a@example.com', password: PASSWORD })
    const { res } = await login(appWith({ publicUrl: 'https://relay.test' }), 'a@example.com')
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('answers a wrong password and an unknown email the same way', async () => {
    await createUser(h.db, scryptHasher, { email: 'a@example.com', password: PASSWORD })
    const wrong = await login(h.app, 'a@example.com', 'nope-nope-nope-nope')
    const unknown = await login(h.app, 'nobody@example.com')
    for (const r of [wrong, unknown]) {
      expect(r.res.status).toBe(401)
      expect(r.cookie).toBe('')
      expect(await r.res.json()).toEqual({ error: 'bad_credentials' })
    }
    expect(h.metrics.consoleLogins.get({ outcome: 'bad_credentials' })).toBe(2)
  })

  it('runs exactly one hash check for an unknown email, against a dummy hash', async () => {
    const verify = vi.fn(scryptHasher.verify)
    const app = appWith({ hasher: { hash: scryptHasher.hash, verify } })
    await createUser(h.db, scryptHasher, { email: 'a@example.com', password: PASSWORD })
    const [user] = await h.db.select().from(schema.users)

    await login(app, 'nobody@example.com')
    expect(verify).toHaveBeenCalledTimes(1)
    const dummy = verify.mock.calls[0]![0]
    expect(dummy).toMatch(/^scrypt\$N=8192,r=8,p=10\$/)
    expect(dummy).not.toBe(user!.passwordHash)

    await login(app, 'a@example.com', 'wrong-password-123')
    expect(verify).toHaveBeenCalledTimes(2)
    expect(verify.mock.calls[1]![0]).toBe(user!.passwordHash)

    let n = 0
    const time = async (email: string) => {
      const t = performance.now()
      expect((await fromIp(app, `10.9.0.${n++}`, { email, password: 'wrong-password-123' })).status).toBe(401)
      return performance.now() - t
    }
    const unknownMs = Math.min(await time('nobody@example.com'), await time('nobody@example.com'))
    const knownMs = Math.min(await time('a@example.com'), await time('a@example.com'))
    expect(unknownMs).toBeGreaterThan(knownMs / 3)
    expect(knownMs).toBeGreaterThan(unknownMs / 3)
  })

  it('throttles an address after 5 failures, even for the right password', async () => {
    await createUser(h.db, scryptHasher, { email: 'a@example.com', password: PASSWORD })
    for (let i = 0; i < 5; i++) expect((await login(h.app, 'a@example.com', 'wrong-wrong-wrong-1')).res.status).toBe(401)
    const blocked = await login(h.app, 'a@example.com')
    expect(blocked.res.status).toBe(429)
    expect(blocked.res.headers.get('retry-after')).toBeTruthy()
    expect(h.metrics.consoleLogins.get({ outcome: 'throttled' })).toBe(1)
  })

  it('limits failures per email across addresses', async () => {
    await createUser(h.db, scryptHasher, { email: 'a@example.com', password: PASSWORD })
    for (let i = 0; i < 10; i++) {
      expect((await fromIp(h.app, `10.0.0.${i}`, { email: 'a@example.com', password: 'wrong-wrong-wrong-1' })).status).toBe(401)
    }
    const blocked = await fromIp(h.app, '10.0.1.1', { email: 'A@example.com', password: PASSWORD })
    expect(blocked.status).toBe(429)
    expect(h.metrics.consoleLogins.get({ outcome: 'rate_limited' })).toBe(1)
    const other = await fromIp(h.app, '10.0.1.1', { email: 'b@example.com', password: PASSWORD })
    expect(other.status).toBe(401)
  })

  it('returns the user and their connections, and logout revokes the session on the server', async () => {
    const me = await signIn(h)
    const { connection } = await h.connections.createWebhook({ name: 'Deploys', ownerUserId: me.userId })
    await h.connections.createWebhook({ name: 'Not mine', ownerUserId: null })
    const body = (await (await me.api('GET', '/api/session')).json()) as any
    expect(body.user).toEqual({ id: me.userId, email: 'owner@example.com' })
    expect(body.signup).toBe('closed')
    expect(body.connections).toEqual([
      expect.objectContaining({ id: connection.id, name: 'Deploys', provider: 'webhook', status: 'active', role: 'owner' }),
    ])

    const out = await me.api('DELETE', '/api/session')
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=/)
    expect(await h.db.select().from(schema.sessions)).toHaveLength(0)
    expect((await me.api('GET', '/api/session')).status).toBe(401)
  })

  it('rejects expired, unknown and malformed session cookies', async () => {
    const me = await signIn(h)
    const later = appWith({ nowSeconds: () => Math.floor(Date.now() / 1000) + 13 * 3600 })
    expect((await later.request('/api/session', { headers: { cookie: me.cookie } })).status).toBe(401)
    for (const token of ['abc', 'A'.repeat(43), `${me.cookie.split('=')[1]!.slice(0, -1)}x`]) {
      const res = await h.app.request('/api/session', { headers: { cookie: `${SESSION_COOKIE}=${token}` } })
      expect(res.status, token).toBe(401)
    }
    expect((await h.app.request('/api/session', { headers: { cookie: me.cookie } })).status).toBe(200)
  })

  it('tells a signed-out client whether sign-up is open', async () => {
    const res = await h.app.request('/api/session')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', signup: 'closed' })
  })

  it('refuses sign-up when SIGNUP_MODE is closed', async () => {
    const res = await signup(h.app, { email: 'new@example.com', password: PASSWORD })
    expect(res.status).toBe(403)
    expect(await h.db.select().from(schema.users)).toHaveLength(0)
    expect(h.metrics.consoleSignups.get({ outcome: 'closed' })).toBe(1)
  })

  it('signs up and signs in when SIGNUP_MODE is open', async () => {
    const app = appWith({ signup: 'open' })
    expect((await signup(app, { email: 'new@example.com', password: 'short' })).status).toBe(400)
    const res = await signup(app, { email: 'New@Example.com', password: PASSWORD })
    expect(res.status).toBe(201)
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const session = (await (await apiAs(app, cookie)('GET', '/api/session')).json()) as any
    expect(session).toMatchObject({ user: { email: 'new@example.com' }, connections: [], signup: 'open' })
    expect((await signup(app, { email: 'new@EXAMPLE.com', password: PASSWORD })).status).toBe(409)
    expect(h.metrics.consoleSignups.get({ outcome: 'created' })).toBe(1)
    expect(h.metrics.consoleSignups.get({ outcome: 'email_taken' })).toBe(1)
  })

  it('users:set-password ends every session and swaps the password', async () => {
    const me = await signIn(h)
    const second = await login(h.app, me.email)
    expect(await h.db.select().from(schema.sessions)).toHaveLength(2)
    const ended = await setPassword(h.db, scryptHasher, { email: me.email, password: 'a brand new passphrase' })
    expect(ended).toBe(2)
    expect((await me.api('GET', '/api/session')).status).toBe(401)
    expect((await apiAs(h.app, second.cookie)('GET', '/api/session')).status).toBe(401)
    expect((await login(h.app, me.email)).res.status).toBe(401)
    expect((await login(h.app, me.email, 'a brand new passphrase')).res.status).toBe(204)
  })

  it('deletes sessions with the user', async () => {
    const me = await signIn(h)
    await h.db.delete(schema.users).where(eq(schema.users.id, me.userId))
    expect((await me.api('GET', '/api/session')).status).toBe(401)
  })

  it('requires X-Relay-Console on mutating requests', async () => {
    const me = await signIn(h)
    const post = (headers: Record<string, string>) =>
      h.app.request('/api/connections/webhook', { method: 'POST', headers: { cookie: me.cookie, 'content-type': 'application/json', ...headers }, body: '{}' })
    expect((await post({})).status).toBe(403)
    expect((await post({ 'x-relay-console': '0' })).status).toBe(403)
    expect((await post(CSRF)).status).toBe(201)
    const del = await h.app.request('/api/session', { method: 'DELETE', headers: { cookie: me.cookie } })
    expect(del.status).toBe(403)
    const loginNoHeader = await h.app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: me.email, password: PASSWORD }),
    })
    expect(loginNoHeader.status).toBe(403)
  })

  it('gates /oauth/slack/start behind the console session', async () => {
    const anon = await h.app.request('/oauth/slack/start')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/#/login')
    const me = await signIn(h)
    const authed = await h.app.request('/oauth/slack/start', { headers: { cookie: me.cookie } })
    expect(authed.status).toBe(302)
    expect(authed.headers.get('location')).toContain('slack.com/oauth')
  })
})

describe('console config', () => {
  it('needs no console password, defaults sign-up to closed, and makes the Slack allowlist optional', async () => {
    const { serverEnvSchema } = await import('../src/config')
    const base = {
      DATABASE_URL: 'postgres://x',
      RELAY_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
      PUBLIC_URL: 'http://localhost:3000',
      SLACK_SIGNING_SECRET: 's',
      SLACK_CLIENT_ID: 'c',
      SLACK_CLIENT_SECRET: 'c',
    }
    const parsed = serverEnvSchema.parse(base)
    expect(parsed.SIGNUP_MODE).toBe('closed')
    expect(parsed.SLACK_ALLOWED_USER_IDS).toEqual([])
    expect(serverEnvSchema.parse({ ...base, SIGNUP_MODE: 'open', SLACK_ALLOWED_USER_IDS: 'U1, U2' })).toMatchObject({
      SIGNUP_MODE: 'open',
      SLACK_ALLOWED_USER_IDS: ['U1', 'U2'],
    })
    expect(serverEnvSchema.safeParse({ ...base, SIGNUP_MODE: 'yes' }).success).toBe(false)
  })

  it('runs without Slack, but rejects a partial Slack app config', async () => {
    const { serverEnvSchema } = await import('../src/config')
    const base = { DATABASE_URL: 'postgres://x', RELAY_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), PUBLIC_URL: 'http://localhost:3000' }
    const parsed = serverEnvSchema.parse(base)
    expect(parsed.SLACK_SIGNING_SECRET).toBeUndefined()
    const partial = serverEnvSchema.safeParse({ ...base, SLACK_CLIENT_ID: 'c' })
    expect(partial.success).toBe(false)
    expect(partial.error?.issues.map((i) => i.path[0]).sort()).toEqual(['SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'])
  })
})
