import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import {
  createCipher,
  createConnectionStore,
  createDb,
  createDestination,
  createRoute,
  PgBossQueue,
  QUEUES,
  schema,
  type Cipher,
  type ConnectionStore,
  type CreateDestinationInput,
  type CreateRouteInput,
  type Db,
  type Envelope,
} from '@relay/core'
import { resetDb, TEST_DATABASE_URL, TEST_MASTER_KEY } from '@relay/core/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { createDispatcher } from '../src/dispatcher'
import { createWorkerMetrics, type WorkerMetrics } from '../src/metrics'
import { createRouter } from '../src/router'

export interface Harness {
  db: Db
  queue: PgBossQueue
  cipher: Cipher
  connections: ConnectionStore
  metrics: WorkerMetrics
  router: ReturnType<typeof createRouter>
  dispatcher: ReturnType<typeof createDispatcher>
}

export function useHarness(opts: { backoffBaseMs?: number; backoffCapMs?: number } = {}): Harness {
  const h = {} as Harness
  let close: () => Promise<void>

  beforeAll(async () => {
    const handle = createDb(TEST_DATABASE_URL, { max: 5 })
    h.db = handle.db
    close = handle.close
    h.cipher = await createCipher(TEST_MASTER_KEY)
    h.connections = createConnectionStore(h.db, h.cipher)
    h.queue = new PgBossQueue(TEST_DATABASE_URL)
    await h.queue.start()
    await h.queue.ensureQueue(QUEUES.route)
    await h.queue.ensureQueue(QUEUES.dispatch)
  })

  beforeEach(async () => {
    await resetDb(h.db)
    h.metrics = createWorkerMetrics()
    h.router = createRouter({ db: h.db, queue: h.queue, metrics: h.metrics })
    h.dispatcher = createDispatcher({
      db: h.db,
      queue: h.queue,
      cipher: h.cipher,
      metrics: h.metrics,
      backoffBaseMs: opts.backoffBaseMs ?? 10,
      backoffCapMs: opts.backoffCapMs ?? 50,
    })
  })

  afterAll(async () => {
    await h.queue?.stop()
    await close?.()
  })

  return h
}

export async function insertEvent(
  h: Harness,
  connectionId: string,
  overrides: Partial<Envelope> = {},
): Promise<{ id: string; envelope: Envelope }> {
  const id = randomUUID()
  const envelope: Envelope = {
    id,
    provider: 'webhook',
    connectionId,
    type: 'webhook.ping',
    subtype: null,
    occurredAt: new Date().toISOString(),
    actor: null,
    context: { channelId: null, threadId: null, messageId: null },
    text: 'hello world',
    raw: {},
    ...overrides,
  }
  await h.db
    .insert(schema.events)
    .values({ id, provider: 'webhook', connectionId, dedupKey: `${connectionId}:${id}`, raw: {}, envelope })
  return { id, envelope }
}

export async function setup(h: Harness, dest: Partial<CreateDestinationInput> & { url: string }) {
  const { connection } = await h.connections.createWebhook()
  const { destination, secret } = await createDestination(h.db, h.cipher, { name: 'dest', ...dest })
  return { connection, destination, secret }
}

export async function makeRoute(h: Harness, input: Partial<CreateRouteInput> & { destinationIds: string[] }) {
  return createRoute(h.db, { name: 'route', eventType: 'webhook.*', ...input })
}

export async function makeDelivery(h: Harness, eventId: string, routeId: string, destinationId: string) {
  const [row] = await h.db.insert(schema.deliveries).values({ eventId, routeId, destinationId }).returning()
  return row!
}

export async function getDelivery(h: Harness, id: string) {
  const [row] = await h.db.select().from(schema.deliveries).where(sql`${schema.deliveries.id} = ${id}`)
  return row!
}

export async function dispatchJobs(h: Harness): Promise<{ deliveryId: string; startAfter: Date }[]> {
  const rows = await h.db.execute<{ delivery_id: string; start_after: Date }>(
    sql`select data->>'deliveryId' as delivery_id, start_after from pgboss.job where name = ${QUEUES.dispatch} order by created_on`,
  )
  return rows.map((r) => ({ deliveryId: r.delivery_id, startAfter: new Date(r.start_after) }))
}

export interface ReceivedRequest {
  headers: IncomingMessage['headers']
  body: string
}
export type Handler = (req: ReceivedRequest, res: ServerResponse) => void | Promise<void>

export interface Receiver {
  url: string
  requests: ReceivedRequest[]
  server: Server
  close(): Promise<void>
}

export async function startReceiver(handlers: Handler | Handler[]): Promise<Receiver> {
  const requests: ReceivedRequest[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const received = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(received)
      const handler = Array.isArray(handlers)
        ? handlers[Math.min(requests.length - 1, handlers.length - 1)]!
        : handlers
      void handler(received, res)
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    server,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
}

export const respond =
  (status: number, body?: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    const isJson = body !== undefined && typeof body !== 'string'
    res.writeHead(status, { ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers })
    res.end(body === undefined ? '' : isJson ? JSON.stringify(body) : body)
  }
