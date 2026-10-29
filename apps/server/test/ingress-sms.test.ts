import { schema } from '@relay/core'
import { computeTwilioSignature } from '@relay/provider-sms'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { PUBLIC_URL, routeJobCount, SMS_ACCOUNT_SID, SMS_NUMBER, SMS_TOKEN, smsRequest, useHarness } from './harness'

const h = useHarness()
const outcome = (o: string) => h.metrics.ingressRequests.get({ provider: 'sms', outcome: o })

const inbound = (over: Record<string, string> = {}) => ({
  MessageSid: `SM${'1'.repeat(32)}`,
  AccountSid: SMS_ACCOUNT_SID,
  From: '+15559998888',
  To: SMS_NUMBER,
  Body: 'hello relay',
  NumMedia: '0',
  ...over,
})

const connect = () =>
  h.connections.createSms({ accountSid: SMS_ACCOUNT_SID, number: SMS_NUMBER, authToken: SMS_TOKEN, ownerUserId: null })

describe('POST /hooks/sms/:connectionId', () => {
  it('accepts a signed message, normalizes it, and answers with empty TwiML', async () => {
    const conn = await connect()
    const res = await smsRequest(h.app, conn.id, inbound())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/xml')
    expect(await res.text()).toContain('<Response></Response>')

    const [row] = await h.db.select().from(schema.events)
    expect(row).toMatchObject({ provider: 'sms', connectionId: conn.id })
    expect(row?.envelope).toMatchObject({
      type: 'sms.message.received',
      actor: '+15559998888',
      text: 'hello relay',
      context: { channelId: '+15559998888', threadId: null, messageId: `SM${'1'.repeat(32)}` },
    })
    expect(row?.raw).toMatchObject({ Body: 'hello relay', To: SMS_NUMBER })
    expect(await routeJobCount(h.db, row!.id)).toBe(1)
    expect(outcome('accepted')).toBe(1)
  })

  it('dedupes on MessageSid', async () => {
    const conn = await connect()
    await smsRequest(h.app, conn.id, inbound())
    const again = await smsRequest(h.app, conn.id, inbound({ Body: 'retry' }))
    expect(again.status).toBe(200)
    expect(await h.db.select().from(schema.events)).toHaveLength(1)
    expect(outcome('duplicate')).toBe(1)
  })

  it('signs over the query string', async () => {
    const conn = await connect()
    const res = await smsRequest(h.app, conn.id, inbound(), { query: '?x=1' })
    expect(res.status).toBe(200)
  })

  it('rejects a bad signature, wrong token, and tampered body with 401 and stores nothing', async () => {
    const conn = await connect()
    const bad = await smsRequest(h.app, conn.id, inbound(), { signature: 'AAAA' })
    const wrong = await smsRequest(h.app, conn.id, inbound(), { token: 'not-the-token' })
    expect([bad.status, wrong.status]).toEqual([401, 401])

    const good = inbound()
    const tampered = await h.app.request(`/hooks/sms/${conn.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signFor(conn.id, good),
      },
      body: new URLSearchParams({ ...good, Body: 'changed' }).toString(),
    })
    expect(tampered.status).toBe(401)
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('bad_signature')).toBe(3)
  })

  it('rejects a missing signature header with 401', async () => {
    const conn = await connect()
    const res = await h.app.request(`/hooks/sms/${conn.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(inbound()).toString(),
    })
    expect(res.status).toBe(401)
  })

  it('answers 200 and stores nothing for unknown, non-sms, and revoked connections', async () => {
    const unknown = await smsRequest(h.app, '00000000-0000-4000-8000-000000000000', inbound())
    const webhook = await h.connections.createWebhook({ ownerUserId: null })
    const notSms = await smsRequest(h.app, webhook.connection.id, inbound())
    const conn = await connect()
    await h.db.update(schema.connections).set({ status: 'revoked' }).where(eq(schema.connections.id, conn.id))
    const revoked = await smsRequest(h.app, conn.id, inbound())
    expect([unknown.status, notSms.status, revoked.status]).toEqual([200, 200, 200])
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('unknown_connection')).toBe(3)
  })

  it('ignores messages whose AccountSid does not match the connection', async () => {
    const conn = await connect()
    const res = await smsRequest(h.app, conn.id, inbound({ AccountSid: `AC${'b'.repeat(32)}` }))
    expect(res.status).toBe(200)
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
  })

  it('does not accept one connection token for another connection', async () => {
    const a = await connect()
    const b = await h.connections.createSms({
      accountSid: SMS_ACCOUNT_SID,
      number: '+15550002222',
      authToken: 'a-different-token',
      ownerUserId: null,
    })
    const res = await smsRequest(h.app, b.id, inbound(), { token: SMS_TOKEN })
    expect(res.status).toBe(401)
    expect(a.id).not.toBe(b.id)
  })

  it('refuses to connect the same number twice', async () => {
    await connect()
    await expect(connect()).rejects.toThrow(/already connected/)
  })
})

function signFor(connectionId: string, params: Record<string, string>): string {
  return computeTwilioSignature(
    SMS_TOKEN,
    `${PUBLIC_URL}/hooks/sms/${connectionId}`,
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, [v]])),
  )
}
