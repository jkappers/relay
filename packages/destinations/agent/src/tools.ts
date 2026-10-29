import { and, eq, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  computeAllowed,
  exampleToolArgs,
  schema,
  toolParamsToZodShape,
  type Envelope,
  type ActionExecutor,
  type ActionResult,
  type ExecuteHooks,
  type Db,
  type ProviderRuntime,
} from '@relay/core'
import {
  callToolDestination,
  preflightToolCall,
  renderToolError,
  renderToolSuccess,
  toolRequestBody,
  type ToolDestinationOutcome,
  type ToolDestinationSpec,
  type ToolResponse,
} from './tool-destination'
import type { AgentToolDef, AgentToolResult } from './types'

export const MAX_TOOL_RESULT_CHARS = 100_000

// Fallbacks for actions whose runtime gives no description of its own. Slack's wording.
const DESCRIPTIONS: Record<string, string> = {
  reply: 'Post a reply in the thread of the event, as the user.',
  post: 'Post a new message in the channel of the event (not in a thread), as the user.',
  react: 'Add an emoji reaction to the event message. Pass the emoji name without colons.',
  update: 'Edit a message that Relay sent earlier. messageId is the id of that message (in Slack, its ts).',
  'thread.history': 'Read earlier messages in the thread of the event.',
}

export const toolNameForAction = (action: string) => action.replace(/\./g, '_')

export type ToolOutcome = 'succeeded' | 'failed' | 'retry' | 'cap_reached' | 'denied'

export interface ToolCallRecord {
  n: number
  type: string
  params: unknown
  status: ToolOutcome
  error?: string
  result?: unknown
  destinationId?: string
}

export interface ToolkitDeps {
  db: Db
  execute: ActionExecutor
  runtime: ProviderRuntime
  allowedActions: readonly string[] | null
  deliveryId: string
  runId: string
  maxMutatingActions: number
  signal: AbortSignal
  onToolCall?: (type: string, outcome: ToolOutcome) => void
  /** Already checked by the caller: same connection, enabled, and allowed for this actor. */
  toolDestinations?: readonly ToolDestinationSpec[]
  envelope?: Envelope
  eventId?: string
  fetch?: typeof fetch
  nowSeconds?: () => number
  onToolDestinationCall?: (outcome: ToolDestinationOutcome) => void
  onToolWithheld?: (reason: 'name_collision') => void
}

export interface Toolkit {
  tools: AgentToolDef[]
  calls: ToolCallRecord[]
  /** Resolves once no tool call is still in flight. */
  settled(): Promise<void>
  /** After this, every tool call is refused. */
  close(): void
}

function shapeOf(params: z.ZodType): z.ZodRawShape | null {
  const shape = (params as { shape?: unknown }).shape
  return shape && typeof shape === 'object' ? (shape as z.ZodRawShape) : null
}

function renderResult(r: ActionResult, mutating: boolean): { text: string; isError: boolean } {
  if (r.status === 'succeeded') {
    const text = JSON.stringify(mutating ? { ok: true, result: r.result ?? null } : (r.result ?? null))
    return { text: text.slice(0, MAX_TOOL_RESULT_CHARS), isError: false }
  }
  const hint = r.status === 'retry' ? ' (temporary, you may try once more)' : ''
  return { text: `error: ${r.error ?? r.status}${hint}`, isError: true }
}

function idsOnly(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  const o = result as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['channel', 'ts', 'messageId']) if (typeof o[k] === 'string') out[k] = o[k]
  return Object.keys(out).length ? out : undefined
}

export async function createToolkit(deps: ToolkitDeps): Promise<Toolkit> {
  const { db, runtime } = deps
  const allowed = computeAllowed(runtime, deps.allowedActions)
  const calls: ToolCallRecord[] = []
  const inflight = new Set<Promise<unknown>>()
  let closed = false

  const prior = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actionsLog)
    .where(and(eq(schema.actionsLog.deliveryId, deps.deliveryId), like(schema.actionsLog.idempotencyKey, `agent:${deps.runId}:%`)))
  let mutatingCalls = prior[0]?.n ?? 0

  const markMutated: NonNullable<ExecuteHooks['onMutationSucceeded']> = async (tx) => {
    await tx.update(schema.agentRuns).set({ mutated: true }).where(eq(schema.agentRuns.id, deps.runId))
  }

  const record = (rec: Omit<ToolCallRecord, 'n'>, metricType = rec.type) => {
    calls.push({ n: calls.length + 1, ...rec })
    deps.onToolCall?.(metricType, rec.status)
  }

  const tools: AgentToolDef[] = []
  for (const action of allowed) {
    const def = runtime.actions[action]
    const shape = def ? shapeOf(def.params) : null
    if (!def || !shape) continue

    const run = async (args: Record<string, unknown>): Promise<AgentToolResult> => {
      if (closed || deps.signal.aborted) {
        record({ type: action, params: args, status: 'denied', error: 'run_closed' })
        return { isError: true, text: 'error: this run has ended' }
      }
      if (!def.mutating) {
        const [r] = await deps.execute(deps.deliveryId, [{ ...args, type: action }], 'agent')
        const res = r ?? { type: action, status: 'failed' as const, error: 'internal_error' }
        record({ type: action, params: args, status: res.status === 'succeeded' ? 'succeeded' : res.status === 'retry' ? 'retry' : 'failed', ...(res.error ? { error: res.error } : {}) })
        return renderResult(res, false)
      }
      if (mutatingCalls >= deps.maxMutatingActions) {
        record({ type: action, params: args, status: 'cap_reached' })
        return { isError: true, text: `error: limit reached, at most ${deps.maxMutatingActions} changes per run. Stop and finish.` }
      }
      const key = `agent:${deps.runId}:${++mutatingCalls}`
      const [r] = await deps.execute(deps.deliveryId, [{ ...args, type: action, idempotencyKey: key }], 'agent', {
        onMutationSucceeded: markMutated,
      })
      const res = r ?? { type: action, status: 'failed' as const, error: 'internal_error' }
      const ids = idsOnly(res.result)
      record({
        type: action,
        params: args,
        status: res.status === 'succeeded' ? 'succeeded' : res.status === 'retry' ? 'retry' : 'failed',
        ...(res.error ? { error: res.error } : {}),
        ...(ids ? { result: ids } : {}),
      })
      return renderResult(res, true)
    }

    tools.push({
      name: toolNameForAction(action),
      action,
      description: def.description ?? DESCRIPTIONS[action] ?? `Relay action ${action}.`,
      shape,
      mutating: def.mutating,
      call(args) {
        const p = run(args).catch((): AgentToolResult => {
          record({ type: action, params: args, status: 'failed', error: 'internal_error' })
          return { isError: true, text: 'error: internal_error' }
        })
        inflight.add(p)
        void p.finally(() => inflight.delete(p))
        return p
      },
    })
  }

  const doFetch = deps.fetch ?? fetch
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const { raw: _raw, ...event } = deps.envelope ?? ({ raw: null } as unknown as Envelope)
  const taken = new Set(tools.map((t) => t.name))
  let readCalls = 0

  for (const spec of deps.toolDestinations ?? []) {
    const name = spec.config.toolName
    if (taken.has(name)) {
      deps.onToolWithheld?.('name_collision')
      continue
    }
    taken.add(name)
    const shape = toolParamsToZodShape(spec.config.params)
    const argsSchema = z.object(shape).strict()
    const type = `tool:${name}`
    const done = (rec: Omit<ToolCallRecord, 'n' | 'type' | 'destinationId'>, outcome: ToolDestinationOutcome) => {
      record({ type, destinationId: spec.id, ...rec }, 'tool')
      deps.onToolDestinationCall?.(outcome)
    }

    const run = async (rawArgs: Record<string, unknown>): Promise<AgentToolResult> => {
      if (closed || deps.signal.aborted) {
        done({ params: rawArgs, status: 'denied', error: 'run_closed' }, 'blocked')
        return { isError: true, text: 'error: this run has ended' }
      }
      const parsed = argsSchema.safeParse(rawArgs)
      if (!parsed.success) {
        const where = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'args'))].slice(0, 5).join(', ')
        done({ params: rawArgs, status: 'failed', error: 'invalid_args' }, 'invalid')
        return { isError: true, text: `error: invalid arguments (${where})` }
      }
      const args = parsed.data as Record<string, unknown>
      const mutating = spec.config.mutating
      if (mutating && mutatingCalls >= deps.maxMutatingActions) {
        done({ params: args, status: 'cap_reached' }, 'blocked')
        return { isError: true, text: `error: limit reached, at most ${deps.maxMutatingActions} changes per run. Stop and finish.` }
      }
      const n = mutating ? ++mutatingCalls : ++readCalls
      const req = {
        deliveryId: deps.deliveryId,
        eventId: deps.eventId ?? '',
        runId: deps.runId,
        call: n,
        idempotencyKey: mutating ? `agent:${deps.runId}:${n}` : `agent:${deps.runId}:r${n}`,
        args,
        event: event as Omit<Envelope, 'raw'>,
      }
      const body = toolRequestBody(spec, req)
      const opts = { fetch: doFetch, nowSeconds, signal: deps.signal }

      let res: ToolResponse | null = preflightToolCall(spec, body)
      if (res) {
        if (mutating) mutatingCalls--
      } else if (!mutating) {
        res = await callToolDestination(spec, body, req, opts)
      } else {
        const [logged] = await db
          .insert(schema.actionsLog)
          .values({ deliveryId: deps.deliveryId, idempotencyKey: req.idempotencyKey, type, params: args, status: 'pending' })
          .onConflictDoNothing({ target: [schema.actionsLog.deliveryId, schema.actionsLog.idempotencyKey] })
          .returning({ id: schema.actionsLog.id })
        if (!logged) {
          done({ params: args, status: 'failed', error: 'idempotency_key_conflict' }, 'blocked')
          return { isError: true, text: 'error: internal_error' }
        }
        const r = await callToolDestination(spec, body, req, opts)
        res = r
        const at = new Date()
        const acted = r.outcome === 'ok' || (r.sent && r.outcome !== 'http_3xx' && r.outcome !== 'http_4xx')
        await db.transaction(async (tx) => {
          await tx
            .update(schema.actionsLog)
            .set(
              r.outcome === 'ok'
                ? { status: 'succeeded', result: { status: r.status }, error: null, updatedAt: at }
                : { status: 'failed', error: r.status !== null ? `${r.outcome}:${r.status}` : r.outcome, updatedAt: at },
            )
            .where(eq(schema.actionsLog.id, logged.id))
          if (acted) await markMutated(tx, type)
        })
      }

      if (res.outcome === 'ok') {
        done({ params: args, status: 'succeeded', result: { status: res.status } }, 'ok')
        return { isError: false, text: renderToolSuccess(name, res.text) }
      }
      done({ params: args, status: 'failed', error: res.outcome, ...(res.status !== null ? { result: { status: res.status } } : {}) }, res.outcome)
      return { isError: true, text: renderToolError(res) }
    }

    tools.push({
      name,
      action: type,
      kind: 'tool',
      description: spec.config.description,
      shape,
      mutating: spec.config.mutating,
      example: exampleToolArgs(spec.config.params),
      call(args) {
        const p = run(args).catch((): AgentToolResult => {
          done({ params: args, status: 'failed', error: 'internal_error' }, 'error')
          return { isError: true, text: 'error: internal_error' }
        })
        inflight.add(p)
        void p.finally(() => inflight.delete(p))
        return p
      },
    })
  }

  return {
    tools,
    calls,
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
    close() {
      closed = true
    },
  }
}
