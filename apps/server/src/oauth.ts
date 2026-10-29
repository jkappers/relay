import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { log, type ConnectionStore } from '@relay/core'
import { buildAuthorizeUrl, exchangeCode } from '@relay/provider-slack'
import type { ServerMetrics } from './metrics'
import { checkState, createState, STATE_TTL_SECONDS } from './oauth-state'

const STATE_COOKIE = 'relay_slack_oauth'
const COOKIE_PATH = '/oauth/slack'

export interface SlackOAuthDeps {
  clientId: string
  clientSecret: string
  allowedUserIds: readonly string[]
  publicUrl: string
  stateKey: Buffer
  connections: ConnectionStore
  metrics: ServerMetrics
  fetch?: typeof fetch
  nowSeconds?: () => number
}

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
})

export function slackOAuthRoutes(deps: SlackOAuthDeps) {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const redirectUri = `${deps.publicUrl}/oauth/slack/callback`
  const secure = deps.publicUrl.startsWith('https://')
  const outcome = (o: string) => deps.metrics.oauthCallbacks.inc({ provider: 'slack', outcome: o })

  return new Hono()
    .get('/start', (c) => {
      const { state, nonce } = createState(deps.stateKey, nowSeconds())
      setCookie(c, STATE_COOKIE, nonce, {
        path: COOKIE_PATH,
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        maxAge: STATE_TTL_SECONDS,
      })
      return c.redirect(buildAuthorizeUrl({ clientId: deps.clientId, redirectUri, state }), 302)
    })
    .get('/callback', zValidator('query', callbackQuery), async (c) => {
      const { code, state, error } = c.req.valid('query')
      const cookieNonce = getCookie(c, STATE_COOKIE)
      deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH, secure })

      if (!state || !checkState(deps.stateKey, state, cookieNonce, nowSeconds())) {
        outcome('bad_state')
        return c.text('invalid or expired state', 400)
      }
      if (error || !code) {
        outcome('denied')
        return c.text(`authorization not completed: ${error ?? 'missing code'}`, 400)
      }

      try {
        const grant = await exchangeCode({
          clientId: deps.clientId,
          clientSecret: deps.clientSecret,
          code,
          redirectUri,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        })
        if (!deps.allowedUserIds.includes(grant.userId)) {
          outcome('not_allowed')
          log.warn('slack oauth: user not allowed', { userId: grant.userId, teamId: grant.teamId })
          return c.text('this Slack user is not allowed to connect', 403)
        }
        const connection = await deps.connections.upsertSlack(grant)
        outcome('success')
        log.info('slack connection stored', { connectionId: connection.id, teamId: grant.teamId, userId: grant.userId })
        return c.text(`Connected Slack user ${grant.userId} in team ${grant.teamId}. Connection ${connection.id}.`)
      } catch (err) {
        outcome('exchange_failed')
        log.error('slack oauth exchange failed', { err: err instanceof Error ? err.message : String(err) })
        return c.text('could not complete Slack authorization', 502)
      }
    })
}
