import { parseArgs } from 'node:util'
import { z } from 'zod'
import { coreEnvSchema, createDb, loadConfig, PgBossQueue, ReplayError, type CoreConfig, type Db } from '@relay/core'

export { createCipher } from '@relay/core'
export { parseArgs }

export async function runCli(main: (ctx: { db: Db; config: CoreConfig }) => Promise<void>) {
  const config = loadConfig(coreEnvSchema)
  const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
  try {
    await main({ db, config })
  } catch (err) {
    if (err instanceof z.ZodError) {
      for (const issue of err.issues) console.error(`${issue.path.join('.') || 'input'}: ${issue.message}`)
    } else if (err instanceof ReplayError) {
      console.error(err.message)
    } else {
      console.error(err instanceof Error ? err.message : err)
    }
    process.exitCode = 1
  } finally {
    await close()
  }
}

export async function withQueue(config: CoreConfig, queueName: string, fn: (queue: PgBossQueue) => Promise<void>) {
  const queue = new PgBossQueue(config.DATABASE_URL)
  await queue.start()
  try {
    await queue.ensureQueue(queueName)
    await fn(queue)
  } finally {
    await queue.stop()
  }
}

export function intOpt(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value)
}
