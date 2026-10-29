import { randomUUID } from 'node:crypto'
import { TEST_MASTER_KEY } from '@relay/core/testing'
import { describe, expect, it } from 'vitest'
import { createSessionToken, deriveSessionKey, SESSION_COOKIE } from '../src/console/session'
import { apiAs, CONSOLE_PASSWORD, CSRF, login, useHarness } from './harness'

const h = useHarness()
const sessionKey = deriveSessionKey(TEST_MASTER_KEY)
const now = () => Math.floor(Date.now() / 1000)

describe('console auth', () => {
  it('requires a session on every /api route except login', async () => {
    const routes = h.app.routes.filter(
      (r) => r.path.startsWith('/api') && r.method !== 'ALL' && !(r.method === 'POST' && r.path === '/api/session'),
    )
    expect(routes.length).toBeGreaterThan(25)
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, randomUUID())
      const res = await h.app.request(path, { method: r.method, headers: { ...CSRF, 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' })
      expect(res.status, `${r.method} ${r.path}`).toBe(401)
    }
    const unknown = await h.app.request('/api/does-not-exist', { headers: CSRF })
    expect(unknown.status).toBe(401)
  })

  it('logs in with the right password and sets a locked-down cookie', async () => {
    const { res } = await login(h.app)
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`))
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=43200')
    expect(setCookie).not.toContain('Secure')
    expect(h.metrics.consoleLogins.get({ outcome: 'success' })).toBe(1)
  })

  it('marks the cookie Secure when PUBLIC_URL is https', async () => {
    const { createApp } = await import('../src/app')
    const app = createApp({
      config: {
        PUBLIC_URL: 'https://relay.test',
        SLACK_SIGNING_SECRET: 's',
        SLACK_CLIENT_ID: 'c',
        SLACK_CLIENT_SECRET: 'c',
        SLACK_ALLOWED_USER_IDS: ['U1'],
        RELAY_MASTER_KEY: TEST_MASTER_KEY,
        CONSOLE_PASSWORD,
      },
      db: h.db,
      queue: h.queue,
      connections: h.connections,
      cipher: h.cipher,
      consoleDistDir: h.distDir,
      metrics: h.metrics,
    })
    const { res } = await login(app)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('rejects a wrong password without a cookie', async () => {
    const { res, cookie } = await login(h.app, 'nope-nope-nope-nope')
    expect(res.status).toBe(401)
    expect(cookie).toBe('')
    expect(h.metrics.consoleLogins.get({ outcome: 'bad_password' })).toBe(1)
  })

  it('throttles after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login(h.app, 'wrong-wrong-wrong-1')).res.status).toBe(401)
    const blocked = await login(h.app)
    expect(blocked.res.status).toBe(429)
    expect(blocked.res.headers.get('retry-after')).toBeTruthy()
    expect(h.metrics.consoleLogins.get({ outcome: 'throttled' })).toBe(1)
  })

  it('accepts the session cookie, and logout clears it', async () => {
    const { cookie } = await login(h.app)
    const api = apiAs(h.app, cookie)
    expect((await api('GET', '/api/session')).status).toBe(200)
    const out = await api('DELETE', '/api/session')
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=/)
  })

  it('rejects expired, tampered and malformed cookies', async () => {
    const expired = createSessionToken(sessionKey, now() - 13 * 3600)
    const valid = createSessionToken(sessionKey, now())
    const [v, exp, mac] = valid.split('.') as [string, string, string]
    const cases = {
      expired,
      tamperedExpiry: `${v}.${Number(exp) + 100000}.${mac}`,
      tamperedMac: `${v}.${exp}.${mac.slice(0, -2)}AA`,
      otherKey: createSessionToken(deriveSessionKey(new Uint8Array(32).fill(9)), now()),
      garbage: 'abc',
    }
    for (const [name, token] of Object.entries(cases)) {
      const res = await h.app.request('/api/session', { headers: { cookie: `${SESSION_COOKIE}=${token}` } })
      expect(res.status, name).toBe(401)
    }
    const ok = await h.app.request('/api/session', { headers: { cookie: `${SESSION_COOKIE}=${valid}` } })
    expect(ok.status).toBe(200)
  })

  it('requires X-Relay-Console on mutating requests', async () => {
    const { cookie } = await login(h.app)
    const post = (headers: Record<string, string>) =>
      h.app.request('/api/connections/webhook', { method: 'POST', headers: { cookie, ...headers } })
    expect((await post({})).status).toBe(403)
    expect((await post({ 'x-relay-console': '0' })).status).toBe(403)
    expect((await post(CSRF)).status).toBe(201)
    const del = await h.app.request('/api/session', { method: 'DELETE', headers: { cookie } })
    expect(del.status).toBe(403)
    const loginNoHeader = await h.app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CONSOLE_PASSWORD }),
    })
    expect(loginNoHeader.status).toBe(403)
  })

  it('gates /oauth/slack/start behind the console session', async () => {
    const anon = await h.app.request('/oauth/slack/start')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/#/login')
    const { cookie } = await login(h.app)
    const authed = await h.app.request('/oauth/slack/start', { headers: { cookie } })
    expect(authed.status).toBe(302)
    expect(authed.headers.get('location')).toContain('slack.com/oauth')
  })
})

describe('console config', () => {
  it('requires a password of at least 16 characters', async () => {
    const { serverEnvSchema } = await import('../src/config')
    const base = {
      DATABASE_URL: 'postgres://x',
      RELAY_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
      PUBLIC_URL: 'http://localhost:3000',
      SLACK_SIGNING_SECRET: 's',
      SLACK_CLIENT_ID: 'c',
      SLACK_CLIENT_SECRET: 'c',
      SLACK_ALLOWED_USER_IDS: 'U1',
    }
    expect(serverEnvSchema.safeParse(base).success).toBe(false)
    expect(serverEnvSchema.safeParse({ ...base, CONSOLE_PASSWORD: 'short' }).success).toBe(false)
    expect(serverEnvSchema.safeParse({ ...base, CONSOLE_PASSWORD: 'x'.repeat(16) }).success).toBe(true)
  })
})
