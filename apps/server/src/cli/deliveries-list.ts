import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@relay/core'
import { parseArgs, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { status: { type: 'string' } } })
  const status = z.enum(['pending', 'succeeded', 'failed']).optional().parse(values.status)
  const d = schema.deliveries
  const rows = await (status ? db.select().from(d).where(eq(d.status, status)) : db.select().from(d))
    .orderBy(desc(d.createdAt))
    .limit(100)
  for (const r of rows) {
    console.log(
      JSON.stringify({
        id: r.id,
        eventId: r.eventId,
        routeId: r.routeId,
        destinationId: r.destinationId,
        status: r.status,
        attempts: r.attempts,
        lastStatusCode: r.lastStatusCode,
        lastError: r.lastError,
        nextAttemptAt: r.nextAttemptAt,
      }),
    )
  }
  if (rows.length === 0) console.log('no deliveries')
})
