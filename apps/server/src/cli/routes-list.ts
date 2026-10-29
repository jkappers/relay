import { schema } from '@relay/core'
import { runCli } from './util'

await runCli(async ({ db }) => {
  const routes = await db.select().from(schema.routes).orderBy(schema.routes.createdAt)
  const links = await db.select().from(schema.routeDestinations)
  for (const r of routes) {
    const dests = links.filter((l) => l.routeId === r.id).map((l) => l.destinationId)
    console.log(
      JSON.stringify({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        connectionId: r.connectionId,
        eventType: r.eventType,
        textContains: r.textContains,
        textRegex: r.textRegex,
        includeSubtypes: r.includeSubtypes,
        destinations: dests,
      }),
    )
  }
  if (routes.length === 0) console.log('no routes')
})
