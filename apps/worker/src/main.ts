import { ConfigError, coreEnvSchema, loadConfig, log, PgBossQueue, QUEUES, type RouteJob } from '@relay/core'

async function main() {
  const config = loadConfig(coreEnvSchema)
  const queue = new PgBossQueue(config.DATABASE_URL)
  await queue.start()
  await queue.ensureQueue(QUEUES.route)

  await queue.work<RouteJob>(QUEUES.route, async (jobs) => {
    for (const job of jobs) log.info('route job received (stub)', { jobId: job.id, eventId: job.data.eventId })
  })
  log.info('worker started', { queues: [QUEUES.route] })

  const shutdown = async (signal: string) => {
    log.info('worker shutting down', { signal })
    await queue.stop()
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
