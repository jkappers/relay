import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { schema } from '@relay/core'
import { TEST_MASTER_KEY } from '@relay/core/testing'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { checkGuildGrant, checkState, createGuildGrant, createState, deriveGrantKey, deriveStateKey } from '../src/oauth-state'
import { CSRF, PUBLIC_URL, signIn, useHarness, type Account } from './harness'

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

describe('Discord easy connect', () => {
  const MANAGE = String(1n << 5n)
  const OWNED_GUILD = '700000000000000001'
  const MANAGED_GUILD = '700000000000000002'
  const OTHER_GUILD = '700000000000000003'
  const BOT_ONLY_GUILD = '700000000000000004'
  const userGuilds = [
    { id: OWNED_GUILD, name: 'Mine', owner: true, permissions: '0' },
    { id: MANAGED_GUILD, name: 'Managed', owner: false, permissions: MANAGE },
    { id: OTHER_GUILD, name: 'Member only', owner: false, permissions: String(1n << 11n) },
  ]
  const userToken = { token_type: 'Bearer', access_token: 'user-token', scope: 'identify guilds', expires_in: 604800 }

  function mockEasy(opts: { userId?: string; botGuilds?: string[]; token?: Record<string, unknown> } = {}) {
    h.fetch.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.com/api/oauth2/token') return Response.json(opts.token ?? userToken)
      if (url.endsWith('/users/@me')) return Response.json({ id: opts.userId ?? INSTALLER, username: 'Mason' })
      if (url.includes('/users/@me/guilds')) {
        const auth = new Headers(init?.headers).get('authorization')
        if (auth === 'Bearer user-token') return Response.json(userGuilds)
        if (auth === 'Bot discord-bot-token') return Response.json((opts.botGuilds ?? [MANAGED_GUILD, BOT_ONLY_GUILD, OTHER_GUILD]).map((id) => ({ id, name: `bot ${id}` })))
      }
      return new Response('unexpected', { status: 500 })
    })
  }

  async function startStep(account: Account, query = 'step=identify') {
    const res = await h.app.request(`/oauth/discord/start?${query}`, { headers: { cookie: account.cookie } })
    const location = res.headers.get('location') ? new URL(res.headers.get('location')!, 'http://x') : null
    return { res, location, state: location?.searchParams.get('state') ?? '', cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }

  /** Runs step one and returns the grant from the redirect. */
  async function link(account: Account) {
    mockEasy()
    const { state, cookie } = await startStep(account)
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
    expect(res.status).toBe(302)
    const grant = res.headers.get('location')!.replace('/#/new/discord/servers/', '')
    return { res, grant }
  }

  const post = (account: Account, path: string, body: unknown, headers: Record<string, string> = CSRF) =>
    h.app.request(`/oauth/discord${path}`, {
      method: 'POST',
      headers: { cookie: account.cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const link_ = (o: string) => h.metrics.discordLinks.get({ outcome: o })
  const direct = (o: string) => h.metrics.discordDirectConnects.get({ outcome: o })

  describe('step one: identify', () => {
    it('sends the user to Discord for identify and guilds only', async () => {
      const me = await signIn(h)
      const { location, cookie } = await startStep(me)
      expect(location!.origin + location!.pathname).toBe('https://discord.com/oauth2/authorize')
      expect(location!.searchParams.get('scope')).toBe('identify guilds')
      expect(location!.searchParams.has('permissions')).toBe(false)
      expect(location!.searchParams.get('redirect_uri')).toBe('http://relay.test/oauth/discord/callback')
      expect(cookie).toMatch(/^relay_discord_oauth=/)
    })

    it('needs a console session', async () => {
      const res = await h.app.request('/oauth/discord/start?step=identify')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/#/login')
    })

    it('lists only manageable servers in a grant, stores nothing, and keeps no user token', async () => {
      const me = await signIn(h)
      const { res, grant } = await link(me)
      expect(res.headers.get('location')).toMatch(/^\/#\/new\/discord\/servers\/[\w.-]+$/)
      const key = deriveGrantKey(TEST_MASTER_KEY)
      expect(checkGuildGrant(key, grant, me.userId, Math.floor(Date.now() / 1000))).toEqual({
        userId: me.userId,
        discordUserId: INSTALLER,
        guilds: [
          { id: OWNED_GUILD, name: 'Mine' },
          { id: MANAGED_GUILD, name: 'Managed' },
        ],
      })
      expect(grant).not.toContain('user-token')
      expect(Buffer.from(grant.split('.')[0]!, 'base64url').toString()).not.toContain('user-token')
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(await h.db.select().from(schema.credentials)).toHaveLength(0)
      expect(link_('success')).toBe(1)
      const guildCall = h.fetch.mock.calls.find(([u]) => String(u).includes('/users/@me/guilds'))!
      expect(new Headers(guildCall[1]?.headers).get('authorization')).toBe('Bearer user-token')
    })

    it('refuses a Discord user who is not on the allow-list, before listing servers', async () => {
      const app = appWith({ DISCORD_ALLOWED_USER_IDS: ['999'] })
      const me = await signIn(h)
      mockEasy()
      const start = await app.request('/oauth/discord/start?step=identify', { headers: { cookie: me.cookie } })
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!
      const res = await app.request(`/oauth/discord/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } })
      expect(res.status).toBe(403)
      expect(link_('not_allowed')).toBe(1)
    })

    it('counts a denied authorization', async () => {
      const me = await signIn(h)
      const { state, cookie } = await startStep(me)
      expect((await callback(`error=access_denied&state=${encodeURIComponent(state)}`, cookie)).status).toBe(400)
      expect(link_('denied')).toBe(1)
    })

    it('rejects an unknown step, and a step combined with guild_id', async () => {
      const me = await signIn(h)
      expect((await startStep(me, 'step=bogus')).res.status).toBe(400)
      expect((await startStep(me, `step=identify&guild_id=${OTHER_GUILD}`)).res.status).toBe(400)
    })
  })

  describe('state is bound to its step', () => {
    it('does not let an identify state complete a bot install, even with a bot code', async () => {
      const me = await signIn(h)
      mockDiscord()
      const { state, cookie } = await startStep(me)
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}&guild_id=${GUILD}`, cookie)
      expect(res.status).toBe(502)
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(link_('exchange_failed')).toBe(1)
    })

    it('does not let a bot-install state complete the identify step', async () => {
      const me = await signIn(h)
      mockEasy()
      const { state, cookie } = await start(me)
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
      expect(res.status).toBe(502)
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(outcome('exchange_failed')).toBe(1)
      expect(link_('success')).toBe(0)
    })

    it('rejects a state whose step was edited', async () => {
      const me = await signIn(h)
      mockDiscord()
      const { state, cookie } = await startStep(me)
      const edited = state.replace(/\.identify\./, '.install.')
      expect(edited).not.toBe(state)
      const res = await callback(`code=abc&state=${encodeURIComponent(edited)}`, cookie)
      expect(res.status).toBe(400)
      expect(outcome('bad_state')).toBe(1)
      expect(h.fetch).not.toHaveBeenCalled()
    })

    it('checkState reports the step and rejects a wrong nonce', () => {
      const key = deriveStateKey(TEST_MASTER_KEY)
      const uid = '3b241101-e2bb-4255-8caf-4136c566a962'
      const a = createState(key, uid, 1000, 'identify')
      expect(checkState(key, a.state, a.nonce, 1000)).toEqual({ userId: uid, step: 'identify' })
      expect(checkState(key, createState(key, uid, 1000).state, undefined, 1000)).toBeNull()
      expect(checkState(key, a.state, 'other', 1000)).toBeNull()
      expect(checkState(key, a.state, a.nonce, 5000)).toBeNull()
      const b = createState(key, uid, 1000, `install-${GUILD}`)
      expect(checkState(key, b.state, b.nonce, 1000)?.step).toBe(`install-${GUILD}`)
    })
  })

  describe('step two: pick a server', () => {
    it('marks the servers the bot is in', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      const res = await post(me, '/guilds', { grant })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        guilds: [
          { id: OWNED_GUILD, name: 'Mine', botPresent: false },
          { id: MANAGED_GUILD, name: 'Managed', botPresent: true },
        ],
      })
      const botCall = h.fetch.mock.calls.filter(([u]) => String(u).includes('/users/@me/guilds')).at(-1)!
      expect(new Headers(botCall[1]?.headers).get('authorization')).toBe('Bot discord-bot-token')
    })

    it('still lists servers when the bot list fails', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      h.fetch.mockResolvedValue(new Response('no', { status: 500 }))
      const res = await post(me, '/guilds', { grant })
      expect((await res.json()) as { guilds: { botPresent: boolean }[] }).toMatchObject({ guilds: [{ botPresent: false }, { botPresent: false }] })
    })

    it('connects a server the bot is in, with no Discord authorization round trip', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      h.fetch.mockClear()
      mockEasy()
      const res = await post(me, '/connect', { grant, guildId: MANAGED_GUILD })
      expect(res.status).toBe(200)
      const { id } = (await res.json()) as { id: string }
      const conn = await h.connections.findById(id)
      expect(conn).toMatchObject({ provider: 'discord', teamId: MANAGED_GUILD, userId: INSTALLER, name: 'Discord Managed', status: 'active' })
      expect((await members(id)).map((m) => m.userId)).toEqual([me.userId])
      expect(h.fetch.mock.calls.some(([u]) => String(u).includes('oauth2/token'))).toBe(false)
      expect(direct('success')).toBe(1)
      expect(h.metrics.discordGuildPicks.get({ kind: 'direct' })).toBe(1)
    })

    it('refuses a server the user does not manage, even if the bot is there', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      mockEasy()
      for (const guildId of [OTHER_GUILD, BOT_ONLY_GUILD, GUILD]) {
        expect((await post(me, '/connect', { grant, guildId })).status).toBe(403)
      }
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(direct('not_in_grant')).toBe(3)
    })

    it('refuses a managed server where the bot is not', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      mockEasy()
      const res = await post(me, '/connect', { grant, guildId: OWNED_GUILD })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'bot_absent' })
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(direct('bot_absent')).toBe(1)
    })

    it('answers 409 when another account owns the server', async () => {
      const a = await signIn(h, 'a@example.com')
      await h.connections.upsertInstall({ provider: 'discord', identity: 'team', teamId: MANAGED_GUILD, userId: '42', name: 'Discord Managed', ownerUserId: a.userId })
      const b = await signIn(h, 'b@example.com')
      const { grant } = await link(b)
      mockEasy()
      const res = await post(b, '/connect', { grant, guildId: MANAGED_GUILD })
      expect(res.status).toBe(409)
      expect(await res.text()).toContain('already connected')
      expect(await h.db.select().from(schema.connections)).toHaveLength(1)
      expect(direct('owned_elsewhere')).toBe(1)
    })

    it('re-checks the allow-list on a direct connect', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      const app = appWith({ DISCORD_ALLOWED_USER_IDS: ['999'] })
      mockEasy()
      const res = await app.request('/oauth/discord/connect', {
        method: 'POST',
        headers: { cookie: me.cookie, 'content-type': 'application/json', ...CSRF },
        body: JSON.stringify({ grant, guildId: MANAGED_GUILD }),
      })
      expect(res.status).toBe(403)
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(direct('not_allowed')).toBe(1)
    })

    it('does not honor a grant issued to another Relay user, a forged one, or a tampered one', async () => {
      const a = await signIn(h, 'a@example.com')
      const b = await signIn(h, 'b@example.com')
      const { grant } = await link(a)
      mockEasy()
      expect((await post(b, '/connect', { grant, guildId: MANAGED_GUILD })).status).toBe(410)
      expect((await post(b, '/guilds', { grant })).status).toBe(410)

      const forgedKey = Buffer.alloc(32, 1)
      const forged = createGuildGrant(forgedKey, { userId: a.userId, discordUserId: INSTALLER, guilds: [{ id: BOT_ONLY_GUILD, name: 'x' }] }, Math.floor(Date.now() / 1000))
      expect((await post(a, '/connect', { grant: forged, guildId: BOT_ONLY_GUILD })).status).toBe(410)

      const [body, mac] = grant.split('.') as [string, string]
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { g: string[][] }
      payload.g.push([BOT_ONLY_GUILD, 'x'])
      const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`
      expect((await post(a, '/connect', { grant: tampered, guildId: BOT_ONLY_GUILD })).status).toBe(410)
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(direct('bad_grant')).toBe(3)
    })

    it('expires a grant', () => {
      const key = deriveGrantKey(TEST_MASTER_KEY)
      const uid = '3b241101-e2bb-4255-8caf-4136c566a962'
      const token = createGuildGrant(key, { userId: uid, discordUserId: INSTALLER, guilds: [{ id: '1', name: 'x' }] }, 1000)
      expect(checkGuildGrant(key, token, uid, 1000 + 899)).not.toBeNull()
      expect(checkGuildGrant(key, token, uid, 1000 + 901)).toBeNull()
    })

    it('needs a session and the console header', async () => {
      const me = await signIn(h)
      const { grant } = await link(me)
      const noSession = await h.app.request('/oauth/discord/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CSRF },
        body: JSON.stringify({ grant, guildId: MANAGED_GUILD }),
      })
      expect(noSession.status).toBe(401)
      expect((await post(me, '/connect', { grant, guildId: MANAGED_GUILD }, {})).status).toBe(403)
      expect((await post(me, '/guilds', { grant }, {})).status).toBe(403)
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
    })
  })

  describe('invite a chosen server', () => {
    it('preselects the server and skips Discord\'s picker', async () => {
      const me = await signIn(h)
      const { location } = await startStep(me, `guild_id=${OWNED_GUILD}`)
      expect(location!.searchParams.get('guild_id')).toBe(OWNED_GUILD)
      expect(location!.searchParams.get('disable_guild_select')).toBe('true')
      expect(location!.searchParams.get('scope')).toBe('bot applications.commands identify')
      expect(h.metrics.discordGuildPicks.get({ kind: 'invite' })).toBe(1)
    })

    it('rejects a malformed guild_id', async () => {
      const me = await signIn(h)
      expect((await startStep(me, 'guild_id=abc')).res.status).toBe(400)
    })

    it('connects when the token response matches the chosen server', async () => {
      const me = await signIn(h)
      mockDiscord()
      const { state, cookie } = await startStep(me, `guild_id=${GUILD}`)
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}&guild_id=${GUILD}`, cookie)
      expect(res.status).toBe(302)
      expect(await h.connections.findActive('discord', { teamId: GUILD })).toHaveLength(1)
    })

    it('rejects a different server in the token response even when the redirect has no guild_id', async () => {
      const me = await signIn(h)
      mockDiscord()
      const { state, cookie } = await startStep(me, `guild_id=${OWNED_GUILD}`)
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie)
      expect(res.status).toBe(400)
      expect(await h.db.select().from(schema.connections)).toHaveLength(0)
      expect(outcome('guild_mismatch')).toBe(1)
    })

    it('rejects a mismatched guild_id hint', async () => {
      const me = await signIn(h)
      mockDiscord()
      const { state, cookie } = await startStep(me, `guild_id=${GUILD}`)
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}&guild_id=${OWNED_GUILD}`, cookie)
      expect(res.status).toBe(400)
      expect(outcome('guild_mismatch')).toBe(1)
    })

    it('keeps the allow-list and the one-owner rule', async () => {
      const a = await signIn(h, 'a@example.com')
      await h.connections.upsertInstall({ provider: 'discord', identity: 'team', teamId: GUILD, userId: '42', name: 'Discord SomeTest', ownerUserId: a.userId })
      const b = await signIn(h, 'b@example.com')
      mockDiscord()
      const { state, cookie } = await startStep(b, `guild_id=${GUILD}`)
      expect((await callback(`code=abc&state=${encodeURIComponent(state)}&guild_id=${GUILD}`, cookie)).status).toBe(409)

      const app = appWith({ DISCORD_ALLOWED_USER_IDS: ['999'] })
      const c = await signIn(h, 'c@example.com')
      const s = await app.request(`/oauth/discord/start?guild_id=${GUILD}`, { headers: { cookie: c.cookie } })
      const st = new URL(s.headers.get('location')!).searchParams.get('state')!
      const ck = s.headers.get('set-cookie')!.split(';')[0]!
      const denied = await app.request(`/oauth/discord/callback?code=abc&state=${encodeURIComponent(st)}&guild_id=${GUILD}`, { headers: { cookie: ck } })
      expect(denied.status).toBe(403)
      expect(outcome('not_allowed')).toBe(1)
    })
  })

  function appWith(config: Record<string, unknown>) {
    return createApp({
      config: {
        PUBLIC_URL,
        RELAY_MASTER_KEY: TEST_MASTER_KEY,
        SIGNUP_MODE: 'closed',
        SLACK_ALLOWED_USER_IDS: [],
        DISCORD_CLIENT_ID: 'discord-client-id',
        DISCORD_CLIENT_SECRET: 'discord-client-secret',
        DISCORD_BOT_TOKEN: 'discord-bot-token',
        DISCORD_API_BASE_URL: h.discord.url,
        DISCORD_ALLOWED_USER_IDS: [],
        ...config,
      },
      db: h.db,
      queue: h.queue,
      connections: h.connections,
      cipher: h.cipher,
      consoleDistDir: h.distDir,
      metrics: h.metrics,
      fetch: h.fetch,
    })
  }
})
