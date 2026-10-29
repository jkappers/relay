import { setAdmin } from '../accounts/users'
import { parseArgs, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { email: { type: 'string' }, revoke: { type: 'boolean', default: false } } })
  if (!values.email) throw new Error('--email is required')
  const user = await setAdmin(db, values.email, !values.revoke)
  console.log(`${user.email} is ${user.isAdmin ? 'now an instance admin' : 'no longer an instance admin'}`)
})
