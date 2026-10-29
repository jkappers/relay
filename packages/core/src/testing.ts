import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { sql } from 'drizzle-orm'
import { createDb } from './db/client'
import type { Db } from './db/client'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay@localhost:54329/relay_test'

export const TEST_MASTER_KEY = new Uint8Array(32).fill(7)

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table sessions, connection_members, users, agent_runs, revoked_tokens, sent_messages, actions_log, deliveries, route_destinations, routes, destinations, events, credentials, connections cascade`)
  await db.execute(sql`do $$ begin if to_regclass('pgboss.job') is not null then delete from pgboss.job; end if; end $$`)
}

/** Drops every table so each test run migrates the test database from zero. */
export async function dropAllSchemas(url: string): Promise<void> {
  if (!/\/relay_test(\?|$)/.test(url) && !process.env.TEST_DATABASE_URL) throw new Error(`refusing to drop schemas outside relay_test: ${url}`)
  const { db, close } = createDb(url, { max: 1 })
  try {
    await db.execute(sql`drop schema if exists pgboss cascade`)
    await db.execute(sql`drop schema if exists drizzle cascade`)
    await db.execute(sql`drop schema if exists public cascade`)
    await db.execute(sql`create schema public`)
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

export const DISCORD_STUB_BOT_ID = '1100000000000000001'

export type DiscordRoute = 'createMessage' | 'editMessage' | 'createReaction' | 'getMessages' | 'getCurrentUser' | 'other'

export interface DiscordStubRequest {
  method: string
  route: DiscordRoute
  /** Path after the API base, with the query string, e.g. /channels/1/messages?limit=5. */
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown> | null
}

export interface DiscordStub {
  /** API base to pass as DISCORD_API_BASE_URL. */
  url: string
  requests: DiscordStubRequest[]
  calls(route: DiscordRoute): DiscordStubRequest[]
  on(route: DiscordRoute, fn: (req: DiscordStubRequest) => StubReply | undefined): void
  reset(): void
  close(): Promise<void>
}

function discordRoute(method: string, path: string): DiscordRoute {
  const p = path.split('?')[0]!
  if (method === 'GET' && p === '/users/@me') return 'getCurrentUser'
  if (/^\/channels\/[^/]+\/messages$/.test(p)) return method === 'POST' ? 'createMessage' : method === 'GET' ? 'getMessages' : 'other'
  if (method === 'PATCH' && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(p)) return 'editMessage'
  if (method === 'PUT' && /^\/channels\/[^/]+\/messages\/[^/]+\/reactions\/[^/]+\/@me$/.test(p)) return 'createReaction'
  return 'other'
}

/** A local stand-in for Discord REST v10. Mirrors startSlackStub. */
export async function startDiscordStub(): Promise<DiscordStub> {
  const requests: DiscordStubRequest[] = []
  const overrides = new Map<DiscordRoute, (req: DiscordStubRequest) => StubReply | undefined>()
  const sockets = new Set<Socket>()
  let counter = 0
  const base = '/api/v10'

  const channelOf = (path: string) => path.split('?')[0]!.split('/')[2] ?? ''
  const defaults = (req: DiscordStubRequest): StubReply => {
    switch (req.route) {
      case 'createMessage':
        return { json: { id: String(1300000000000000000n + BigInt(++counter)), channel_id: channelOf(req.path), content: req.body?.content ?? '', type: req.body?.message_reference ? 19 : 0, author: { id: DISCORD_STUB_BOT_ID, bot: true } } }
      case 'editMessage':
        return { json: { id: req.path.split('/')[4], channel_id: channelOf(req.path), content: req.body?.content ?? '' } }
      case 'createReaction':
        return { status: 204, body: '' }
      case 'getMessages':
        return {
          json: [
            { id: '1300000000000000102', channel_id: channelOf(req.path), author: { id: DISCORD_STUB_BOT_ID, bot: true }, content: 'newer', timestamp: '2026-10-25T10:00:02.000000+00:00' },
            { id: '1300000000000000101', channel_id: channelOf(req.path), author: { id: '53908099506183680' }, content: 'older', timestamp: '2026-10-25T10:00:01.000000+00:00' },
          ],
        }
      case 'getCurrentUser':
        return { json: { id: DISCORD_STUB_BOT_ID, username: 'relay', bot: true } }
      default:
        return { status: 404, json: { message: '404: Not Found', code: 0 } }
    }
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const full = req.url ?? '/'
      const path = full.startsWith(base) ? full.slice(base.length) : full
      const method = req.method ?? 'GET'
      const stubReq: DiscordStubRequest = { method, route: discordRoute(method, path), path, headers: req.headers, body: raw ? JSON.parse(raw) : null }
      requests.push(stubReq)
      const reply = overrides.get(stubReq.route)?.(stubReq) ?? defaults(stubReq)
      const status = reply.status ?? 200
      res.writeHead(status, status === 204 ? { ...reply.headers } : { 'content-type': 'application/json', ...reply.headers })
      res.end(status === 204 ? '' : (reply.body ?? JSON.stringify(reply.json ?? {})))
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}${base}`,
    requests,
    calls: (route) => requests.filter((r) => r.route === route),
    on: (route, fn) => void overrides.set(route, fn),
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
