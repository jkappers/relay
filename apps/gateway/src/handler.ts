import { randomUUID } from 'node:crypto'
import { log, storeAndEnqueue, type Db, type GatewayAdapter, type GatewayDispatch, type Queue } from '@relay/core'
import { readySchema } from '@relay/provider-discord'
import type { GatewayMetrics, MessageOutcome } from './metrics'

export interface DispatchHandlerDeps {
  db: Db
  queue: Queue
  adapter: GatewayAdapter
  metrics: GatewayMetrics
  /** Called with the bot's own user id from READY. */
  onReady: (botUserId: string) => void
}

/** Handles one Gateway dispatch. Never throws: the Gateway does not redeliver, so a failure is logged and counted. */
export function createDispatchHandler(deps: DispatchHandlerDeps) {
  const { adapter, metrics } = deps
  const count = (outcome: MessageOutcome, by = 1) => metrics.messages.inc({ outcome }, by)

  return async function handle(dispatch: GatewayDispatch): Promise<void> {
    metrics.dispatches.inc({ type: dispatch.t })
    try {
      if (dispatch.t === 'READY') {
        const ready = readySchema.safeParse(dispatch.d)
        if (ready.success) deps.onReady(ready.data.user.id)
        return
      }

      const lifecycle = await adapter.lifecycle?.(dispatch)
      if (lifecycle) {
        metrics.connectionsRevoked.inc({ provider: adapter.id })
        log.info('gateway: connection revoked', { provider: adapter.id, count: lifecycle.count })
        return
      }

      const resolution = await adapter.resolveConnections(dispatch)
      if (resolution.kind === 'ignore') {
        if (resolution.reason !== 'not_message') count(resolution.reason as MessageOutcome)
        return
      }
      if (resolution.connections.length === 0) {
        const reason = resolution.reason === 'dm_unrouted' ? 'dm_unrouted' : 'unknown_connection'
        if (reason === 'dm_unrouted') metrics.dmUnrouted.inc({})
        count(reason)
        return
      }

      for (const connection of resolution.connections) {
        const eventId = randomUUID()
        const receivedAt = new Date()
        const result = await storeAndEnqueue(deps.db, deps.queue, {
          id: eventId,
          provider: adapter.id,
          connectionId: connection.id,
          dedupKey: adapter.dedupKey(dispatch, connection),
          raw: dispatch.d,
          envelope: adapter.normalize({ dispatch, connection, eventId, receivedAt }),
          receivedAt,
        })
        count(result.status === 'accepted' ? 'accepted' : result.requeued ? 'requeued' : 'duplicate')
      }
    } catch (err) {
      if (dispatch.t === 'MESSAGE_CREATE') count('error')
      log.error('gateway: dispatch failed', { type: dispatch.t, err: err instanceof Error ? err.stack : String(err) })
    }
  }
}
