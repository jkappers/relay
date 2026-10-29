import { adoptOrphans } from '@relay/core'
import { parseArgs, requireConnection, runCli, userIdByEmail } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { email: { type: 'string' }, connection: { type: 'string' } } })
  const userId = await userIdByEmail(db, values.email)
  const connectionId = await requireConnection(db, values.connection)
  const result = await adoptOrphans(db, { userId, connectionId })
  console.log(`connections now owned by ${values.email}: ${result.connectionsAdopted.length}`)
  console.log(`routes moved to ${connectionId}: ${result.routesAssigned.length}`)
  console.log(`destinations moved to ${connectionId}: ${result.destinationsAssigned.length}`)
  if (result.mismatched.length === 0) {
    console.log('no route links cross connections')
    return
  }
  console.error(`${result.mismatched.length} route link(s) point at a destination in another connection. Fix them by hand, then run again:`)
  for (const m of result.mismatched) console.error(JSON.stringify(m))
  process.exitCode = 2
})
