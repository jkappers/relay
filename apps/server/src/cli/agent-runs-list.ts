import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@relay/core'
import { parseArgs, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { status: { type: 'string' } } })
  const status = z.enum(['running', 'succeeded', 'failed']).optional().parse(values.status)
  const r = schema.agentRuns
  const rows = await (status ? db.select().from(r).where(eq(r.status, status)) : db.select().from(r))
    .orderBy(desc(r.startedAt))
    .limit(100)
  for (const x of rows) {
    console.log(
      JSON.stringify({
        id: x.id,
        deliveryId: x.deliveryId,
        status: x.status,
        attempts: x.attempts,
        turns: x.turns,
        inputTokens: x.inputTokens,
        outputTokens: x.outputTokens,
        costUsd: x.costUsd,
        mutated: x.mutated,
        error: x.error,
      }),
    )
  }
  if (rows.length === 0) console.log('no agent runs')
})
