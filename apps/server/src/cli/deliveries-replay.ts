import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { QUEUES, replayDelivery, schema } from '@relay/core'
import { runCli, withQueue } from './util'

await runCli(async ({ db, config }) => {
  const id = z.uuid().parse(process.argv[2])
  const [row] = await db
    .select({ connectionId: schema.events.connectionId })
    .from(schema.deliveries)
    .innerJoin(schema.events, eq(schema.events.id, schema.deliveries.eventId))
    .where(eq(schema.deliveries.id, id))
  if (!row) throw new Error(`no delivery ${id}`)
  return withQueue(config, QUEUES.dispatch, async (queue) => {
    await replayDelivery(db, queue, row.connectionId, id)
    console.log(`delivery ${id} set to pending and queued`)
  })
})
