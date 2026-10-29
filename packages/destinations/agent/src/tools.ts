import { and, eq, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  computeAllowed,
  schema,
  type ActionExecutor,
  type ActionResult,
  type ExecuteHooks,
  type Db,
  type ProviderRuntime,
} from '@relay/core'
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

  const record = (rec: Omit<ToolCallRecord, 'n'>) => {
    calls.push({ n: calls.length + 1, ...rec })
    deps.onToolCall?.(rec.type, rec.status)
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
