import { createServer, type Server } from 'node:http'
import { REST } from '@discordjs/rest'
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws'
import { ConfigError, createCipher, createConnectionStore, createDb, loadConfig, log, PgBossQueue, PROMETHEUS_CONTENT_TYPE, QUEUES, type MetricsRegistry } from '@relay/core'
import { createDiscordAdapter } from '@relay/provider-discord'
import { GATEWAY_INTENTS, gatewayEnvSchema } from './config'
import { createDispatchHandler } from './handler'
import { acquireLeaderLock } from './lock'
import { createGatewayMetrics } from './metrics'

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
  let manager: WebSocketManager | null = null
  let shuttingDown = false
  const cleanup: (() => Promise<void>)[] = []

  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('gateway shutting down', { reason })
    try {
      await manager?.destroy({ reason })
    } catch (err) {
      log.warn('gateway: destroy failed', { err: String(err) })
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

  const rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN)
  manager = new WebSocketManager({ token: config.DISCORD_BOT_TOKEN, intents: GATEWAY_INTENTS, rest })
  // Resume, heartbeats, and reconnects are the library's job. Relay never re-identifies on its own: the IDENTIFY budget is 1000 a day.
  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    void handle({ t: payload.t, d: payload.d })
  })
  manager.on(WebSocketShardEvents.Ready, () => metrics.connected.set(1))
  manager.on(WebSocketShardEvents.Resumed, () => metrics.connected.set(1))
  manager.on(WebSocketShardEvents.Closed, (code) => {
    metrics.connected.set(0)
    metrics.closes.inc({ code: String(code) })
    log.warn('gateway: socket closed', { code })
  })
  manager.on(WebSocketShardEvents.Error, (err) => log.error('gateway: shard error', { err: err.message }))
  await manager.connect()
  log.info('gateway started', { intents: GATEWAY_INTENTS, metricsPort: config.GATEWAY_METRICS_PORT })
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message)
  else console.error(err)
  process.exit(1)
})
