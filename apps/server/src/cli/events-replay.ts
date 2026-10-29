import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { QUEUES, replayEvent, schema } from '@relay/core'
import { runCli, withQueue } from './util'

await runCli(async ({ db, config }) => {
  const id = z.uuid().parse(process.argv[2])
  const [row] = await db.select({ connectionId: schema.events.connectionId }).from(schema.events).where(eq(schema.events.id, id))
  if (!row) throw new Error(`no event ${id}`)
  return withQueue(config, QUEUES.route, async (queue) => {
    await replayEvent(db, queue, row.connectionId, id)
    console.log(`event ${id} queued for routing. Only new route matches create deliveries.`)
  })
})
