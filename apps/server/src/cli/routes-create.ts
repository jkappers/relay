import { createRoute } from '@relay/core'
import { parseArgs, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      'event-type': { type: 'string' },
      destination: { type: 'string', multiple: true },
      connection: { type: 'string' },
      contains: { type: 'string' },
      regex: { type: 'string' },
      'include-subtypes': { type: 'boolean', default: false },
    },
  })
  const route = await createRoute(db, {
    name: values.name ?? '',
    eventType: values['event-type'] ?? '',
    destinationIds: values.destination ?? [],
    connectionId: values.connection ?? null,
    textContains: values.contains ?? null,
    textRegex: values.regex ?? null,
    includeSubtypes: values['include-subtypes'] ?? false,
  })
  console.log(`route id: ${route.id}`)
})
