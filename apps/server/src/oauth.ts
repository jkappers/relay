import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { ConnectionOwnedError, log, type Connection, type ConnectionStore, type ProviderId } from '@relay/core'
import * as discord from '@relay/provider-discord'
import * as slack from '@relay/provider-slack'
import type { ServerMetrics } from './metrics'
import { checkGuildGrant, checkState, createGuildGrant, createState, STATE_TTL_SECONDS, type GuildGrant, type StateStep } from './oauth-state'

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
  /** `guildId` preselects a server (Discord). */
  authorizeUrl(input: { redirectUri: string; state: string; guildId?: string }): string
  /** Exchanges the code and stores the connection. Throws OAuthRejection or ConnectionOwnedError. `guildId` is the server the signed state was minted for. */
  complete(input: { code: string; query: CallbackQuery; redirectUri: string; ownerUserId: string; guildId?: string }): Promise<Connection>
  /** The easy-connect steps (Discord only). */
  identify?: DiscordIdentify
}

export interface DiscordIdentify {
  authorizeUrl(input: { redirectUri: string; state: string }): string
  /** Exchanges an identify code and returns the Discord user and the servers they manage. Throws OAuthRejection. */
  complete(input: { code: string; redirectUri: string }): Promise<{ discordUserId: string; guilds: { id: string; name: string }[] }>
  /** Server ids the bot is in. */
  botGuildIds(): Promise<ReadonlySet<string>>
  /** Throws OAuthRejection if this Discord user may not connect. */
  assertAllowed(discordUserId: string): void
  connect(input: { ownerUserId: string; discordUserId: string; guild: { id: string; name: string } }): Promise<Connection>
}

export interface OAuthDeps {
  publicUrl: string
  stateKey: Buffer
  grantKey: Buffer
  metrics: ServerMetrics
  /** Resolves the console session. /start needs one; the callback does not (see below). */
  sessionUser: (c: Context) => Promise<string | null>
  nowSeconds?: () => number
}

/** The OAuth provider for this request: built from the app settings in force now, or why there is none. */
export type OAuthResolution = { kind: 'ready'; provider: OAuthProvider } | { kind: 'missing' } | { kind: 'invalid' }

export function oauthRoutes(id: 'slack' | 'discord', resolve: () => Promise<OAuthResolution>, deps: OAuthDeps) {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const cookieName = `relay_${id}_oauth`
  const cookiePath = `/oauth/${id}`
  const secure = deps.publicUrl.startsWith('https://')
  const outcome = (o: string) => deps.metrics.oauthCallbacks.inc({ provider: id, outcome: o })

  /** The console session (Strict cookie, so same-site calls only) plus the CSRF header, then the signed grant issued to that same user. */
  async function checkedGrant(c: Context, token: string): Promise<{ grant: GuildGrant } | { res: Response }> {
    if (c.req.header('x-relay-console') !== '1') return { res: c.json({ error: 'csrf', message: 'missing X-Relay-Console header' }, 403) }
    const userId = await deps.sessionUser(c)
    if (!userId) return { res: c.json({ error: 'unauthorized' }, 401) }
    const grant = checkGuildGrant(deps.grantKey, token, userId, nowSeconds())
    if (!grant) return { res: c.json({ error: 'grant_invalid', message: 'the Discord link expired; link Discord again' }, 410) }
    return { grant }
  }

  return new Hono<{ Variables: { provider: OAuthProvider } }>()
    .use('*', async (c, next) => {
      const resolved = await resolve()
      if (resolved.kind === 'missing') return c.notFound()
      if (resolved.kind === 'invalid') return c.text('this integration is not available: its app settings need attention', 503)
      c.set('provider', resolved.provider)
      await next()
    })
    .get('/start', async (c) => {
      const provider = c.var.provider
      const redirectUri = `${deps.publicUrl}/oauth/${id}/callback`
      const userId = await deps.sessionUser(c)
      if (!userId) return c.redirect('/#/login', 302)
      const stepParam = c.req.query('step')
      const guildParam = c.req.query('guild_id')
      if (stepParam !== undefined && (stepParam !== 'identify' || !provider.identify)) return c.text('unknown step', 400)
      if (guildParam !== undefined && (stepParam !== undefined || id !== 'discord' || !/^\d{1,20}$/.test(guildParam))) return c.text('invalid guild_id', 400)
      const step: StateStep = stepParam === 'identify' ? 'identify' : guildParam ? `install-${guildParam}` : 'install'
      const { state, nonce } = createState(deps.stateKey, userId, nowSeconds(), step)
      setCookie(c, cookieName, nonce, {
        path: cookiePath,
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        maxAge: STATE_TTL_SECONDS,
      })
      if (step === 'identify') return c.redirect(provider.identify!.authorizeUrl({ redirectUri, state }), 302)
      if (guildParam) deps.metrics.discordGuildPicks.inc({ kind: 'invite' })
      return c.redirect(provider.authorizeUrl({ redirectUri, state, ...(guildParam ? { guildId: guildParam } : {}) }), 302)
    })
    // The console session cookie is SameSite=Strict, so the browser drops it on the provider's cross-site redirect.
    // The signed state names the Relay user, and the Lax nonce cookie ties it to the browser that started.
    .get('/callback', zValidator('query', callbackQuery), async (c) => {
      const provider = c.var.provider
      const redirectUri = `${deps.publicUrl}/oauth/${id}/callback`
      const query = c.req.valid('query')
      const { code, state, error } = query
      const cookieNonce = getCookie(c, cookieName)
      deleteCookie(c, cookieName, { path: cookiePath, secure })

      const checked = state ? checkState(deps.stateKey, state, cookieNonce, nowSeconds()) : null
      if (!checked || (checked.step === 'identify' && !provider.identify)) {
        outcome('bad_state')
        return c.text('invalid or expired state', 400)
      }
      const { userId: ownerUserId, step } = checked

      if (step === 'identify') {
        if (error || !code) {
          deps.metrics.discordLinks.inc({ outcome: 'denied' })
          return c.text(`authorization not completed: ${error ?? 'missing code'}`, 400)
        }
        try {
          const linked = await provider.identify!.complete({ code, redirectUri })
          const grant = createGuildGrant(deps.grantKey, { userId: ownerUserId, discordUserId: linked.discordUserId, guilds: linked.guilds }, nowSeconds())
          deps.metrics.discordLinks.inc({ outcome: 'success' })
          return c.redirect(`/#/new/discord/servers/${grant}`, 302)
        } catch (err) {
          if (err instanceof OAuthRejection) {
            deps.metrics.discordLinks.inc({ outcome: err.outcome })
            log.warn('discord link: rejected', { outcome: err.outcome, relayUserId: ownerUserId })
            return c.text(err.message, err.status)
          }
          deps.metrics.discordLinks.inc({ outcome: 'exchange_failed' })
          log.error('discord link failed', { err: err instanceof Error ? err.message : String(err) })
          return c.text('could not complete Discord authorization', 502)
        }
      }

      if (error || !code) {
        outcome('denied')
        return c.text(`authorization not completed: ${error ?? 'missing code'}`, 400)
      }

      const guildId = step.startsWith('install-') ? step.slice('install-'.length) : undefined
      try {
        const connection = await provider.complete({ code, query, redirectUri, ownerUserId, ...(guildId ? { guildId } : {}) })
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
    .post('/guilds', zValidator('json', grantBody), async (c) => {
      const identify = c.var.provider.identify
      if (!identify) return c.notFound()
      const checked = await checkedGrant(c, c.req.valid('json').grant)
      if ('res' in checked) return checked.res
      let present: ReadonlySet<string> = new Set()
      try {
        present = await identify.botGuildIds()
      } catch (err) {
        log.warn('discord: could not list the bot servers', { err: err instanceof Error ? err.message : String(err) })
      }
      return c.json({ guilds: checked.grant.guilds.map((g) => ({ id: g.id, name: g.name, botPresent: present.has(g.id) })) })
    })
    .post('/connect', zValidator('json', grantBody.extend({ guildId: z.string().regex(/^\d{1,20}$/) })), async (c) => {
      const identify = c.var.provider.identify
      if (!identify) return c.notFound()
      const direct = (o: string) => deps.metrics.discordDirectConnects.inc({ outcome: o })
      const body = c.req.valid('json')
      const checked = await checkedGrant(c, body.grant)
      if ('res' in checked) {
        direct('bad_grant')
        return checked.res
      }
      const { grant } = checked
      const guild = grant.guilds.find((g) => g.id === body.guildId)
      if (!guild) {
        direct('not_in_grant')
        log.warn('discord direct connect: server not in the grant', { relayUserId: grant.userId, guildId: body.guildId })
        return c.json({ error: 'not_manageable', message: 'you do not manage that server' }, 403)
      }
      try {
        identify.assertAllowed(grant.discordUserId)
        const present = await identify.botGuildIds().catch(() => new Set<string>())
        if (!present.has(guild.id)) {
          direct('bot_absent')
          return c.json({ error: 'bot_absent', message: 'the bot is not in that server' }, 409)
        }
        const connection = await identify.connect({ ownerUserId: grant.userId, discordUserId: grant.discordUserId, guild })
        direct('success')
        deps.metrics.discordGuildPicks.inc({ kind: 'direct' })
        log.info('discord connection stored (direct)', { connectionId: connection.id, teamId: connection.teamId, userId: connection.userId })
        return c.json({ id: connection.id })
      } catch (err) {
        if (err instanceof OAuthRejection) {
          direct(err.outcome)
          return c.json({ error: err.outcome, message: err.message }, err.status)
        }
        if (err instanceof ConnectionOwnedError) {
          direct('owned_elsewhere')
          return c.json({ error: 'owned_elsewhere', message: c.var.provider.ownedMessage }, 409)
        }
        direct('error')
        log.error('discord direct connect failed', { err: err instanceof Error ? err.message : String(err) })
        return c.json({ error: 'internal', message: 'could not connect that server' }, 500)
      }
    })
}

const grantBody = z.object({ grant: z.string().min(1).max(60_000) })

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
  botToken?: () => Promise<string | undefined>
  apiBase?: string
  fetch?: typeof fetch
}): OAuthProvider {
  const apiOpts = { ...(deps.apiBase ? { apiBase: deps.apiBase } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) }
  const assertAllowed = (userId: string, guildId: string | null) => {
    if (deps.allowedUserIds.length > 0 && !deps.allowedUserIds.includes(userId)) {
      log.warn('discord oauth: user not allowed', { userId, guildId })
      throw new OAuthRejection('not_allowed', 403, 'this Discord user is not allowed to connect')
    }
  }
  const install = (input: { guild: { id: string; name: string }; userId: string; ownerUserId: string }) =>
    deps.connections.upsertInstall({
      provider: 'discord',
      identity: 'team',
      teamId: input.guild.id,
      userId: input.userId,
      name: `Discord ${input.guild.name}`,
      ownerUserId: input.ownerUserId,
    })

  return {
    id: 'discord',
    label: 'Discord',
    ownedMessage: 'This Discord server is already connected to another Relay account.',
    authorizeUrl: ({ redirectUri, state, guildId }) =>
      discord.buildAuthorizeUrl({ clientId: deps.clientId, redirectUri, state, ...(guildId ? { guildId } : {}) }),
    async complete({ code, query, redirectUri, ownerUserId, guildId }) {
      const grant = await discord.exchangeCode({ clientId: deps.clientId, clientSecret: deps.clientSecret, code, redirectUri, ...apiOpts })
      // The server comes from the token response. A different guild_id in the redirect, or in the signed state, means tampering or a mix-up.
      if ((query.guild_id !== undefined && query.guild_id !== grant.guild.id) || (guildId !== undefined && guildId !== grant.guild.id)) {
        log.warn('discord oauth: guild_id hint does not match the token response', { hint: query.guild_id, expected: guildId, guildId: grant.guild.id })
        throw new OAuthRejection('guild_mismatch', 400, 'the Discord server in the redirect does not match the authorization')
      }
      assertAllowed(grant.userId, grant.guild.id)
      return install({ guild: grant.guild, userId: grant.userId, ownerUserId })
    },
    identify: {
      authorizeUrl: ({ redirectUri, state }) => discord.buildIdentifyUrl({ clientId: deps.clientId, redirectUri, state }),
      async complete({ code, redirectUri }) {
        const linked = await discord.exchangeUserCode({ clientId: deps.clientId, clientSecret: deps.clientSecret, code, redirectUri, ...apiOpts })
        assertAllowed(linked.userId, null)
        return { discordUserId: linked.userId, guilds: linked.guilds }
      },
      async botGuildIds() {
        const token = await deps.botToken?.()
        if (!token) return new Set<string>()
        return discord.listBotGuildIds({ botToken: token, ...apiOpts })
      },
      assertAllowed: (userId) => assertAllowed(userId, null),
      connect: ({ ownerUserId, discordUserId, guild }) => install({ guild, userId: discordUserId, ownerUserId }),
    },
  }
}
