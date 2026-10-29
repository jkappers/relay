import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { sql } from 'drizzle-orm'
import { createDb } from './db/client'
import type { Db } from './db/client'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay@localhost:54329/relay_test'

export const TEST_MASTER_KEY = new Uint8Array(32).fill(7)

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table agent_runs, revoked_tokens, sent_messages, actions_log, deliveries, route_destinations, routes, destinations, events, credentials, connections cascade`)
  await db.execute(sql`do $$ begin if to_regclass('pgboss.job') is not null then delete from pgboss.job; end if; end $$`)
}

export async function dropQueueSchema(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 })
  try {
    await db.execute(sql`drop schema if exists pgboss cascade`)
  } finally {
    await close()
  }
}

export interface StubRequest {
  method: string
  slackMethod: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

export type StubReply = { status?: number; headers?: Record<string, string>; json?: unknown; body?: string }

export interface SlackStub {
  url: string
  requests: StubRequest[]
  calls(slackMethod: string): StubRequest[]
  /** Override the reply for one Slack method. Return undefined to fall back to the default. */
  on(slackMethod: string, fn: (req: StubRequest) => StubReply | undefined): void
  reset(): void
  close(): Promise<void>
}

export async function startSlackStub(): Promise<SlackStub> {
  const requests: StubRequest[] = []
  const overrides = new Map<string, (req: StubRequest) => StubReply | undefined>()
  const sockets = new Set<Socket>()
  let counter = 0

  const defaults = (req: StubRequest): StubReply => {
    switch (req.slackMethod) {
      case 'chat.postMessage':
        return { json: { ok: true, channel: req.body.channel, ts: `1700000000.${String(++counter).padStart(6, '0')}` } }
      case 'chat.update':
        return { json: { ok: true, channel: req.body.channel, ts: req.body.ts } }
      case 'conversations.replies':
        return {
          json: {
            ok: true,
            has_more: false,
            messages: [
              { type: 'message', user: 'U1', text: 'parent', ts: String(req.body.ts), thread_ts: String(req.body.ts), reply_count: 1 },
              { type: 'message', user: 'U2', text: 'child', ts: '1700000001.000001', thread_ts: String(req.body.ts), parent_user_id: 'U1' },
            ],
          },
        }
      default:
        return { json: { ok: true } }
    }
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub')
      const raw = Buffer.concat(chunks).toString('utf8')
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams)
      const stubReq: StubRequest = {
        method: req.method ?? 'GET',
        slackMethod: url.pathname.split('/').pop() ?? '',
        headers: req.headers,
        body,
      }
      requests.push(stubReq)
      const reply = overrides.get(stubReq.slackMethod)?.(stubReq) ?? defaults(stubReq)
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
      res.end(reply.body ?? JSON.stringify(reply.json ?? { ok: true }))
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/api`,
    requests,
    calls: (m) => requests.filter((r) => r.slackMethod === m),
    on: (m, fn) => void overrides.set(m, fn),
    reset: () => {
      requests.length = 0
      overrides.clear()
      counter = 0
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
}
