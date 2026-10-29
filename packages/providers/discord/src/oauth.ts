import { z } from 'zod'
import { DEFAULT_DISCORD_API_BASE_URL, DISCORD_USER_AGENT } from './runtime'

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'
export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'
export const DISCORD_SCOPES = ['bot', 'applications.commands', 'identify'] as const

// docs.discord.com/developers/topics/permissions: ADD_REACTIONS, VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY, SEND_MESSAGES_IN_THREADS.
export const DISCORD_BOT_PERMISSIONS = ((1n << 6n) | (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 38n)).toString()

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(DISCORD_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('scope', DISCORD_SCOPES.join(' '))
  url.searchParams.set('permissions', DISCORD_BOT_PERMISSIONS)
  url.searchParams.set('integration_type', '0')
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

  const apiBase = (input.apiBase ?? DEFAULT_DISCORD_API_BASE_URL).replace(/\/+$/, '')
  const me = await doFetch(`${apiBase}/users/@me`, {
    headers: { authorization: `Bearer ${token.data.access_token}`, 'user-agent': DISCORD_USER_AGENT },
  })
  if (!me.ok) throw new DiscordOAuthError(`users/@me HTTP ${me.status}`)
  const user = userSchema.safeParse(await me.json())
  if (!user.success) throw new DiscordOAuthError('users/@me returned an unexpected shape')

  return { guild: { id: token.data.guild.id, name: token.data.guild.name }, userId: user.data.id, username: user.data.username ?? null }
}
