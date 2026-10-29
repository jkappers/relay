import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { ConnectionOwnedError, log, type Connection, type ConnectionStore, type ProviderId } from '@relay/core'
import * as discord from '@relay/provider-discord'
import * as slack from '@relay/provider-slack'
import type { ServerMetrics } from './metrics'
import { checkState, createState, STATE_TTL_SECONDS } from './oauth-state'

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  // Discord adds these after a bot install. guild_id is only a hint and is checked against the token response.
  guild_id: z.string().optional(),
  permissions: z.string().optional(),
})
type CallbackQuery = z.output<typeof callbackQuery>

/** A refusal after a good exchange. Nothing is stored. */
export class OAuthRejection extends Error {
  override name = 'OAuthRejection'
  constructor(
    readonly outcome: string,
    readonly status: 400 | 403,
    message: string,
  ) {
    super(message)
  }
}

/** The provider-specific half of an OAuth install. State, cookies, metrics, and errors are shared. */
export interface OAuthProvider {
  id: ProviderId
  label: string
  /** Shown with HTTP 409 when another Relay account owns the identity. */
  ownedMessage: string
  authorizeUrl(input: { redirectUri: string; state: string }): string
  /** Exchanges the code and stores the connection. Throws OAuthRejection or ConnectionOwnedError. */
  complete(input: { code: string; query: CallbackQuery; redirectUri: string; ownerUserId: string }): Promise<Connection>
}

export interface OAuthDeps {
  publicUrl: string
  stateKey: Buffer
  metrics: ServerMetrics
  /** Resolves the console session. /start needs one; the callback does not (see below). */
  sessionUser: (c: Context) => Promise<string | null>
  nowSeconds?: () => number
}

export function oauthRoutes(provider: OAuthProvider, deps: OAuthDeps) {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const cookieName = `relay_${provider.id}_oauth`
  const cookiePath = `/oauth/${provider.id}`
  const redirectUri = `${deps.publicUrl}/oauth/${provider.id}/callback`
  const secure = deps.publicUrl.startsWith('https://')
  const outcome = (o: string) => deps.metrics.oauthCallbacks.inc({ provider: provider.id, outcome: o })

  return new Hono()
    .get('/start', async (c) => {
      const userId = await deps.sessionUser(c)
      if (!userId) return c.redirect('/#/login', 302)
      const { state, nonce } = createState(deps.stateKey, userId, nowSeconds())
      setCookie(c, cookieName, nonce, {
        path: cookiePath,
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        maxAge: STATE_TTL_SECONDS,
      })
      return c.redirect(provider.authorizeUrl({ redirectUri, state }), 302)
    })
    // The console session cookie is SameSite=Strict, so the browser drops it on the provider's cross-site redirect.
    // The signed state names the Relay user, and the Lax nonce cookie ties it to the browser that started.
    .get('/callback', zValidator('query', callbackQuery), async (c) => {
      const query = c.req.valid('query')
      const { code, state, error } = query
      const cookieNonce = getCookie(c, cookieName)
      deleteCookie(c, cookieName, { path: cookiePath, secure })

      const ownerUserId = state ? checkState(deps.stateKey, state, cookieNonce, nowSeconds()) : null
      if (!ownerUserId) {
        outcome('bad_state')
        return c.text('invalid or expired state', 400)
      }
      if (error || !code) {
        outcome('denied')
        return c.text(`authorization not completed: ${error ?? 'missing code'}`, 400)
      }

      try {
        const connection = await provider.complete({ code, query, redirectUri, ownerUserId })
        outcome('success')
        log.info(`${provider.id} connection stored`, { connectionId: connection.id, teamId: connection.teamId, userId: connection.userId })
        return c.redirect(`/#/c/${connection.id}/routes`, 302)
      } catch (err) {
        if (err instanceof OAuthRejection) {
          outcome(err.outcome)
          log.warn(`${provider.id} oauth: rejected`, { outcome: err.outcome, relayUserId: ownerUserId })
          return c.text(err.message, err.status)
        }
        if (err instanceof ConnectionOwnedError) {
          outcome('owned_elsewhere')
          log.warn(`${provider.id} oauth: identity owned by another account`, { relayUserId: ownerUserId })
          return c.text(provider.ownedMessage, 409)
        }
        outcome('exchange_failed')
        log.error(`${provider.id} oauth exchange failed`, { err: err instanceof Error ? err.message : String(err) })
        return c.text(`could not complete ${provider.label} authorization`, 502)
      }
    })
}

export function slackOAuthProvider(deps: {
  clientId: string
  clientSecret: string
  allowedUserIds: readonly string[]
  connections: ConnectionStore
  fetch?: typeof fetch
}): OAuthProvider {
  return {
    id: 'slack',
    label: 'Slack',
    ownedMessage: 'This Slack account is already connected to another Relay account.',
    authorizeUrl: ({ redirectUri, state }) => slack.buildAuthorizeUrl({ clientId: deps.clientId, redirectUri, state }),
    async complete({ code, redirectUri, ownerUserId }) {
      const grant = await slack.exchangeCode({
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        code,
        redirectUri,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
      if (deps.allowedUserIds.length > 0 && !deps.allowedUserIds.includes(grant.userId)) {
        log.warn('slack oauth: user not allowed', { userId: grant.userId, teamId: grant.teamId })
        throw new OAuthRejection('not_allowed', 403, 'this Slack user is not allowed to connect')
      }
      return deps.connections.upsertSlack({ teamId: grant.teamId, userId: grant.userId, accessToken: grant.accessToken, ownerUserId })
    },
  }
}

export function discordOAuthProvider(deps: {
  clientId: string
  clientSecret: string
  allowedUserIds: readonly string[]
  connections: ConnectionStore
  apiBase?: string
  fetch?: typeof fetch
}): OAuthProvider {
  return {
    id: 'discord',
    label: 'Discord',
    ownedMessage: 'This Discord server is already connected to another Relay account.',
    authorizeUrl: ({ redirectUri, state }) => discord.buildAuthorizeUrl({ clientId: deps.clientId, redirectUri, state }),
    async complete({ code, query, redirectUri, ownerUserId }) {
      const grant = await discord.exchangeCode({
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        code,
        redirectUri,
        ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
      // The server comes from the token response. A different guild_id in the redirect means tampering or a mix-up.
      if (query.guild_id !== undefined && query.guild_id !== grant.guild.id) {
        log.warn('discord oauth: guild_id hint does not match the token response', { hint: query.guild_id, guildId: grant.guild.id })
        throw new OAuthRejection('guild_mismatch', 400, 'the Discord server in the redirect does not match the authorization')
      }
      if (deps.allowedUserIds.length > 0 && !deps.allowedUserIds.includes(grant.userId)) {
        log.warn('discord oauth: user not allowed', { userId: grant.userId, guildId: grant.guild.id })
        throw new OAuthRejection('not_allowed', 403, 'this Discord user is not allowed to connect')
      }
      return deps.connections.upsertInstall({
        provider: 'discord',
        identity: 'team',
        teamId: grant.guild.id,
        userId: grant.userId,
        name: `Discord ${grant.guild.name}`,
        ownerUserId,
      })
    },
  }
}
