import { z } from 'zod'
import { coreEnvSchema, createCipher, createConnectionStore, createDb, loadConfig } from '@relay/core'

const config = loadConfig(coreEnvSchema.extend({ PUBLIC_URL: z.string().optional() }))
const cipher = await createCipher(config.RELAY_MASTER_KEY)
const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
try {
  const { connection, secret } = await createConnectionStore(db, cipher).createWebhook()
  console.log(`connection id: ${connection.id}`)
  console.log(`secret:        ${secret}`)
  if (config.PUBLIC_URL) console.log(`url:           ${config.PUBLIC_URL.replace(/\/+$/, '')}/hooks/webhook/${connection.id}`)
  console.log('The secret is shown once. Store it now.')
} finally {
  await close()
}
