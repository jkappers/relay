import { parseArgs } from 'node:util'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { AdminError, coreEnvSchema, createDb, loadConfig, PgBossQueue, schema, type CoreConfig, type Db } from '@relay/core'
import { findUserByEmail } from '../accounts/users'

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
    } else if (err instanceof AdminError) {
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

export async function userIdByEmail(db: Db, email: string | undefined): Promise<string> {
  if (!email) throw new Error('--email is required')
  const user = await findUserByEmail(db, email)
  if (!user) throw new Error(`no user with email ${email}`)
  return user.id
}

export async function requireConnection(db: Db, id: string | undefined): Promise<string> {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) throw new Error('--connection must be a connection id')
  const [row] = await db.select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.id, parsed.data))
  if (!row) throw new Error(`no connection ${parsed.data}`)
  return row.id
}

/** Reads the password from stdin: one line when typed, or everything piped in, without the trailing newline. */
export async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Password (input is shown): ')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
    if (process.stdin.isTTY && chunk.includes(10)) break
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}
