import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import type { Tx } from './db/client'
import { log } from './log'

export const QUEUES = { route: 'route', dispatch: 'dispatch', actions: 'actions' } as const

export const QUEUE_OPTIONS: Record<string, QueueOptions> = {
  [QUEUES.route]: { policy: 'short' },
  [QUEUES.dispatch]: { policy: 'short', retryLimit: 5, retryDelay: 5, retryBackoff: true },
  [QUEUES.actions]: { policy: 'short', retryLimit: 5, retryDelay: 5, retryBackoff: true },
}

export interface RouteJob {
  eventId: string
  recheck?: boolean
}

export interface ActionsJob {
  deliveryId: string
}

export interface DispatchJob {
  deliveryId: string
}

export interface SendOptions {
  tx?: Tx
  startAfter?: Date
  singletonKey?: string
}

export interface WorkOptions {
  batchSize?: number
  localConcurrency?: number
  pollingIntervalSeconds?: number
}

export interface QueueOptions {
  policy?: 'short'
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
}

export interface QueueJob<T> {
  id: string
  data: T
}

export interface Queue {
  start(): Promise<void>
  stop(): Promise<void>
  ensureQueue(name: string, opts?: QueueOptions): Promise<void>
  send<T extends object>(name: string, data: T, opts?: SendOptions): Promise<string | null>
  work<T>(name: string, handler: (jobs: QueueJob<T>[]) => Promise<void>, opts?: WorkOptions): Promise<void>
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

  async ensureQueue(name: string, opts: QueueOptions = QUEUE_OPTIONS[name] ?? {}): Promise<void> {
    await this.boss.createQueue(name, opts)
  }

  async send<T extends object>(name: string, data: T, opts: SendOptions = {}): Promise<string | null> {
    return this.boss.send(name, data, {
      ...(opts.tx ? { db: fromDrizzle(opts.tx, sql) } : {}),
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
    })
  }

  async work<T>(name: string, handler: (jobs: QueueJob<T>[]) => Promise<void>, opts: WorkOptions = {}): Promise<void> {
    await this.boss.work<T>(name, { batchSize: 1, localConcurrency: 1, ...opts }, async (jobs) =>
      handler(jobs.map((j) => ({ id: j.id, data: j.data }))),
    )
  }
}
