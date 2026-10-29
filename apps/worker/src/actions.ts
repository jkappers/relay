import { eq } from 'drizzle-orm'
import {
  isTerminal,
  log,
  QUEUES,
  schema,
  syncResponseSchema,
  type ActionExecutor,
  type ActionsJob,
  type Db,
  type Queue,
} from '@relay/core'

export interface ActionsHandlerDeps {
  db: Db
  queue: Queue
  execute: ActionExecutor
}

export class ActionsPendingError extends Error {
  override name = 'ActionsPendingError'
}

export function createActionsHandler(deps: ActionsHandlerDeps) {
  const { db, queue } = deps

  const markDone = (deliveryId: string) =>
    db.update(schema.deliveries).set({ actionsDoneAt: new Date() }).where(eq(schema.deliveries.id, deliveryId))

  return async function handle(job: ActionsJob): Promise<void> {
    const [delivery] = await db.select().from(schema.deliveries).where(eq(schema.deliveries.id, job.deliveryId))
    if (!delivery || delivery.status !== 'succeeded' || delivery.actionsDoneAt) return

    const parsed = syncResponseSchema.safeParse(delivery.responseBody)
    if (!parsed.success || parsed.data.actions.length === 0) {
      await markDone(delivery.id)
      return
    }

    const results = await deps.execute(delivery.id, parsed.data.actions, 'sync')
    if (results.every(isTerminal)) {
      await markDone(delivery.id)
      return
    }

    const waits = results.map((r) => r.retryAfterSeconds ?? 0)
    const retryAfter = Math.max(0, ...waits)
    if (retryAfter > 0) {
      // Slack told us how long to wait; honor it instead of pg-boss's backoff.
      await queue.send<ActionsJob>(
        QUEUES.actions,
        { deliveryId: delivery.id },
        { singletonKey: delivery.id, startAfter: new Date(Date.now() + retryAfter * 1000) },
      )
      log.info('actions: rate limited, rescheduled', { deliveryId: delivery.id, retryAfter })
      return
    }
    throw new ActionsPendingError('some actions are not finished')
  }
}
