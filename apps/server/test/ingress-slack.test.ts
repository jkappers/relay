import { eq, sql } from 'drizzle-orm'
import { schema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { routeJobCount, slackFixture, slackRequest, useHarness } from './harness'

const h = useHarness()

async function connectFixtureUser(teamId = 'T123ABC456', userId = 'U2147483697') {
  return h.connections.upsertSlack({ teamId, userId, accessToken: 'xoxp-test', ownerUserId: null })
}

const outcome = (o: string) => h.metrics.ingressRequests.get({ provider: 'slack', outcome: o })

describe('POST /hooks/slack', () => {
  it('accepts, stores, and enqueues an event', async () => {
    const conn = await connectFixtureUser()
    const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')))
    expect(res.status).toBe(200)

    const rows = await h.db.select().from(schema.events)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({ provider: 'slack', connectionId: conn.id, dedupKey: 'Ev0PV52K21' })
    expect(row.enqueuedAt).not.toBeNull()
    expect(row.envelope).toMatchObject({ id: row.id, type: 'slack.message.im', connectionId: conn.id })
    expect(await routeJobCount(h.db, row.id)).toBe(1)
    expect(outcome('accepted')).toBe(1)
  })

  it('dedupes the same event_id: one row, both 200, retry suppressed', async () => {
    await connectFixtureUser()
    const body = JSON.stringify(slackFixture('message_im'))
    const first = await slackRequest(h.app, body)
    const second = await slackRequest(h.app, body)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers.get('x-slack-no-retry')).toBeNull()
    expect(second.headers.get('x-slack-no-retry')).toBe('1')

    const rows = await h.db.select().from(schema.events)
    expect(rows).toHaveLength(1)
    expect(await routeJobCount(h.db, rows[0]!.id)).toBe(1)
    expect(outcome('duplicate')).toBe(1)
  })

  it('handles concurrent duplicates', async () => {
    await connectFixtureUser()
    const body = JSON.stringify(slackFixture('message_im'))
    const results = await Promise.all([1, 2, 3].map(() => slackRequest(h.app, body)))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    const rows = await h.db.select().from(schema.events)
    expect(rows).toHaveLength(1)
    expect(await routeJobCount(h.db, rows[0]!.id)).toBe(1)
  })

  it('repairs a stored event that was never enqueued', async () => {
    const conn = await connectFixtureUser()
    const id = '11111111-1111-4111-8111-111111111111'
    await h.db.insert(schema.events).values({
      id,
      provider: 'slack',
      connectionId: conn.id,
      dedupKey: 'Ev0PV52K21',
      raw: {},
      envelope: {},
      enqueuedAt: null,
    })

    const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-slack-no-retry')).toBe('1')

    const [row] = await h.db.select().from(schema.events).where(eq(schema.events.id, id))
    expect(row?.enqueuedAt).not.toBeNull()
    expect(await routeJobCount(h.db, id)).toBe(1)
    expect(h.metrics.ingressRequeued.get({ provider: 'slack' })).toBe(1)

    await slackRequest(h.app, JSON.stringify(slackFixture('message_im')))
    expect(await routeJobCount(h.db, id)).toBe(1)
  })

  it('rolls back the insert when enqueue fails', async () => {
    await connectFixtureUser()
    const send = h.queue.send.bind(h.queue)
    h.queue.send = async () => {
      throw new Error('queue down')
    }
    try {
      const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')))
      expect(res.status).toBe(500)
    } finally {
      h.queue.send = send
    }
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('error')).toBe(1)
  })

  it('returns 200 and stores nothing for an unknown connection', async () => {
    const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')))
    expect(res.status).toBe(200)
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('unknown_connection')).toBe(1)
  })

  it('returns 200 and stores nothing for a revoked connection', async () => {
    await connectFixtureUser()
    await h.connections.revokeSlack('T123ABC456', ['U2147483697'])
    const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')))
    expect(res.status).toBe(200)
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('unknown_connection')).toBe(1)
  })

  it('rejects a bad signature with 401', async () => {
    await connectFixtureUser()
    const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')), { secret: 'wrong' })
    expect(res.status).toBe(401)
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('bad_signature')).toBe(1)
  })

  it('rejects a stale timestamp with 401', async () => {
    await connectFixtureUser()
    const res = await slackRequest(h.app, JSON.stringify(slackFixture('message_im')), {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    })
    expect(res.status).toBe(401)
  })

  it('answers url_verification after verifying the signature', async () => {
    const body = JSON.stringify(slackFixture('url_verification'))
    const res = await slackRequest(h.app, body)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P')
    expect(outcome('handshake')).toBe(1)

    const forged = await slackRequest(h.app, body, { secret: 'wrong' })
    expect(forged.status).toBe(401)
  })

  it('tokens_revoked marks matching connections revoked', async () => {
    const target = await connectFixtureUser('TXXXXXXXX', 'UXXXXXXXX')
    const sameTeamOther = await connectFixtureUser('TXXXXXXXX', 'UOTHER')
    const otherTeam = await connectFixtureUser('TOTHER', 'UXXXXXXXX')

    const res = await slackRequest(h.app, JSON.stringify(slackFixture('tokens_revoked')))
    expect(res.status).toBe(200)

    const status = async (id: string) => (await h.connections.findById(id))?.status
    expect(await status(target.id)).toBe('revoked')
    expect(await status(sameTeamOther.id)).toBe('active')
    expect(await status(otherTeam.id)).toBe('active')
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('lifecycle')).toBe(1)
  })

  it('returns 400 for a signed non-JSON body', async () => {
    const res = await slackRequest(h.app, 'not json')
    expect(res.status).toBe(400)
    expect(outcome('invalid_body')).toBe(1)
  })

  it('exposes metrics in Prometheus format', async () => {
    await slackRequest(h.app, '{}', { secret: 'wrong' })
    const res = await h.app.request('/metrics')
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toContain('relay_ingress_requests_total{provider="slack",outcome="bad_signature"} 1')
  })

  it('healthz reports ok', async () => {
    const res = await h.app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await h.db.execute(sql`select 1`)).toBeTruthy()
  })
})
