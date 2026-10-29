import {
  ConfigError,
  createActionExecutor,
  createCipher,
  createConnectionStore,
  createDb,
  deriveReplyTokenKey,
  loadConfig,
  log,
  PgBossQueue,
  QUEUES,
  type ActionsJob,
  type DispatchJob,
  type RouteJob,
} from '@relay/core'
import { createSlackRuntime } from '@relay/provider-slack'
import { createWebhookRuntime } from '@relay/provider-webhook'
import { createActionsHandler } from './actions'
import { workerEnvSchema } from './config'
import { createDispatcher } from './dispatcher'
import { startMetricsServer } from './http'
import { createWorkerMetrics } from './metrics'
import { createRouter } from './router'
import { createSweeper } from './sweeper'

async function main() {
  const config = loadConfig(workerEnvSchema)
  const cipher = await createCipher(config.RELAY_MASTER_KEY)
  const { db, close } = createDb(config.DATABASE_URL)
  const queue = new PgBossQueue(config.DATABASE_URL)
  await queue.start()
  await queue.ensureQueue(QUEUES.route)
  await queue.ensureQueue(QUEUES.dispatch)
  await queue.ensureQueue(QUEUES.actions)

  const metrics = createWorkerMetrics()
  const runtimes = {
    slack: createSlackRuntime({ db, apiBase: config.SLACK_API_BASE_URL }),
    webhook: createWebhookRuntime(),
  }
  const route = createRouter({ db, queue, metrics, runtimes })
  const execute = createActionExecutor({
    db,
    connections: createConnectionStore(db, cipher),
    runtimes,
    counters: metrics,
  })
  const handleActions = createActionsHandler({ db, queue, execute })
  const dispatch = createDispatcher({
    db,
    queue,
    cipher,
    metrics,
    backoffBaseMs: config.DISPATCH_BACKOFF_BASE_MS,
    backoffCapMs: config.DISPATCH_BACKOFF_CAP_MS,
    runtimes,
    replyKey: deriveReplyTokenKey(config.RELAY_MASTER_KEY),
    publicUrl: config.PUBLIC_URL,
    replyTtlSeconds: config.REPLY_TOKEN_TTL_SECONDS,
  })
  const poll = { pollingIntervalSeconds: config.WORKER_POLL_SECONDS }

  await queue.work<RouteJob>(
    QUEUES.route,
    async (jobs) => {
      for (const job of jobs) await route(job.data)
    },
    poll,
  )
  await queue.work<DispatchJob>(
    QUEUES.dispatch,
    async (jobs) => {
      for (const job of jobs) await dispatch(job.data)
    },
    { ...poll, batchSize: 1, localConcurrency: 1 },
  )
  await queue.work<ActionsJob>(
    QUEUES.actions,
    async (jobs) => {
      for (const job of jobs) await handleActions(job.data)
    },
    { ...poll, batchSize: 1, localConcurrency: 1 },
  )
  const sweep = createSweeper({ db, queue, metrics, graceMs: config.SWEEP_GRACE_SECONDS * 1000 })
  const runSweep = () => sweep().catch((err) => log.error('sweeper failed', { err: String(err) }))
  void runSweep()
  const sweepTimer = setInterval(() => void runSweep(), config.SWEEP_INTERVAL_SECONDS * 1000)
  const metricsServer = await startMetricsServer(metrics.registry, config.WORKER_METRICS_PORT)
  log.info('worker started', { queues: [QUEUES.route, QUEUES.dispatch, QUEUES.actions], metricsPort: config.WORKER_METRICS_PORT })

  const shutdown = async (signal: string) => {
    log.info('worker shutting down', { signal })
    clearInterval(sweepTimer)
    metricsServer.close()
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
