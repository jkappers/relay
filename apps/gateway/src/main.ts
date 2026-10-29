import { createServer, type Server } from 'node:http'
import {
  ConfigError,
  createCipher,
  createConnectionStore,
  createDb,
  createProviderAppStore,
  loadConfig,
  log,
  PgBossQueue,
  PROMETHEUS_CONTENT_TYPE,
  providerAppEnv,
  QUEUES,
  type MetricsRegistry,
} from '@relay/core'
import { createDiscordAdapter } from '@relay/provider-discord'
import { GATEWAY_INTENTS, gatewayEnvSchema } from './config'
import { createGatewayController, type TokenRead } from './controller'
import { createDispatchHandler } from './handler'
import { acquireLeaderLock } from './lock'
import { createGatewayMetrics } from './metrics'
import { discordSessionFactory } from './session'
import { createStatusWriter } from './status'

function startMetricsServer(registry: MetricsRegistry, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/metrics') res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE }).end(registry.render())
    else if (req.method === 'GET' && path === '/healthz') res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    else res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

async function main() {
  const config = loadConfig(gatewayEnvSchema)
  const metrics = createGatewayMetrics()
  const metricsServer = await startMetricsServer(metrics.registry, config.GATEWAY_METRICS_PORT)

  const lock = acquireLeaderLock(config.DATABASE_URL, {
    pollMs: config.GATEWAY_LOCK_POLL_SECONDS * 1000,
    onWaiting: () => log.info('gateway: another copy holds the leader lock, waiting'),
  })
  let controller: ReturnType<typeof createGatewayController> | null = null
  let pollTimer: NodeJS.Timeout | undefined
  let shuttingDown = false
  const cleanup: (() => Promise<void>)[] = []

  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('gateway shutting down', { reason })
    if (pollTimer) clearInterval(pollTimer)
    try {
      await controller?.stop(reason)
    } catch (err) {
      log.warn('gateway: stop failed', { err: String(err) })
    }
    metrics.connected.set(0)
    for (const fn of cleanup.reverse()) await fn().catch((err) => log.warn('gateway: cleanup failed', { err: String(err) }))
    await lock.release()
    metrics.leader.set(0)
    metricsServer.close()
    process.exit(code)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    await lock.acquired
  } catch {
    return
  }
  metrics.leader.set(1)
  log.info('gateway: holding the leader lock')
  // Losing the lock means another copy may take over. Stop at once; a supervisor restarts us as a waiter.
  void lock.lost.then(() => shutdown('leader lock lost', 1))

  const cipher = await createCipher(config.RELAY_MASTER_KEY)
  const { db, close } = createDb(config.DATABASE_URL, { max: 4 })
  cleanup.push(close)
  const queue = new PgBossQueue(config.DATABASE_URL)
  await queue.start()
  cleanup.push(() => queue.stop())
  await queue.ensureQueue(QUEUES.route)

  const providerApps = createProviderAppStore({
    db,
    masterKey: config.RELAY_MASTER_KEY,
    env: providerAppEnv({ DISCORD_BOT_TOKEN: config.DISCORD_BOT_TOKEN }),
    ttlMs: config.GATEWAY_TOKEN_POLL_SECONDS * 1000,
    counters: { configErrors: metrics.providerAppConfigErrors },
  })
  const readToken = async (): Promise<TokenRead> => {
    const current = await providerApps.get('discord', { fresh: true })
    if (current.state === 'invalid') return { kind: 'unknown' }
    if (current.state === 'missing' || !current.config.botToken) return { kind: 'none' }
    return { kind: 'token', token: current.config.botToken }
  }

  let botUserId: string | null = null
  const adapter = createDiscordAdapter({ connections: createConnectionStore(db, cipher), botUserId: () => botUserId })
  const handle = createDispatchHandler({
    db,
    queue,
    adapter,
    metrics,
    onReady: (id) => {
      botUserId = id
      log.info('gateway: ready', { botUserId: id })
    },
  })

  controller = createGatewayController({
    readToken,
    factory: discordSessionFactory({ intents: GATEWAY_INTENTS }),
    metrics,
    status: createStatusWriter(db),
    onDispatch: (payload) => void handle(payload),
    onNewSession: () => {
      botUserId = null
    },
    minSwapMs: config.GATEWAY_MIN_SWAP_SECONDS * 1000,
  })
  await controller.tick()
  pollTimer = setInterval(() => void controller?.tick(), config.GATEWAY_TOKEN_POLL_SECONDS * 1000)
  log.info('gateway started', { intents: GATEWAY_INTENTS, metricsPort: config.GATEWAY_METRICS_PORT, tokenPollSeconds: config.GATEWAY_TOKEN_POLL_SECONDS })
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message)
  else console.error(err)
  process.exit(1)
})
