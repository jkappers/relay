import type { ActionContext, Connection, Db, Envelope } from '@relay/core'
import { describe, expect, it, vi } from 'vitest'
import { createSmsRuntime } from '../src'

const connection: Connection = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'sms',
  teamId: `AC${'a'.repeat(32)}`,
  userId: '+15550001111',
  name: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
}

const envelope: Envelope = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'sms',
  connectionId: connection.id,
  type: 'sms.message.received',
  subtype: null,
  occurredAt: new Date().toISOString(),
  actor: '+15559998888',
  context: { channelId: '+15559998888', threadId: null, messageId: 'SMin' },
  text: 'hi',
  raw: {},
}

const runtime = createSmsRuntime({ db: {} as Db, apiBase: 'http://twilio.test/' })
const send = runtime.actions.send!

function ctx(fetchImpl: typeof fetch, over: Partial<ActionContext> = {}): ActionContext {
  return { envelope, connection, credentials: { sms_auth_token: 'tok' }, fetch: fetchImpl, ...over }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('sms.send', () => {
  it('posts a form to the Messages endpoint from the connection number to the sender', async () => {
    const f = vi.fn<typeof fetch>(async () => json(201, { sid: 'SMout', status: 'queued' }))
    const out = await send.run(ctx(f), { body: 'pong' })

    expect(out).toEqual({ result: { sid: 'SMout', status: 'queued' }, sentMessage: { channel: '+15559998888', ts: 'SMout' } })
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`http://twilio.test/2010-04-01/Accounts/${connection.teamId}/Messages.json`)
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${connection.teamId}:tok`).toString('base64')}`)
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({ To: '+15559998888', From: '+15550001111', Body: 'pong' })
  })

  it('retries 429 with Retry-After and 5xx, and network errors', async () => {
    const limited = vi.fn<typeof fetch>(async () => json(429, {}, { 'retry-after': '3' }))
    await expect(send.run(ctx(limited), { body: 'x' })).rejects.toMatchObject({ code: 'ratelimited', retryable: true, retryAfterMs: 3000 })
    const down = vi.fn<typeof fetch>(async () => json(503, {}))
    await expect(send.run(ctx(down), { body: 'x' })).rejects.toMatchObject({ code: 'http_503', retryable: true })
    const dead = vi.fn<typeof fetch>(async () => {
      throw new Error('boom')
    })
    await expect(send.run(ctx(dead), { body: 'x' })).rejects.toMatchObject({ code: 'network_error', retryable: true })
  })

  it('does not retry client errors and surfaces the Twilio code', async () => {
    const f = vi.fn<typeof fetch>(async () => json(400, { code: 21211, message: 'Invalid To' }))
    await expect(send.run(ctx(f), { body: 'x' })).rejects.toMatchObject({ code: 'twilio_21211', retryable: false })
  })

  it('fails without credentials or a recipient, and bounds the body', async () => {
    const f = vi.fn<typeof fetch>()
    await expect(send.run(ctx(f, { credentials: {} }), { body: 'x' })).rejects.toMatchObject({ code: 'no_credentials', retryable: false })
    const noTo = { ...envelope, context: { ...envelope.context, channelId: null } }
    await expect(send.run(ctx(f, { envelope: noTo }), { body: 'x' })).rejects.toMatchObject({ code: 'no_channel_context' })
    expect(send.params.safeParse({ body: '' }).success).toBe(false)
    expect(send.params.safeParse({ body: 'x'.repeat(1601) }).success).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('isSelfEcho', () => {
  it('treats messages from the connection number as echoes', async () => {
    expect(await runtime.isSelfEcho({ ...envelope, actor: connection.userId }, connection)).toBe(true)
  })

  it('does not treat other senders as echoes when there is no message context', async () => {
    const bare = { ...envelope, context: { channelId: null, threadId: null, messageId: null } }
    expect(await runtime.isSelfEcho(bare, connection)).toBe(false)
  })
})
