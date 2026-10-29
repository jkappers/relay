import { scryptHasher } from '../accounts/password'
import { createUser } from '../accounts/users'
import { parseArgs, readPassword, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { email: { type: 'string' }, admin: { type: 'boolean', default: false } } })
  const user = await createUser(db, scryptHasher, { email: values.email ?? '', password: await readPassword() }, { admin: values.admin })
  console.log(`user id: ${user.id}`)
  console.log(`email:   ${user.email}`)
  console.log(`admin:   ${user.isAdmin ? 'yes' : 'no'}`)
})
