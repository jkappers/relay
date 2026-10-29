import { scryptHasher } from '../accounts/password'
import { createUser } from '../accounts/users'
import { parseArgs, readPassword, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { email: { type: 'string' } } })
  const user = await createUser(db, scryptHasher, { email: values.email ?? '', password: await readPassword() })
  console.log(`user id: ${user.id}`)
  console.log(`email:   ${user.email}`)
})
