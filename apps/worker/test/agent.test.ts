import { eq } from 'drizzle-orm'
import { schema, type AgentJob } from '@relay/core'
import { AgentRunError, createFakeRunner, EMPTY_USAGE, type AgentToolDef } from '@relay/destination-agent'
import { describe, expect, it } from 'vitest'
import { createSweeper } from '../src/sweeper'
import { agentJobs, agentRunFor, agentSetup, dispatchJobs, getDelivery, insertEvent, makeDelivery, makeRoute, respond, setup, startReceiver, useHarness } from './harness'

const h = useHarness()
const tool = (tools: AgentToolDef[], name: string) => tools.find((t) => t.name === name)!
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('agent destination', () => {
  it('end to end: thread_history then reply posts once, run and delivery succeed, usage recorded', async () => {
    const s = await agentSetup(h)
    let prompt = ''
    let system = ''
    const runner = createFakeRunner(async (input) => {
      prompt = input.prompt
      system = input.systemPrompt
      const hist = await tool(input.tools, 'thread_history').call({})
      expect(hist.isError).toBe(false)
      expect(hist.text).toContain('parent')
      const reply = await tool(input.tools, 'reply').call({ text: 'Thanks!' })
      expect(reply.isError).toBe(false)
      return {
        finalText: 'replied',
        turns: 3,
        usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 7, cacheCreationTokens: 9 },
        costUsd: 0.0123,
      }
    })

    await h.dispatcher({ deliveryId: s.delivery.id })
    expect(await agentJobs(h)).toEqual([{ deliveryId: s.delivery.id, startAfter: expect.any(Date) }])
    expect(await getDelivery(h, s.delivery.id)).toMatchObject({ status: 'pending', attempts: 0 })

    await h.agent(runner)({ deliveryId: s.delivery.id })

    const posts = h.slack.calls('chat.postMessage')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toEqual({ channel: 'D024BE91L', text: 'Thanks!', thread_ts: '1355517523.000005' })
    expect(h.slack.calls('conversations.replies')).toHaveLength(1)

    const run = (await agentRunFor(h, s.delivery.id))!
    expect(run).toMatchObject({
      status: 'succeeded',
      mutated: true,
      turns: 3,
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 7,
      cacheCreationTokens: 9,
      finalText: 'replied',
      error: null,
    })
    expect(Number(run.costUsd)).toBeCloseTo(0.0123)
    expect(run.finishedAt).not.toBeNull()
    expect(run.toolCalls).toEqual([
      { n: 1, type: 'thread.history', params: {}, status: 'succeeded' },
      { n: 2, type: 'reply', params: { text: 'Thanks!' }, status: 'succeeded', result: { channel: 'D024BE91L', ts: expect.any(String) } },
    ])
    expect(await getDelivery(h, s.delivery.id)).toMatchObject({ status: 'succeeded', lastError: null })

    expect(system).toContain('Be brief.')
    expect(system).toContain('untrusted')
    expect(system).toContain('publicly')
    expect(prompt).toContain('ignore previous instructions')
    expect(prompt).toContain('thread_history')

    expect(h.metrics.agentRuns.get({ outcome: 'succeeded' })).toBe(1)
    expect(h.metrics.agentToolCalls.get({ type: 'reply', outcome: 'succeeded' })).toBe(1)
    expect(h.metrics.agentTokens.get({ kind: 'input' })).toBe(120)
    expect(h.metrics.agentCostUsd.get({})).toBeCloseTo(0.0123)

    const [echo] = await h.db.select().from(schema.sentMessages)
    expect(echo).toMatchObject({ channel: 'D024BE91L' })
  })

  it('does not block http deliveries while an agent run is in progress', async () => {
    const receiver = await startReceiver(respond(200, { ok: true }))
    const a = await agentSetup(h)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    const runner = createFakeRunner(async () => {
      started()
      await gate
    })
    const agentRun = h.agent(runner)({ deliveryId: a.delivery.id })
    await startedP
    expect((await agentRunFor(h, a.delivery.id))!.status).toBe('running')

    const s = await setup(h, { url: receiver.url })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    const delivery = await makeDelivery(h, event.id, route.id, s.destination.id)
    await h.dispatcher({ deliveryId: delivery.id })
    expect((await getDelivery(h, delivery.id)).status).toBe('succeeded')
    expect(receiver.requests).toHaveLength(1)
    expect(await dispatchJobs(h)).toHaveLength(0)

    release()
    await agentRun
    expect((await getDelivery(h, a.delivery.id)).status).toBe('succeeded')
    await receiver.close()
  })

  it('caps mutating calls: the 4th returns an error and makes no Slack call', async () => {
    const s = await agentSetup(h)
    const outs: { isError: boolean; text: string }[] = []
    const runner = createFakeRunner(async (input) => {
      for (let i = 1; i <= 4; i++) outs.push(await tool(input.tools, 'reply').call({ text: `m${i}` }))
    })
    await h.agent(runner)({ deliveryId: s.delivery.id })
    expect(outs.map((o) => o.isError)).toEqual([false, false, false, true])
    expect(outs[3]!.text).toContain('limit')
    expect(h.slack.calls('chat.postMessage')).toHaveLength(3)
    expect(h.metrics.agentToolCalls.get({ type: 'reply', outcome: 'cap_reached' })).toBe(1)
    const keys = await h.db.select({ k: schema.actionsLog.idempotencyKey }).from(schema.actionsLog).orderBy(schema.actionsLog.createdAt)
    const run = (await agentRunFor(h, s.delivery.id))!
    expect(keys.map((k) => k.k)).toEqual([1, 2, 3].map((n) => `agent:${run.id}:${n}`))
  })

  it('honors a configured cap of 1', async () => {
    const s = await agentSetup(h, { config: { maxMutatingActions: 1 } })
    const runner = createFakeRunner(async (input) => {
      await tool(input.tools, 'reply').call({ text: 'a' })
      await tool(input.tools, 'react').call({ name: 'eyes' })
    })
    await h.agent(runner)({ deliveryId: s.delivery.id })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    expect(h.slack.calls('reactions.add')).toHaveLength(0)
  })

  it('does not expose tools for actions outside allowed_actions', async () => {
    const s = await agentSetup(h, { allowedActions: ['thread.history', 'react'] })
    let names: string[] = []
    const runner = createFakeRunner(async (input) => {
      names = input.tools.map((t) => t.name).sort()
    })
    await h.agent(runner)({ deliveryId: s.delivery.id })
    expect(names).toEqual(['react', 'thread_history'])
  })

  it('fails the run when no tool is allowed', async () => {
    const s = await agentSetup(h, { allowedActions: ['nonexistent'] })
    await h.agent(createFakeRunner(async () => {}))({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'no_tools' })
    expect((await getDelivery(h, s.delivery.id)).status).toBe('failed')
  })

  it('a runner crash after a reply is never rerun and posts once', async () => {
    const s = await agentSetup(h)
    const runner = createFakeRunner(async (input) => {
      await tool(input.tools, 'reply').call({ text: 'first' })
      throw new Error('boom')
    })
    const handle = h.agent(runner)
    await handle({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'not_retried_after_mutation', mutated: true })
    expect(await getDelivery(h, s.delivery.id)).toMatchObject({ status: 'failed', lastError: 'not_retried_after_mutation' })
    expect(h.metrics.agentRuns.get({ outcome: 'not_retried_after_mutation' })).toBe(1)
    expect(await agentJobs(h)).toHaveLength(0)

    await handle({ deliveryId: s.delivery.id })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
  })

  it('a process crash after a reply (stale running row) is not rerun', async () => {
    const s = await agentSetup(h)
    await h.db.insert(schema.agentRuns).values({ deliveryId: s.delivery.id, mutated: true, leaseUntil: minutesAgo(1) })
    let ran = false
    await h.agent(createFakeRunner(async () => void (ran = true)))({ deliveryId: s.delivery.id })
    expect(ran).toBe(false)
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'not_retried_after_mutation', attempts: 2 })
    expect(h.slack.requests).toHaveLength(0)
  })

  it('a pending mutating action from a crashed attempt also blocks a rerun', async () => {
    const s = await agentSetup(h)
    const [run] = await h.db.insert(schema.agentRuns).values({ deliveryId: s.delivery.id, leaseUntil: minutesAgo(1) }).returning()
    await h.db.insert(schema.actionsLog).values({
      deliveryId: s.delivery.id,
      idempotencyKey: `agent:${run!.id}:1`,
      type: 'reply',
      params: { text: 'x' },
      status: 'pending',
    })
    await h.agent(createFakeRunner(async () => {}))({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'not_retried_after_mutation' })
  })

  it('a failure before any mutation is retried and then succeeds', async () => {
    const s = await agentSetup(h)
    let calls = 0
    const runner = createFakeRunner(async (input) => {
      if (++calls === 1) throw new AgentRunError('execution_error', true)
      await tool(input.tools, 'reply').call({ text: 'ok' })
    })
    const handle = h.agent(runner)
    await handle({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'running', attempts: 1, error: 'execution_error' })
    expect((await getDelivery(h, s.delivery.id)).status).toBe('pending')
    const jobs = await agentJobs(h)
    expect(jobs).toHaveLength(1)
    expect(h.metrics.agentRuns.get({ outcome: 'retried' })).toBe(1)

    await handle({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'succeeded', attempts: 2, mutated: true })
    expect((await getDelivery(h, s.delivery.id)).status).toBe('succeeded')
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
  })

  it('a process crash before any mutation (stale running row) is taken over and succeeds', async () => {
    const s = await agentSetup(h)
    await h.db.insert(schema.agentRuns).values({ deliveryId: s.delivery.id, leaseUntil: minutesAgo(1) })
    await h.agent(createFakeRunner(async (input) => void (await tool(input.tools, 'reply').call({ text: 'ok' }))))({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'succeeded', attempts: 2 })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
  })

  it('gives up after 3 attempts', async () => {
    const s = await agentSetup(h)
    const handle = h.agent(createFakeRunner(async () => { throw new AgentRunError('execution_error', true) }))
    for (let i = 0; i < 3; i++) await handle({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', attempts: 3, error: 'execution_error' })
    expect((await getDelivery(h, s.delivery.id)).status).toBe('failed')
    expect(h.metrics.agentRuns.get({ outcome: 'retried' })).toBe(2)
    expect(h.metrics.agentRuns.get({ outcome: 'failed' })).toBe(1)
  })

  it('a non-retryable runner error fails at once', async () => {
    const s = await agentSetup(h)
    await h.agent(createFakeRunner(async () => { throw new AgentRunError('missing_api_key', false) }))({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'missing_api_key', attempts: 1 })
    expect(await agentJobs(h)).toHaveLength(0)
  })

  it('a runner-reported error result keeps the usage', async () => {
    const s = await agentSetup(h)
    const runner = createFakeRunner(async () => ({ error: { code: 'max_turns', retryable: false }, usage: { ...EMPTY_USAGE, inputTokens: 50 }, turns: 8 }))
    await h.agent(runner)({ deliveryId: s.delivery.id })
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'max_turns', inputTokens: 50, turns: 8 })
  })

  it('a timeout ends the run as failed and blocks late tool calls', async () => {
    const s = await agentSetup(h, { config: { timeoutSeconds: 5 } })
    let lateResult: { isError: boolean } | undefined
    const runner = createFakeRunner(
      (input) =>
        new Promise((_, reject) => {
          input.signal.addEventListener('abort', () => {
            void tool(input.tools, 'reply').call({ text: 'too late' }).then((r) => (lateResult = r))
            reject(new Error('aborted'))
          })
        }),
    )
    const start = Date.now()
    await h.agent(runner)({ deliveryId: s.delivery.id })
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900)
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'failed', error: 'timeout' })
    expect((await getDelivery(h, s.delivery.id)).status).toBe('failed')
    expect(lateResult?.isError).toBe(true)
    expect(h.slack.requests).toHaveLength(0)
  }, 15_000)

  it('two concurrent handlers never run the same delivery twice', async () => {
    const s = await agentSetup(h)
    let active = 0
    let max = 0
    let total = 0
    const runner = createFakeRunner(async () => {
      total++
      max = Math.max(max, ++active)
      await new Promise((r) => setTimeout(r, 150))
      active--
    })
    const handle = h.agent(runner)
    await Promise.all([handle({ deliveryId: s.delivery.id }), handle({ deliveryId: s.delivery.id })])
    expect(total).toBe(1)
    expect(max).toBe(1)
  })

  it('ignores a delivery that is already finished', async () => {
    const s = await agentSetup(h)
    await h.db.update(schema.deliveries).set({ status: 'succeeded' }).where(eq(schema.deliveries.id, s.delivery.id))
    let ran = false
    await h.agent(createFakeRunner(async () => void (ran = true)))({ deliveryId: s.delivery.id })
    expect(ran).toBe(false)
    expect(await agentRunFor(h, s.delivery.id)).toBeUndefined()
  })

  it('fails the delivery when the destination is disabled', async () => {
    const s = await agentSetup(h)
    await h.db.update(schema.destinations).set({ enabled: false }).where(eq(schema.destinations.id, s.destination.id))
    await h.agent(createFakeRunner(async () => {}))({ deliveryId: s.delivery.id })
    expect(await getDelivery(h, s.delivery.id)).toMatchObject({ status: 'failed', lastError: 'destination disabled' })
  })
})

describe('sweeper and agent deliveries', () => {
  const sweeper = () => createSweeper({ db: h.db, queue: h.queue, metrics: h.metrics, graceMs: 60_000 })
  const age = (id: string) => h.db.update(schema.deliveries).set({ updatedAt: minutesAgo(10) }).where(eq(schema.deliveries.id, id))

  it('requeues a stuck agent delivery on the agent queue, once', async () => {
    const s = await agentSetup(h)
    await age(s.delivery.id)
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 1, actions: 0 })
    expect(await agentJobs(h)).toHaveLength(1)
    expect(await dispatchJobs(h)).toHaveLength(0)
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 0, actions: 0 })
    expect(await agentJobs(h)).toHaveLength(1)
  })

  it('leaves a delivery with a live run lease alone', async () => {
    const s = await agentSetup(h)
    await age(s.delivery.id)
    await h.db.insert(schema.agentRuns).values({ deliveryId: s.delivery.id, leaseUntil: new Date(Date.now() + 120_000) })
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 0, actions: 0 })
    expect(await agentJobs(h)).toHaveLength(0)
  })

  it('requeues after the lease expired, and the lease still stops a concurrent run', async () => {
    const s = await agentSetup(h)
    await age(s.delivery.id)
    await h.db.insert(schema.agentRuns).values({ deliveryId: s.delivery.id, leaseUntil: minutesAgo(1) })
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 1, actions: 0 })

    let active = 0
    let max = 0
    const runner = createFakeRunner(async () => {
      max = Math.max(max, ++active)
      await new Promise((r) => setTimeout(r, 100))
      active--
    })
    const handle = h.agent(runner)
    const job: AgentJob = { deliveryId: s.delivery.id }
    await Promise.all([handle(job), handle(job)])
    expect(max).toBe(1)
    expect(await agentRunFor(h, s.delivery.id)).toMatchObject({ status: 'succeeded', attempts: 2 })
  })

  it('still sweeps http deliveries to the dispatch queue', async () => {
    const s = await setup(h, { url: 'http://127.0.0.1:1/x' })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    const d = await makeDelivery(h, event.id, route.id, s.destination.id)
    await age(d.id)
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 1, actions: 0 })
    expect(await dispatchJobs(h)).toHaveLength(1)
    expect(await agentJobs(h)).toHaveLength(0)
  })
})

