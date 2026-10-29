import { scryptHasher } from '../accounts/password'
import { setPassword } from '../accounts/users'
import { parseArgs, readPassword, runCli } from './util'

await runCli(async ({ db }) => {
  const { values } = parseArgs({ options: { email: { type: 'string' } } })
  const ended = await setPassword(db, scryptHasher, { email: values.email ?? '', password: await readPassword() })
  console.log(`password changed; ${ended} session(s) signed out`)
})
