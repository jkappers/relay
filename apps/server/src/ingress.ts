import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import {
  InvalidPayloadError,
  log,
  SignatureError,
  UnknownConnectionError,
  type Db,
  type IngressInput,
  type ProviderAdapter,
  type Queue,
} from '@relay/core'
import { storeAndEnqueue } from './events'
import type { IngressOutcome, ServerMetrics } from './metrics'

export interface IngressDeps {
  db: Db
  queue: Queue
  metrics: ServerMetrics
}

export function ingressHandler(adapter: ProviderAdapter, deps: IngressDeps) {
  const provider = adapter.id

  return async (c: Context): Promise<Response> => {
    const finish = (outcome: IngressOutcome, res: Response) => {
      deps.metrics.ingressRequests.inc({ provider, outcome })
      return res
    }

    try {
      const rawBody = await c.req.text()
      const req = c.req.raw

      try {
        await adapter.verify(req, rawBody)
      } catch (err) {
        if (err instanceof SignatureError) return finish('bad_signature', c.text('invalid signature', 401))
        if (err instanceof UnknownConnectionError) return finish('unknown_connection', c.body(null, 200))
        throw err
      }

      let payload: unknown
      if (adapter.bodyFormat === 'form') {
        payload = Object.fromEntries(new URLSearchParams(rawBody))
      } else {
        try {
          payload = JSON.parse(rawBody)
        } catch {
          return finish('invalid_body', c.text('body must be JSON', 400))
        }
      }
      const ok = () => adapter.ack?.() ?? c.body(null, 200)
      const input: IngressInput = { req, rawBody, payload }

      const handshake = adapter.handshake?.(input)
      if (handshake) return finish('handshake', handshake)

      if (await adapter.lifecycle?.(input)) {
        if (provider === 'slack') deps.metrics.connectionsRevoked.inc({ provider })
        return finish('lifecycle', c.body(null, 200))
      }

      const connection = await adapter.resolveConnection(input)
      if (!connection || connection.status !== 'active') {
        log.warn('ingress: unknown or inactive connection', { provider, connectionId: connection?.id })
        return finish('unknown_connection', c.body(null, 200))
      }

      const resolved = { ...input, connection }
      const eventId = randomUUID()
      const receivedAt = new Date()
      const envelope = adapter.normalize({ ...resolved, eventId, receivedAt })

      const result = await storeAndEnqueue(deps.db, deps.queue, {
        id: eventId,
        provider,
        connectionId: connection.id,
        dedupKey: adapter.dedupKey(resolved),
        raw: payload,
        envelope,
        receivedAt,
      })

      if (result.status === 'duplicate') {
        if (result.requeued) deps.metrics.ingressRequeued.inc({ provider })
        if (provider === 'slack') c.header('X-Slack-No-Retry', '1')
        return finish('duplicate', ok())
      }
      return finish('accepted', ok())
    } catch (err) {
      if (err instanceof InvalidPayloadError) return finish('invalid_body', c.text(err.message, 400))
      log.error('ingress error', { provider, err: err instanceof Error ? err.stack : String(err) })
      return finish('error', c.text('internal error', 500))
    }
  }
}
