import { readFileSync } from 'node:fs'
import { createAgentDestination, createDestination, createToolDestination } from '@relay/core'
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
      'tool-destinations': { type: 'string' },
      'tool-name': { type: 'string' },
      description: { type: 'string' },
      'params-file': { type: 'string' },
      'read-only': { type: 'boolean' },
      sensitive: { type: 'boolean' },
      'max-response-bytes': { type: 'string' },
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
        ...(values['tool-destinations']
          ? { toolDestinationIds: values['tool-destinations'].split(',').map((a) => a.trim()).filter(Boolean) }
          : {}),
      },
      ...allowedActions,
    })
    console.log(`destination id: ${destination.id}`)
    console.log('Replies post publicly as you. Set ANTHROPIC_API_KEY in the worker environment.')
    return
  }
  const cipher = await createCipher(config.RELAY_MASTER_KEY)

  if (kind === 'tool') {
    if (!values['params-file']) throw new Error('--params-file is required for --kind tool')
    const { destination, secret } = await createToolDestination(db, cipher, connectionId, {
      name: values.name ?? '',
      url: values.url ?? '',
      toolName: values['tool-name'] ?? '',
      description: values.description ?? '',
      params: JSON.parse(readFileSync(values['params-file'], 'utf8')) as never,
      mutating: !values['read-only'],
      sensitive: Boolean(values.sensitive),
      ...(values['timeout-ms'] ? { timeoutMs: intOpt(values['timeout-ms'])! } : {}),
      ...(values['max-response-bytes'] ? { maxResponseBytes: intOpt(values['max-response-bytes'])! } : {}),
    })
    console.log(`destination id: ${destination.id}`)
    console.log(`secret:         ${secret}`)
    console.log('The secret is shown once. Store it now. Attach the tool to an agent with --tool-destinations.')
    return
  }
  if (kind !== 'http') throw new Error('--kind must be http, agent, or tool')

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
