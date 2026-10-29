import { describe, expect, it, vi } from 'vitest'
import { buildAuthorizeUrl, buildIdentifyUrl, canManageGuild, DiscordOAuthError, exchangeUserCode, listBotGuildIds, listGuilds } from '../src'

const API = 'http://discord.test/api/v10'
const base = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://relay.test/oauth/discord/callback' }
const userToken = { token_type: 'Bearer', access_token: 'user-token', scope: 'identify guilds', expires_in: 604800 }

const ADMINISTRATOR = String(1n << 3n)
const MANAGE_GUILD = String(1n << 5n)
const SEND_MESSAGES = String(1n << 11n)

function g(id: number, permissions: string, owner = false) {
  return { id: String(id), name: `Server ${id}`, owner, permissions }
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>
function stubFetch(handler: Handler) {
  return vi.fn<typeof fetch>(async (input, init) => handler(new URL(String(input)), init))
}

describe('permission bits', () => {
  it.each([
    ['owner without bits', { owner: true, permissions: '0' }, true],
    ['MANAGE_GUILD', { owner: false, permissions: MANAGE_GUILD }, true],
    ['ADMINISTRATOR', { owner: false, permissions: ADMINISTRATOR }, true],
    ['MANAGE_GUILD among many bits, beyond 2^53', { owner: false, permissions: String((1n << 60n) | (1n << 5n)) }, true],
    ['only other bits', { owner: false, permissions: SEND_MESSAGES }, false],
    ['a high bit that is not manage', { owner: false, permissions: String(1n << 60n) }, false],
    ['no permissions', { owner: false, permissions: '0' }, false],
    ['a non-numeric string', { owner: false, permissions: 'abc' }, false],
  ])('%s', (_name, guild, expected) => {
    expect(canManageGuild(guild)).toBe(expected)
  })
})

describe('authorize URLs', () => {
  const input = { clientId: 'cid', redirectUri: base.redirectUri, state: 's' }

  it('the identify URL asks for identify and guilds only, with no bot and no permissions', () => {
    const url = new URL(buildIdentifyUrl(input))
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe('identify guilds')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('s')
    expect(url.searchParams.has('permissions')).toBe(false)
    expect(url.searchParams.has('guild_id')).toBe(false)
  })

  it('the bot URL preselects a server only when given one', () => {
    const plain = new URL(buildAuthorizeUrl(input))
    expect(plain.searchParams.has('guild_id')).toBe(false)
    expect(plain.searchParams.has('disable_guild_select')).toBe(false)
    const picked = new URL(buildAuthorizeUrl({ ...input, guildId: '2909267986347357250' }))
    expect(picked.searchParams.get('guild_id')).toBe('2909267986347357250')
    expect(picked.searchParams.get('disable_guild_select')).toBe('true')
    expect(picked.searchParams.get('scope')).toBe('bot applications.commands identify')
  })
})

describe('exchangeUserCode', () => {
  const route = (guilds: (url: URL) => Response): Handler => (url, init) => {
    if (url.href === 'https://discord.com/api/oauth2/token') return Response.json(userToken)
    if (url.pathname.endsWith('/users/@me')) return Response.json({ id: '53908099506183680', username: 'Mason' })
    if (url.pathname.endsWith('/users/@me/guilds')) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-token')
      return guilds(url)
    }
    return new Response('unexpected', { status: 500 })
  }

  it('keeps only servers the user owns or manages', async () => {
    const fetch = stubFetch(
      route(() => Response.json([g(1, SEND_MESSAGES), g(2, MANAGE_GUILD), g(3, '0', true), g(4, ADMINISTRATOR), g(5, '0')])),
    )
    const out = await exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch })
    expect(out).toEqual({
      userId: '53908099506183680',
      username: 'Mason',
      guilds: [
        { id: '2', name: 'Server 2' },
        { id: '3', name: 'Server 3' },
        { id: '4', name: 'Server 4' },
      ],
    })
  })

  it('follows pagination with limit 200 and after the last id', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => g(1000 + i, i === 199 ? MANAGE_GUILD : '0'))
    const page2 = [g(2000, ADMINISTRATOR)]
    const fetch = stubFetch(
      route((url) => {
        expect(url.searchParams.get('limit')).toBe('200')
        const after = url.searchParams.get('after')
        return Response.json(after === null ? page1 : after === '1199' ? page2 : [])
      }),
    )
    const out = await exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch })
    expect(out.guilds.map((x) => x.id)).toEqual(['1199', '2000'])
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('/users/@me/guilds'))).toHaveLength(2)
  })

  it('does not keep or return the user token', async () => {
    const fetch = stubFetch(route(() => Response.json([g(2, MANAGE_GUILD)])))
    expect(JSON.stringify(await exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch }))).not.toContain('user-token')
  })

  it('refuses a bot install code (token response has a server)', async () => {
    const fetch = stubFetch(() => Response.json({ ...userToken, scope: 'bot identify', guild: { id: '1', name: 'x' } }))
    await expect(exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch })).rejects.toThrow(DiscordOAuthError)
  })

  it('refuses a token without the guilds scope', async () => {
    const fetch = stubFetch(() => Response.json({ ...userToken, scope: 'identify' }))
    await expect(exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch })).rejects.toThrow(/guilds scope/)
  })

  it('fails when listing servers fails', async () => {
    const fetch = stubFetch(route(() => new Response('no', { status: 401 })))
    await expect(exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch })).rejects.toThrow(/guilds HTTP 401/)
  })

  it('skips malformed entries', async () => {
    const fetch = stubFetch(route(() => Response.json([{ id: 'nope', name: 'x', permissions: MANAGE_GUILD }, { name: 'y' }, g(2, MANAGE_GUILD)])))
    expect((await exchangeUserCode({ ...base, code: 'c', apiBase: API, fetch })).guilds.map((x) => x.id)).toEqual(['2'])
  })
})

describe('bot server list', () => {
  it('lists ids with the bot token', async () => {
    const fetch = stubFetch((url, init) => {
      expect(url.pathname).toBe('/api/v10/users/@me/guilds')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bot bt')
      return Response.json([g(1, '0'), g(2, '0')])
    })
    expect([...(await listBotGuildIds({ botToken: 'bt', apiBase: API, fetch }))]).toEqual(['1', '2'])
  })

  it('pages with a full page', async () => {
    const full = Array.from({ length: 200 }, (_, i) => g(100 + i, '0'))
    const fetch = stubFetch((url) => Response.json(url.searchParams.has('after') ? [g(9000, '0')] : full))
    const ids = await listBotGuildIds({ botToken: 'bt', apiBase: API, fetch })
    expect(ids.size).toBe(201)
    expect(ids.has('9000')).toBe(true)
  })

  it('throws on HTTP errors and network errors', async () => {
    await expect(listGuilds({ authorization: 'Bot x', apiBase: API, fetch: stubFetch(() => new Response('', { status: 500 })) })).rejects.toThrow(/HTTP 500/)
    await expect(listGuilds({ authorization: 'Bot x', apiBase: API, fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('down')) })).rejects.toThrow(/request failed/)
  })
})
