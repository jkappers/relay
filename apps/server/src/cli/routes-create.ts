import { createRoute, type CreateRouteInput } from '@relay/core'
import { parseArgs, requireConnection, runCli } from './util'

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
      selection: { type: 'string' },
      intent: { type: 'string' },
      fallback: { type: 'string' },
      'actor-in': { type: 'string', multiple: true },
    },
  })
  const actorIn = values['actor-in']?.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  if (values['actor-in'] && !actorIn?.length) throw new Error('--actor-in needs at least one actor id')
  const route = await createRoute(db, await requireConnection(db, values.connection), {
    name: values.name ?? '',
    eventType: values['event-type'] ?? '',
    destinationIds: values.destination ?? [],
    textContains: values.contains ?? null,
    textRegex: values.regex ?? null,
    includeSubtypes: values['include-subtypes'] ?? false,
    selection: values.selection as CreateRouteInput['selection'],
    intent: values.intent ?? null,
    classifierFallback: values.fallback as CreateRouteInput['classifierFallback'],
    actorIn: actorIn ?? null,
  })
  console.log(`route id: ${route.id}`)
})
