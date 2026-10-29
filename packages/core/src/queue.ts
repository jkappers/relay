import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import type { Tx } from './db/client'
import { log } from './log'

export const QUEUES = { route: 'route' } as const

export interface RouteJob {
  eventId: string
}

export interface SendOptions {
  tx?: Tx
}

export interface QueueJob<T> {
  id: string
  data: T
}

export interface Queue {
  start(): Promise<void>
  stop(): Promise<void>
  ensureQueue(name: string): Promise<void>
  send<T extends object>(name: string, data: T, opts?: SendOptions): Promise<string | null>
  work<T>(name: string, handler: (jobs: QueueJob<T>[]) => Promise<void>): Promise<void>
}

export class PgBossQueue implements Queue {
  private readonly boss: PgBoss

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString })
    this.boss.on('error', (err) => log.error('pg-boss error', { err: String(err) }))
  }

  async start(): Promise<void> {
    await this.boss.start()
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true })
  }

  async ensureQueue(name: string): Promise<void> {
    await this.boss.createQueue(name)
  }

  async send<T extends object>(name: string, data: T, opts: SendOptions = {}): Promise<string | null> {
    return this.boss.send(name, data, opts.tx ? { db: fromDrizzle(opts.tx, sql) } : {})
  }

  async work<T>(name: string, handler: (jobs: QueueJob<T>[]) => Promise<void>): Promise<void> {
    await this.boss.work<T>(name, async (jobs) => handler(jobs.map((j) => ({ id: j.id, data: j.data }))))
  }
}
