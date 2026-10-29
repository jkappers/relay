import { and, eq, sql } from 'drizzle-orm'
import { QUEUES, schema, type Db, type Queue, type RouteJob, type Tx } from '@relay/core'

export interface NewEvent {
  id: string
  provider: string
  connectionId: string
  dedupKey: string
  raw: unknown
  envelope: unknown
  receivedAt: Date
}

export type StoreResult =
  | { status: 'accepted'; eventId: string }
  | { status: 'duplicate'; eventId: string; requeued: boolean }

async function enqueue(tx: Tx, queue: Queue, eventId: string) {
  await queue.send<RouteJob>(QUEUES.route, { eventId }, { tx, singletonKey: eventId })
  await tx.update(schema.events).set({ enqueuedAt: sql`now()` }).where(eq(schema.events.id, eventId))
}

export async function storeAndEnqueue(db: Db, queue: Queue, event: NewEvent): Promise<StoreResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.events)
      .values({ ...event, enqueuedAt: null })
      .onConflictDoNothing({ target: [schema.events.provider, schema.events.dedupKey] })
      .returning({ id: schema.events.id })

    if (inserted.length > 0) {
      await enqueue(tx, queue, event.id)
      return { status: 'accepted', eventId: event.id }
    }

    const [existing] = await tx
      .select({ id: schema.events.id, enqueuedAt: schema.events.enqueuedAt })
      .from(schema.events)
      .where(and(eq(schema.events.provider, event.provider), eq(schema.events.dedupKey, event.dedupKey)))
      .for('update')
    if (!existing) throw new Error('dedup conflict but no existing row')

    if (existing.enqueuedAt === null) {
      await enqueue(tx, queue, existing.id)
      return { status: 'duplicate', eventId: existing.id, requeued: true }
    }
    return { status: 'duplicate', eventId: existing.id, requeued: false }
  })
}
