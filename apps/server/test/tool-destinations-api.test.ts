import { eq } from 'drizzle-orm'
import { schema } from '@relay/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { signIn, useHarness, type Account, type Api } from './harness'

const h = useHarness()
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>

const PARAMS = {
  type: 'object',
  properties: { orderId: { type: 'string', maxLength: 40 }, qty: { type: 'integer', minimum: 1, maximum: 10 } },
  required: ['orderId'],
}
const toolBody = (over: Record<string, unknown> = {}) => ({
  kind: 'tool',
  name: 'Orders lookup',
  url: 'https://tools.example.test/orders',
  toolName: 'lookup_order',
  description: 'Look up an order by id.',
  params: PARAMS,
  mutating: false,
  ...over,
})

let me: Account
let other: Account
let mine: string
let theirs: string
let api: Api
let theirApi: Api
const scoped = (account: Account, connectionId: string): Api => (method, path, body) =>
  account.api(method, path.replace(/^\/api\//, `/api/c/${connectionId}/`), body)

beforeEach(async () => {
  me = await signIn(h, 'me@example.com')
  other = await signIn(h, 'other@example.com')
  mine = (await h.connections.createWebhook({ ownerUserId: me.userId })).connection.id
  theirs = (await h.connections.createWebhook({ ownerUserId: other.userId })).connection.id
  api = scoped(me, mine)
  theirApi = scoped(other, theirs)
})

describe('tool destinations API', () => {
  it('creates one, shows the secret once, and never returns it again', async () => {
    const res = await api('POST', '/api/destinations', toolBody())
    expect(res.status).toBe(201)
    const created = await json(res)
    expect(created).toMatchObject({
      kind: 'tool',
      url: 'https://tools.example.test/orders',
      timeoutMs: 10000,
      config: { toolName: 'lookup_order', mutating: false, sensitive: false, maxResponseBytes: 32768 },
    })
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/)
    const [row] = await h.db.select().from(schema.destinations).where(eq(schema.destinations.id, created.id))
    expect(row!.secretCiphertext).not.toContain(created.secret)
    expect(h.cipher.decrypt(row!.secretCiphertext!)).toBe(created.secret)
    for (const path of ['/api/destinations', `/api/destinations/${created.id}`]) {
      const text = await (await api('GET', path)).text()
      expect(text).not.toContain(created.secret)
      expect(text).not.toContain('secretCiphertext')
    }
    const rotated = await json(api('POST', `/api/destinations/${created.id}/rotate-secret`))
    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(rotated.secret).not.toBe(created.secret)
    expect(h.metrics.consoleMutations.get({ resource: 'destination', action: 'create' })).toBe(1)
  })

  it('rejects unsupported schema features, bad URLs, and too-long timeouts at create time', async () => {
    const bad = [
      { params: { type: 'object', properties: { a: { type: 'object', properties: {} } } } },
      { params: { type: 'object', properties: { a: { $ref: '#/x' } } } },
      { params: { type: 'object', properties: { a: { type: 'string', pattern: '.*' } } } },
      { params: { type: 'object', properties: { a: { type: 'string', format: 'uri' } } } },
      { params: { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } } },
      { params: { type: 'object', properties: { a: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } },
      { params: { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, maxItems: 500 } } } },
      { params: { type: 'object', properties: {}, required: ['missing'] } },
      { params: { type: 'object', properties: {}, additionalProperties: true } },
      { params: { type: 'array' } },
      { params: { type: 'object', properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, { type: 'string' }])) } },
      { url: 'ftp://tools.example.test/x' },
      { url: 'not a url' },
      { timeoutMs: 31_000 },
      { maxResponseBytes: 10_000_000 },
      { toolName: 'Bad-Name' },
      { description: '' },
      { extra: true },
    ]
    for (const over of bad) {
      const res = await api('POST', '/api/destinations', toolBody(over))
      expect(res.status, JSON.stringify(over)).toBe(400)
    }
    expect(await h.db.select().from(schema.destinations)).toHaveLength(0)
  })

  it('rejects tool names that collide with relay actions, and duplicates in one connection', async () => {
    for (const toolName of ['reply', 'post', 'react', 'update', 'thread_history', 'send']) {
      expect((await api('POST', '/api/destinations', toolBody({ toolName }))).status, toolName).toBe(400)
    }
    expect((await api('POST', '/api/destinations', toolBody())).status).toBe(201)
    const dup = await api('POST', '/api/destinations', toolBody({ name: 'again' }))
    expect(dup.status).toBe(409)
    expect((await theirApi('POST', '/api/destinations', toolBody())).status).toBe(201)

    const second = await json(api('POST', '/api/destinations', toolBody({ toolName: 'other_tool' })))
    expect((await api('PATCH', `/api/destinations/${second.id}`, { toolName: 'lookup_order' })).status).toBe(409)
    expect((await api('PATCH', `/api/destinations/${second.id}`, { toolName: 'reply' })).status).toBe(400)
  })

  it('updates fields, keeps the rest, and validates params on update', async () => {
    const created = await json(api('POST', '/api/destinations', toolBody()))
    const patched = await json(api('PATCH', `/api/destinations/${created.id}`, { sensitive: true, mutating: true, timeoutMs: 2000, enabled: false }))
    expect(patched).toMatchObject({ enabled: false, timeoutMs: 2000, config: { toolName: 'lookup_order', sensitive: true, mutating: true, params: PARAMS } })
    expect((await api('PATCH', `/api/destinations/${created.id}`, { params: { type: 'object', properties: { a: { type: 'null' } } } })).status).toBe(400)
    expect((await api('PATCH', `/api/destinations/${created.id}`, { systemPrompt: 'x' })).status).toBe(400)
  })

  it('agent destinations accept only tool destinations of the same connection', async () => {
    const tool = await json(api('POST', '/api/destinations', toolBody()))
    const foreign = await json(theirApi('POST', '/api/destinations', toolBody()))
    const http = await json(api('POST', '/api/destinations', { kind: 'http', name: 'h', url: 'http://localhost:9/x' }))
    const agent = (ids: string[]) => ({ kind: 'agent', name: 'a', config: { systemPrompt: 'Be brief.', toolDestinationIds: ids } })

    expect((await api('POST', '/api/destinations', agent([foreign.id]))).status).toBe(400)
    expect((await api('POST', '/api/destinations', agent([http.id]))).status).toBe(400)
    expect((await api('POST', '/api/destinations', agent(['not-a-uuid']))).status).toBe(400)
    const ok = await api('POST', '/api/destinations', agent([tool.id]))
    expect(ok.status).toBe(201)
    const created = await json(ok)
    expect(created.config.toolDestinationIds).toEqual([tool.id])

    expect((await api('PATCH', `/api/destinations/${created.id}`, { config: { toolDestinationIds: [foreign.id] } })).status).toBe(400)
    const [row] = await h.db.select().from(schema.destinations).where(eq(schema.destinations.id, created.id))
    expect((row!.config as { toolDestinationIds: string[] }).toolDestinationIds).toEqual([tool.id])

    expect((await api('DELETE', `/api/destinations/${tool.id}`)).status).toBe(409)
    expect((await api('PATCH', `/api/destinations/${created.id}`, { config: { toolDestinationIds: [] } })).status).toBe(200)
    expect((await api('DELETE', `/api/destinations/${tool.id}`)).status).toBe(204)
  })

  it('a tool destination cannot be linked to a route', async () => {
    const tool = await json(api('POST', '/api/destinations', toolBody()))
    const res = await api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [tool.id] })
    expect(res.status).toBe(400)
    expect(await h.db.select().from(schema.routes)).toHaveLength(0)
  })

  it("404s on another tenant's tool destination and changes nothing", async () => {
    const foreign = await json(theirApi('POST', '/api/destinations', toolBody()))
    const before = JSON.stringify(await h.db.select().from(schema.destinations))
    expect((await api('GET', `/api/destinations/${foreign.id}`)).status).toBe(404)
    expect((await api('PATCH', `/api/destinations/${foreign.id}`, { name: 'x' })).status).toBe(404)
    expect((await api('POST', `/api/destinations/${foreign.id}/rotate-secret`)).status).toBe(404)
    expect((await api('DELETE', `/api/destinations/${foreign.id}`)).status).toBe(404)
    expect((await me.api('GET', `/api/c/${theirs}/destinations`)).status).toBe(404)
    expect((await me.api('POST', `/api/c/${theirs}/destinations`, toolBody({ toolName: 'sneaky' }))).status).toBe(404)
    const list = await (await api('GET', '/api/destinations')).text()
    expect(list).not.toContain(foreign.id)
    expect(JSON.stringify(await h.db.select().from(schema.destinations))).toBe(before)
  })
})
