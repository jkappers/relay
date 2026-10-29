import { z } from 'zod'
import { createConnectionStore } from '@relay/core'
import { createCipher, parseArgs, runCli, userIdByEmail } from './util'

await runCli(async ({ db, config }) => {
  const { values } = parseArgs({ options: { owner: { type: 'string' }, name: { type: 'string' } } })
  const ownerUserId = await userIdByEmail(db, values.owner)
  const name = z.string().trim().min(1).max(100).optional().parse(values.name)
  const cipher = await createCipher(config.RELAY_MASTER_KEY)
  const { connection, secret } = await createConnectionStore(db, cipher).createWebhook({ ...(name ? { name } : {}), ownerUserId })
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '')
  console.log(`connection id: ${connection.id}`)
  console.log(`secret:        ${secret}`)
  if (publicUrl) console.log(`url:           ${publicUrl}/hooks/webhook/${connection.id}`)
  console.log('The secret is shown once. Store it now.')
})
