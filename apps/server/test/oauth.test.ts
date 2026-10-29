import { schema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { login, useHarness } from './harness'

const h = useHarness()

const slackOk = {
  ok: true,
  app_id: 'A0118NQPZZC',
  authed_user: { id: 'U065VRX1T0', scope: 'chat:write,im:history', access_token: 'xoxp-test-token', token_type: 'user' },
  team: { id: 'T024BE7LD' },
  enterprise: null,
  is_enterprise_install: false,
}

async function start() {
  const session = (await login(h.app)).cookie
  const res = await h.app.request('/oauth/slack/start', { headers: { cookie: session } })
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!
  return { location, state: location.searchParams.get('state')!, cookie }
}

const callback = (query: string, cookie?: string) =>
  h.app.request(`/oauth/slack/callback?${query}`, cookie ? { headers: { cookie } } : {})

describe('Slack OAuth', () => {
  it('redirects to Slack with user scopes only', async () => {
    const { location } = await start()
    expect(location.origin + location.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(location.searchParams.get('user_scope')).toBe(
      'chat:write,im:history,channels:history,groups:history,reactions:write,users:read',
    )
    expect(location.searchParams.has('scope')).toBe(false)
    expect(location.searchParams.get('redirect_uri')).toBe('http://relay.test/oauth/slack/callback')
  })

  it('stores an encrypted token for a valid state', async () => {
    h.fetch.mockResolvedValue(Response.json(slackOk))
    const { state, cookie } = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
    expect(res.status).toBe(200)

    const [url, init] = h.fetch.mock.calls[0]!
    expect(url).toBe('https://slack.com/api/oauth.v2.access')
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    )
    expect(new URLSearchParams(String(init?.body)).get('code')).toBe('abc')

    const conn = await h.connections.findSlack('T024BE7LD', 'U065VRX1T0')
    expect(conn?.status).toBe('active')
    const [cred] = await h.db.select().from(schema.credentials)
    expect(cred?.ciphertext).not.toContain('xoxp')
    expect(await h.connections.getCredentials(conn!.id)).toEqual({ slack_user_token: 'xoxp-test-token' })
    expect(h.metrics.oauthCallbacks.get({ provider: 'slack', outcome: 'success' })).toBe(1)
  })

  it('reactivates a revoked connection on reinstall', async () => {
    const existing = await h.connections.upsertSlack({ teamId: 'T024BE7LD', userId: 'U065VRX1T0', accessToken: 'old' })
    await h.connections.revokeSlack('T024BE7LD', ['U065VRX1T0'])
    h.fetch.mockResolvedValue(Response.json(slackOk))
    const { state, cookie } = await start()
    await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
    const conn = await h.connections.findById(existing.id)
    expect(conn?.status).toBe('active')
    expect(await h.connections.getCredentials(existing.id)).toEqual({ slack_user_token: 'xoxp-test-token' })
  })

  it.each([
    ['tampered state', (s: string) => s.slice(0, -2) + 'xx', true],
    ['missing cookie', (s: string) => s, false],
    ['garbage state', () => 'abc', true],
  ])('rejects a %s', async (_, mutate, withCookie) => {
    const { state, cookie } = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(mutate(state))}`, withCookie ? cookie : undefined)
    expect(res.status).toBe(400)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(await h.db.select().from(schema.connections)).toHaveLength(0)
    expect(h.metrics.oauthCallbacks.get({ provider: 'slack', outcome: 'bad_state' })).toBe(1)
  })

  it('rejects a state bound to another browser', async () => {
    const a = await start()
    const b = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(a.state)}`, b.cookie)
    expect(res.status).toBe(400)
  })

  it('rejects a user outside the allowlist and stores nothing', async () => {
    h.fetch.mockResolvedValue(Response.json({ ...slackOk, authed_user: { ...slackOk.authed_user, id: 'U999OTHER' } }))
    const { state, cookie } = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
    expect(res.status).toBe(403)
    expect(await h.db.select().from(schema.connections)).toHaveLength(0)
    expect(await h.db.select().from(schema.credentials)).toHaveLength(0)
    expect(h.metrics.oauthCallbacks.get({ provider: 'slack', outcome: 'not_allowed' })).toBe(1)
    expect(h.metrics.oauthCallbacks.get({ provider: 'slack', outcome: 'success' })).toBe(0)
  })

  it('reports a failed code exchange', async () => {
    h.fetch.mockResolvedValue(Response.json({ ok: false, error: 'invalid_code' }))
    const { state, cookie } = await start()
    const res = await callback(`code=bad&state=${encodeURIComponent(state)}`, cookie)
    expect(res.status).toBe(502)
    expect(await h.db.select().from(schema.connections)).toHaveLength(0)
  })
})
