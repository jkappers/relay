import { z } from 'zod'
import { DEFAULT_DISCORD_API_BASE_URL, DISCORD_USER_AGENT, DiscordApiError, listGuilds } from './runtime'

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'
export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'
export const DISCORD_SCOPES = ['bot', 'applications.commands', 'identify'] as const

// docs.discord.com/developers/topics/permissions: ADD_REACTIONS, VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY, SEND_MESSAGES_IN_THREADS.
export const DISCORD_BOT_PERMISSIONS = ((1n << 6n) | (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 38n)).toString()

export const DISCORD_IDENTIFY_SCOPES = ['identify', 'guilds'] as const

const MANAGE_GUILD = 1n << 5n
const ADMINISTRATOR = 1n << 3n
const MAX_MANAGEABLE = 200
const MAX_NAME = 100

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; guildId?: string }): string {
  const url = new URL(DISCORD_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('scope', DISCORD_SCOPES.join(' '))
  url.searchParams.set('permissions', DISCORD_BOT_PERMISSIONS)
  url.searchParams.set('integration_type', '0')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  if (input.guildId) {
    url.searchParams.set('guild_id', input.guildId)
    url.searchParams.set('disable_guild_select', 'true')
  }
  return url.toString()
}

/** Step one of the easy connect: who is this, and which servers do they manage. No bot, no permissions. */
export function buildIdentifyUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(DISCORD_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('scope', DISCORD_IDENTIFY_SCOPES.join(' '))
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  return url.toString()
}

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string().optional(),
  guild: z.looseObject({ id: z.string().regex(/^\d{1,20}$/), name: z.string() }).optional(),
})

const userSchema = z.looseObject({ id: z.string().regex(/^\d{1,20}$/), username: z.string().optional() })

export class DiscordOAuthError extends Error {
  override name = 'DiscordOAuthError'
}

export interface DiscordBotGrant {
  guild: { id: string; name: string }
  /** The Discord user who installed the bot. */
  userId: string
  username: string | null
}

/** Exchanges the code. The server comes from the token response, never from the redirect's guild_id hint. */
export async function exchangeCode(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  apiBase?: string
  fetch?: typeof fetch
}): Promise<DiscordBotGrant> {
  const doFetch = input.fetch ?? fetch
  const res = await doFetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': DISCORD_USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri }).toString(),
  })
  if (!res.ok) throw new DiscordOAuthError(`token exchange HTTP ${res.status}`)
  const token = tokenResponseSchema.safeParse(await res.json())
  if (!token.success) throw new DiscordOAuthError('token exchange returned an unexpected shape')
  if (!token.data.guild) throw new DiscordOAuthError('token response has no guild; the bot was not added to a server')

  const user = await fetchUser(doFetch, input.apiBase, token.data.access_token)
  return { guild: { id: token.data.guild.id, name: token.data.guild.name }, userId: user.id, username: user.username }
}

async function fetchUser(doFetch: typeof fetch, apiBaseInput: string | undefined, accessToken: string): Promise<{ id: string; username: string | null }> {
  const apiBase = (apiBaseInput ?? DEFAULT_DISCORD_API_BASE_URL).replace(/\/+$/, '')
  const me = await doFetch(`${apiBase}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}`, 'user-agent': DISCORD_USER_AGENT },
  })
  if (!me.ok) throw new DiscordOAuthError(`users/@me HTTP ${me.status}`)
  const user = userSchema.safeParse(await me.json())
  if (!user.success) throw new DiscordOAuthError('users/@me returned an unexpected shape')
  return { id: user.data.id, username: user.data.username ?? null }
}

export interface DiscordUserGrant {
  userId: string
  username: string | null
  guilds: ManageableGuild[]
}

export interface ManageableGuild {
  id: string
  name: string
}

/** Owner, MANAGE_GUILD, or ADMINISTRATOR. `permissions` is a decimal string on the wire. */
export function canManageGuild(g: { owner: boolean; permissions: string }): boolean {
  if (g.owner) return true
  if (!/^\d{1,20}$/.test(g.permissions)) return false
  return (BigInt(g.permissions) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n
}

/**
 * Exchanges an identify-step code and lists the servers the user manages. The user token lives only in this call.
 * A token response that includes a server is a bot install code, which this step refuses.
 */
export async function exchangeUserCode(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  apiBase?: string
  fetch?: typeof fetch
}): Promise<DiscordUserGrant> {
  const doFetch = input.fetch ?? fetch
  const res = await doFetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': DISCORD_USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri }).toString(),
  })
  if (!res.ok) throw new DiscordOAuthError(`token exchange HTTP ${res.status}`)
  const token = tokenResponseSchema.safeParse(await res.json())
  if (!token.success) throw new DiscordOAuthError('token exchange returned an unexpected shape')
  if (token.data.guild) throw new DiscordOAuthError('token response has a server; this was a bot install code')
  if (!token.data.scope?.split(' ').includes('guilds')) throw new DiscordOAuthError('token response lacks the guilds scope')

  const user = await fetchUser(doFetch, input.apiBase, token.data.access_token)
  let guilds
  try {
    guilds = await listGuilds({ authorization: `Bearer ${token.data.access_token}`, apiBase: input.apiBase, fetch: doFetch })
  } catch (err) {
    throw new DiscordOAuthError(err instanceof DiscordApiError ? err.message : 'users/@me/guilds failed')
  }
  return {
    userId: user.id,
    username: user.username,
    guilds: guilds
      .filter(canManageGuild)
      .slice(0, MAX_MANAGEABLE)
      .map((g) => ({ id: g.id, name: g.name.slice(0, MAX_NAME) })),
  }
}
