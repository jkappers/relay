import { parseArgs } from 'node:util'
import { z } from 'zod'
import { loadConfig } from '../config'
import { runMigrations } from './migrate'

const { DATABASE_URL } = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }))
const { values } = parseArgs({ options: { to: { type: 'string' } } })
try {
  await runMigrations(DATABASE_URL, values.to ? { to: values.to } : {})
} catch (err) {
  const message = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}` : String(err)
  console.error(message)
  if (/connection_id.*contains null values/.test(message)) {
    console.error('Some routes or destinations have no connection. Run tenancy:adopt first. See README "Upgrade to accounts".')
  }
  process.exit(1)
}
console.log('migrations applied')
