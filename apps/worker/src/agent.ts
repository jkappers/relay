import { and, eq, like, lt, sql } from 'drizzle-orm'
import {
  agentConfigSchema,
  AGENT_LEASE_GRACE_SECONDS,
  computeBackoffMs,
  log,
  MAX_AGENT_ATTEMPTS,
  QUEUES,
  schema,
  type ActionExecutor,
  type AgentConfig,
  type AgentJob,
  type Db,
  type Envelope,
  type ProviderRuntime,
  type Queue,
} from '@relay/core'
import {
  AgentRunError,
  buildSystemPrompt,
  buildUserPrompt,
  createToolkit,
  type AgentRunResult,
  type AgentRunner,
  type AgentUsage,
  type ToolCallRecord,
} from '@relay/destination-agent'
import type { WorkerMetrics } from './metrics'

export interface AgentHandlerDeps {
  db: Db
  queue: Queue
  metrics: WorkerMetrics
  execute: ActionExecutor
  runtimes: Record<string, ProviderRuntime>
  runner: AgentRunner
  backoffBaseMs: number
  backoffCapMs: number
  random?: () => number
}

type Failure = { code: string; retryable: boolean }

const ZERO_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

export function createAgentHandler(deps: AgentHandlerDeps) {
  const { db, queue, metrics } = deps
  const runs = schema.agentRuns
  const deliveries = schema.deliveries

  async function failDelivery(deliveryId: string, error: string) {
    const now = new Date()
    await db
      .update(deliveries)
      .set({ status: 'failed', lastError: error, completedAt: now, nextAttemptAt: null, updatedAt: now })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, 'pending')))
    metrics.agentRuns.inc({ outcome: 'failed' })
  }

  async function claim(deliveryId: string, config: AgentConfig) {
    const now = new Date()
    const leaseUntil = new Date(now.getTime() + (config.timeoutSeconds + AGENT_LEASE_GRACE_SECONDS) * 1000)
    const [inserted] = await db
      .insert(runs)
      .values({ deliveryId, status: 'running', attempts: 1, startedAt: now, leaseUntil })
      .onConflictDoNothing({ target: runs.deliveryId })
      .returning()
    if (inserted) return inserted
    const [took] = await db
      .update(runs)
      .set({ attempts: sql`${runs.attempts} + 1`, leaseUntil })
      .where(and(eq(runs.deliveryId, deliveryId), eq(runs.status, 'running'), lt(runs.leaseUntil, now)))
      .returning()
    return took ?? null
  }

  // A mutating action that is pending may already have reached Slack (lost response), so it counts.
  async function mayHaveMutated(run: schema.AgentRunRow): Promise<boolean> {
    const [fresh] = await db.select({ mutated: runs.mutated }).from(runs).where(eq(runs.id, run.id))
    if (fresh?.mutated) return true
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.actionsLog)
      .where(
        and(
          eq(schema.actionsLog.deliveryId, run.deliveryId),
          like(schema.actionsLog.idempotencyKey, `agent:${run.id}:%`),
          sql`${schema.actionsLog.status} in ('pending', 'succeeded')`,
        ),
      )
    return (row?.n ?? 0) > 0
  }

  function recordUsage(result: AgentRunResult | null) {
    if (!result) return
    metrics.agentTokens.inc({ kind: 'input' }, result.usage.inputTokens)
    metrics.agentTokens.inc({ kind: 'output' }, result.usage.outputTokens)
    metrics.agentTokens.inc({ kind: 'cache_read' }, result.usage.cacheReadTokens)
    metrics.agentTokens.inc({ kind: 'cache_creation' }, result.usage.cacheCreationTokens)
    metrics.agentCostUsd.inc({}, result.costUsd)
  }

  const usageSet = (result: AgentRunResult | null, calls: ToolCallRecord[]) => {
    const u = result?.usage ?? ZERO_USAGE
    return {
      turns: sql`${runs.turns} + ${result?.turns ?? 0}`,
      inputTokens: sql`${runs.inputTokens} + ${u.inputTokens}`,
      outputTokens: sql`${runs.outputTokens} + ${u.outputTokens}`,
      cacheReadTokens: sql`${runs.cacheReadTokens} + ${u.cacheReadTokens}`,
      cacheCreationTokens: sql`${runs.cacheCreationTokens} + ${u.cacheCreationTokens}`,
      costUsd: sql`${runs.costUsd} + ${(result?.costUsd ?? 0).toFixed(6)}::numeric`,
      toolCalls: sql`${runs.toolCalls} || ${JSON.stringify(calls)}::jsonb`,
    }
  }

  async function finish(
    run: schema.AgentRunRow,
    outcome: { ok: true } | { ok: false; error: string },
    result: AgentRunResult | null,
    calls: ToolCallRecord[],
  ) {
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({
          status: outcome.ok ? 'succeeded' : 'failed',
          finishedAt: now,
          error: outcome.ok ? null : outcome.error,
          finalText: result?.finalText ?? null,
          ...usageSet(result, calls),
        })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'running')))
      await tx
        .update(deliveries)
        .set({
          status: outcome.ok ? 'succeeded' : 'failed',
          attempts: run.attempts,
          lastError: outcome.ok ? null : outcome.error,
          nextAttemptAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(deliveries.id, run.deliveryId), eq(deliveries.status, 'pending')))
    })
    recordUsage(result)
  }

  async function scheduleRetry(run: schema.AgentRunRow, failure: Failure, result: AgentRunResult | null, calls: ToolCallRecord[]) {
    const now = new Date()
    const delayMs = computeBackoffMs(run.attempts, {
      baseMs: deps.backoffBaseMs,
      capMs: deps.backoffCapMs,
      ...(deps.random ? { random: deps.random } : {}),
    })
    const nextAttemptAt = new Date(now.getTime() + delayMs)
    await db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({ leaseUntil: new Date(0), error: failure.code, ...usageSet(result, calls) })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'running')))
      await tx
        .update(deliveries)
        .set({ attempts: run.attempts, lastError: failure.code, nextAttemptAt, updatedAt: now })
        .where(eq(deliveries.id, run.deliveryId))
      await queue.send<AgentJob>(QUEUES.agent, { deliveryId: run.deliveryId }, { tx, startAfter: nextAttemptAt, singletonKey: run.deliveryId })
    })
    recordUsage(result)
    metrics.agentRuns.inc({ outcome: 'retried' })
  }

  async function settleFailure(run: schema.AgentRunRow, failure: Failure, result: AgentRunResult | null, calls: ToolCallRecord[]) {
    if (await mayHaveMutated(run)) {
      await finish(run, { ok: false, error: 'not_retried_after_mutation' }, result, calls)
      metrics.agentRuns.inc({ outcome: 'not_retried_after_mutation' })
      log.warn('agent: run failed after a change, not retried', { deliveryId: run.deliveryId, runId: run.id, code: failure.code })
      return
    }
    if (failure.retryable && run.attempts < MAX_AGENT_ATTEMPTS) {
      await scheduleRetry(run, failure, result, calls)
      log.warn('agent: run failed, retry scheduled', { deliveryId: run.deliveryId, runId: run.id, attempt: run.attempts, code: failure.code })
      return
    }
    await finish(run, { ok: false, error: failure.code }, result, calls)
    metrics.agentRuns.inc({ outcome: 'failed' })
    log.warn('agent: run failed', { deliveryId: run.deliveryId, runId: run.id, code: failure.code })
  }

  return async function handle(job: AgentJob): Promise<void> {
    const [row] = await db
      .select({ delivery: deliveries, destination: schema.destinations, event: schema.events, connection: schema.connections })
      .from(deliveries)
      .innerJoin(schema.destinations, eq(schema.destinations.id, deliveries.destinationId))
      .innerJoin(schema.events, eq(schema.events.id, deliveries.eventId))
      .innerJoin(schema.connections, eq(schema.connections.id, schema.events.connectionId))
      .where(eq(deliveries.id, job.deliveryId))
    if (!row) {
      log.warn('agent: delivery not found', { deliveryId: job.deliveryId })
      return
    }
    const { delivery, destination, event, connection } = row
    if (delivery.status !== 'pending' || destination.kind !== 'agent') return

    if (!destination.enabled) return failDelivery(delivery.id, 'destination disabled')
    const parsed = agentConfigSchema.safeParse(destination.config)
    if (!parsed.success) return failDelivery(delivery.id, 'invalid_agent_config')
    const config = parsed.data
    const runtime = deps.runtimes[event.provider]
    if (!runtime || connection.status !== 'active') {
      return failDelivery(delivery.id, runtime ? 'connection_inactive' : 'unknown_provider')
    }

    const run = await claim(delivery.id, config)
    if (!run) return
    await db.update(deliveries).set({ updatedAt: new Date() }).where(eq(deliveries.id, delivery.id))

    if (run.attempts > 1 && (await mayHaveMutated(run))) {
      await finish(run, { ok: false, error: 'not_retried_after_mutation' }, null, [])
      metrics.agentRuns.inc({ outcome: 'not_retried_after_mutation' })
      log.warn('agent: run found after a crash with changes made, not retried', { deliveryId: delivery.id, runId: run.id })
      return
    }
    if (run.attempts > MAX_AGENT_ATTEMPTS) {
      await finish(run, { ok: false, error: 'max_attempts' }, null, [])
      metrics.agentRuns.inc({ outcome: 'failed' })
      return
    }

    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, config.timeoutSeconds * 1000)

    const toolkit = await createToolkit({
      db,
      execute: deps.execute,
      runtime,
      allowedActions: destination.allowedActions,
      deliveryId: delivery.id,
      runId: run.id,
      maxMutatingActions: config.maxMutatingActions,
      signal: abort.signal,
      onToolCall: (type, outcome) => metrics.agentToolCalls.inc({ type, outcome }),
    })

    let result: AgentRunResult | null = null
    let failure: Failure | null = null
    if (toolkit.tools.length === 0) {
      failure = { code: 'no_tools', retryable: false }
    } else {
      const aborted = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new AgentRunError('timeout', false)), { once: true })
      })
      aborted.catch(() => {})
      const running = deps.runner.run({
        model: config.model,
        systemPrompt: buildSystemPrompt(config.systemPrompt, toolkit.tools, config.maxMutatingActions),
        prompt: buildUserPrompt(event.envelope as Envelope, toolkit.tools.some((t) => t.action === 'thread.history')),
        maxTurns: config.maxTurns,
        tools: toolkit.tools,
        signal: abort.signal,
        onToolDenied: () => metrics.agentToolCalls.inc({ type: 'other', outcome: 'denied' }),
      })
      running.catch(() => {})
      try {
        result = await Promise.race([running, aborted])
        if (result.error) failure = result.error
      } catch (err) {
        failure =
          err instanceof AgentRunError
            ? { code: err.code, retryable: err.retryable }
            : { code: timedOut ? 'timeout' : 'runner_error', retryable: !timedOut }
        if (!(err instanceof AgentRunError)) log.error('agent: runner threw', { deliveryId: delivery.id, err: err instanceof Error ? err.name : 'unknown' })
      }
    }
    clearTimeout(timer)
    toolkit.close()
    abort.abort()
    await toolkit.settled()

    if (failure) await settleFailure(run, failure, result, toolkit.calls)
    else {
      await finish(run, { ok: true }, result, toolkit.calls)
      metrics.agentRuns.inc({ outcome: 'succeeded' })
    }
  }
}
