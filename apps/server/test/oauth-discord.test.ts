import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { schema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { signIn, useHarness, type Account } from './harness'

const h = useHarness()

const GUILD = '2909267986347357250'
const INSTALLER = '53908099506183680'
const tokenResponse = JSON.parse(
  readFileSync(new URL('../../../packages/providers/discord/test/fixtures/oauth_token_response.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function mockDiscord(opts: { token?: Record<string, unknown>; userId?: string } = {}) {
  h.fetch.mockImplementation(async (input) => {
    const url = String(input)
    if (url === 'https://discord.com/api/oauth2/token') return Response.json(opts.token ?? tokenResponse)
    if (url.endsWith('/users/@me')) return Response.json({ id: opts.userId ?? INSTALLER, username: 'Mason' })
    return new Response('unexpected', { status: 500 })
  })
}

async function start(account?: Account) {
  const me = account ?? (await signIn(h))
  const res = await h.app.request('/oauth/discord/start', { headers: { cookie: me.cookie } })
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!
  return { me, location, state: location.searchParams.get('state')!, cookie }
}

const callback = (query: string, cookie?: string) => h.app.request(`/oauth/discord/callback?${query}`, cookie ? { headers: { cookie } } : {})
const members = (connectionId: string) =>
  h.db.select().from(schema.connectionMembers).where(eq(schema.connectionMembers.connectionId, connectionId))
const outcome = (o: string) => h.metrics.oauthCallbacks.get({ provider: 'discord', outcome: o })

describe('Discord OAuth', () => {
  it('redirects to Discord for a bot install with the code grant', async () => {
    const { location, cookie } = await start()
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('client_id')).toBe('discord-client-id')
    expect(location.searchParams.get('scope')).toBe('bot applications.commands identify')
    expect(location.searchParams.get('permissions')).toBe('274877975616')
    expect(location.searchParams.get('redirect_uri')).toBe('http://relay.test/oauth/discord/callback')
    expect(cookie).toMatch(/^relay_discord_oauth=/)
  })

  it('creates the connection from the guild in the token response, owned by the user who started', async () => {
    mockDiscord()
    const { me, state, cookie } = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}&guild_id=${GUILD}&permissions=274877975616`, cookie)
    expect(res.status).toBe(302)

    const [url, init] = h.fetch.mock.calls[0]!
    expect(url).toBe('https://discord.com/api/oauth2/token')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('discord-client-id:discord-client-secret').toString('base64')}`)
    const body = new URLSearchParams(String(init?.body))
    expect([body.get('grant_type'), body.get('code'), body.get('redirect_uri')]).toEqual(['authorization_code', 'abc', 'http://relay.test/oauth/discord/callback'])
    const [meUrl, meInit] = h.fetch.mock.calls[1]!
    expect(String(meUrl)).toBe(`${h.discord.url}/users/@me`)
    expect(new Headers(meInit?.headers).get('authorization')).toBe('Bearer zMndOe7jFLXGawdlxMOdNvXjjOce5X')

    const [conn] = await h.connections.findActive('discord', { teamId: GUILD })
    expect(conn).toMatchObject({ provider: 'discord', teamId: GUILD, userId: INSTALLER, name: 'Discord SomeTest', status: 'active' })
    expect(res.headers.get('location')).toBe(`/#/c/${conn!.id}/routes`)
    expect((await members(conn!.id)).map((m) => m.userId)).toEqual([me.userId])
    expect(await h.db.select().from(schema.credentials)).toHaveLength(0)
    expect(outcome('success')).toBe(1)
  })

  it('rejects a guild_id hint that does not match the token response, and stores nothing', async () => {
    mockDiscord()
    const { state, cookie } = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}&guild_id=111111111111111111`, cookie)
    expect(res.status).toBe(400)
    expect(await h.db.select().from(schema.connections)).toHaveLength(0)
    expect(outcome('guild_mismatch')).toBe(1)
  })

  it('fails when the token response has no guild', async () => {
    const { guild: _guild, ...noGuild } = tokenResponse
    mockDiscord({ token: noGuild })
    const { state, cookie } = await start()
    expect((await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)).status).toBe(502)
    expect(await h.db.select().from(schema.connections)).toHaveLength(0)
    expect(outcome('exchange_failed')).toBe(1)
  })

  it('answers 409 when another Relay account owns the server, even for a different installer', async () => {
    const a = await signIn(h, 'a@example.com')
    const owned = await h.connections.upsertInstall({ provider: 'discord', identity: 'team', teamId: GUILD, userId: INSTALLER, name: 'Discord SomeTest', ownerUserId: a.userId })
    const b = await signIn(h, 'b@example.com')
    mockDiscord({ userId: '42' })
    const { state, cookie } = await start(b)
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('Discord server')
    expect(await h.connections.findById(owned.id)).toMatchObject({ userId: INSTALLER })
    expect((await members(owned.id)).map((m) => m.userId)).toEqual([a.userId])
    expect(await h.db.select().from(schema.connections)).toHaveLength(1)
    expect(outcome('owned_elsewhere')).toBe(1)
  })

  it('reactivates a revoked server on reinstall by its owner', async () => {
    const me = await signIn(h)
    const existing = await h.connections.upsertInstall({ provider: 'discord', identity: 'team', teamId: GUILD, userId: INSTALLER, name: 'Discord old', ownerUserId: me.userId })
    await h.connections.revoke('discord', GUILD)
    mockDiscord()
    const { state, cookie } = await start(me)
    expect((await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)).status).toBe(302)
    expect(await h.connections.findById(existing.id)).toMatchObject({ status: 'active', name: 'Discord SomeTest' })
    expect(await h.db.select().from(schema.connections)).toHaveLength(1)
  })

  it('rejects a bad state before calling Discord', async () => {
    const { state, cookie } = await start()
    const res = await callback(`code=abc&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`, cookie)
    expect(res.status).toBe(400)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(outcome('bad_state')).toBe(1)
  })

  it('lists which installs are enabled for the console', async () => {
    const me = await signIn(h)
    const res = await me.api('GET', '/api/connections/providers')
    expect(await res.json()).toEqual({ slack: 'http://relay.test/oauth/slack/start', discord: 'http://relay.test/oauth/discord/start' })
  })
})
