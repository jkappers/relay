import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  log,
  schema,
  MAX_ACTIONS_PER_REQUEST,
  rawActionSchema,
  validateAction,
  verifyReplyToken,
  type ActionExecutor,
  type Db,
  type ProviderRuntime,
} from '@relay/core'
import { eq } from 'drizzle-orm'
import type { ServerMetrics } from './metrics'

export const MAX_ACTIONS_BODY_BYTES = 64 * 1024

export interface ActionsRouteDeps {
  db: Db
  replyKey: Buffer
  runtimes: Record<string, ProviderRuntime>
  execute: ActionExecutor
  metrics: ServerMetrics
  nowSeconds?: () => number
}

const bodySchema = z.object({ actions: z.array(rawActionSchema).min(1).max(MAX_ACTIONS_PER_REQUEST) })

export function actionsRoutes(deps: ActionsRouteDeps) {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const unauthorized = (c: { json: (b: unknown, s: 401) => Response }, reason: Parameters<ServerMetrics['replyTokensRejected']['inc']>[0]['reason']) => {
    deps.metrics.replyTokensRejected.inc({ reason })
    return c.json({ error: 'unauthorized' }, 401)
  }

  return new Hono().post(
    '/',
    bodyLimit({ maxSize: MAX_ACTIONS_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const match = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')
      if (!match) return unauthorized(c, 'malformed')
      const check = await verifyReplyToken(deps.db, deps.replyKey, match[1]!, nowSeconds())
      if (!check.ok) return unauthorized(c, check.reason)

      let json: unknown
      try {
        json = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_body' }, 400)
      }
      const body = bodySchema.safeParse(json)
      if (!body.success) return c.json({ error: 'invalid_body' }, 400)
      const { actions } = body.data

      const disallowed = actions.find((a) => !check.payload.allowed.includes(a.type))
      if (disallowed) {
        deps.metrics.replyTokensRejected.inc({ reason: 'action_not_allowed' })
        return c.json({ error: 'action_not_allowed', type: disallowed.type }, 403)
      }

      const [row] = await deps.db
        .select({ provider: schema.events.provider, envelope: schema.events.envelope })
        .from(schema.events)
        .where(eq(schema.events.id, check.delivery.eventId))
      const runtime = row ? deps.runtimes[row.provider] : undefined
      if (!row || !runtime) return unauthorized(c, 'unknown_delivery')

      for (const [i, a] of actions.entries()) {
        const v = validateAction(runtime, a, 'async', i)
        if (!v.ok) return c.json({ error: v.error, type: v.type, index: i }, 400)
      }

      const results = await deps.execute(check.delivery.id, actions, 'async')
      log.info('actions: executed', { deliveryId: check.delivery.id, jti: check.payload.jti, types: actions.map((a) => a.type) })
      const retryAfter = Math.max(0, ...results.map((r) => r.retryAfterSeconds ?? 0))
      return c.json({ results }, 200, retryAfter > 0 ? { 'retry-after': String(retryAfter) } : {})
    },
  )
}
