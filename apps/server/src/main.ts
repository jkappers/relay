import { serve } from '@hono/node-server'
import { ConfigError, createCipher, createConnectionStore, createDb, loadConfig, log, PgBossQueue, QUEUES } from '@relay/core'
import { createApp } from './app'
import { serverEnvSchema } from './config'
import { createServerMetrics } from './metrics'

async function main() {
  const config = loadConfig(serverEnvSchema)
  const cipher = await createCipher(config.RELAY_MASTER_KEY)
  const { db, close } = createDb(config.DATABASE_URL)
  const queue = new PgBossQueue(config.DATABASE_URL)
  await queue.start()
  await queue.ensureQueue(QUEUES.route)
  await queue.ensureQueue(QUEUES.dispatch)

  const app = createApp({
    config,
    db,
    queue,
    cipher,
    connections: createConnectionStore(db, cipher),
    metrics: createServerMetrics(),
  })
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => log.info('server listening', { port: info.port }))

  const shutdown = async (signal: string) => {
    log.info('server shutting down', { signal })
    server.close()
    await queue.stop()
    await close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message)
  else console.error(err)
  process.exit(1)
})
