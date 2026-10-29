import { createDestination } from '@relay/core'
import { createCipher, intOpt, parseArgs, runCli } from './util'

await runCli(async ({ db, config }) => {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      url: { type: 'string' },
      'max-attempts': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  })
  const cipher = await createCipher(config.RELAY_MASTER_KEY)
  const { destination, secret } = await createDestination(db, cipher, {
    name: values.name ?? '',
    url: values.url ?? '',
    ...(values['max-attempts'] ? { maxAttempts: intOpt(values['max-attempts'])! } : {}),
    ...(values['timeout-ms'] ? { timeoutMs: intOpt(values['timeout-ms'])! } : {}),
  })
  console.log(`destination id: ${destination.id}`)
  console.log(`secret:         ${secret}`)
  console.log('The secret is shown once. Store it now.')
})
