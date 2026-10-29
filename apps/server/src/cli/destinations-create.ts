import { readFileSync } from 'node:fs'
import { createAgentDestination, createDestination } from '@relay/core'
import { createCipher, intOpt, parseArgs, requireConnection, runCli } from './util'

await runCli(async ({ db, config }) => {
  const { values } = parseArgs({
    options: {
      connection: { type: 'string' },
      kind: { type: 'string' },
      name: { type: 'string' },
      url: { type: 'string' },
      'max-attempts': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'allowed-actions': { type: 'string' },
      'system-prompt-file': { type: 'string' },
      model: { type: 'string' },
      'max-turns': { type: 'string' },
      'timeout-seconds': { type: 'string' },
      'max-mutating-actions': { type: 'string' },
    },
  })
  const allowedActions = values['allowed-actions']
    ? { allowedActions: values['allowed-actions'].split(',').map((a) => a.trim()).filter(Boolean) }
    : {}
  const kind = values.kind ?? 'http'
  const connectionId = await requireConnection(db, values.connection)

  if (kind === 'agent') {
    if (!values['system-prompt-file']) throw new Error('--system-prompt-file is required for --kind agent')
    const destination = await createAgentDestination(db, connectionId, {
      name: values.name ?? '',
      config: {
        systemPrompt: readFileSync(values['system-prompt-file'], 'utf8').trim(),
        ...(values.model ? { model: values.model } : {}),
        ...(values['max-turns'] ? { maxTurns: intOpt(values['max-turns'])! } : {}),
        ...(values['timeout-seconds'] ? { timeoutSeconds: intOpt(values['timeout-seconds'])! } : {}),
        ...(values['max-mutating-actions'] ? { maxMutatingActions: intOpt(values['max-mutating-actions'])! } : {}),
      },
      ...allowedActions,
    })
    console.log(`destination id: ${destination.id}`)
    console.log('Replies post publicly as you. Set ANTHROPIC_API_KEY in the worker environment.')
    return
  }
  if (kind !== 'http') throw new Error('--kind must be http or agent')

  const cipher = await createCipher(config.RELAY_MASTER_KEY)
  const { destination, secret } = await createDestination(db, cipher, connectionId, {
    name: values.name ?? '',
    url: values.url ?? '',
    ...(values['max-attempts'] ? { maxAttempts: intOpt(values['max-attempts'])! } : {}),
    ...(values['timeout-ms'] ? { timeoutMs: intOpt(values['timeout-ms'])! } : {}),
    ...allowedActions,
  })
  console.log(`destination id: ${destination.id}`)
  console.log(`secret:         ${secret}`)
  console.log('The secret is shown once. Store it now.')
})
