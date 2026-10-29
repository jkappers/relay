import { z } from 'zod'
import { loadConfig } from '../config'
import { runMigrations } from './migrate'

const { DATABASE_URL } = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }))
await runMigrations(DATABASE_URL)
console.log('migrations applied')
