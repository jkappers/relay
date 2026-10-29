import {
  ActionError,
  defineAction,
  hasSentMessage,
  parseRetryAfterMs,
  type ActionContext,
  type Db,
  type ProviderRuntime,
} from '@relay/core'
import { z } from 'zod'

export const DEFAULT_SLACK_API_BASE_URL = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 15_000

// Documented as transient on docs.slack.dev, so retrying is safe.
const RETRYABLE_SLACK_ERRORS = new Set(['ratelimited', 'rate_limited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])

export interface SlackRuntimeDeps {
  db: Db
  apiBase?: string
}

const text = z.string().min(1).max(40_000)

function target(ctx: ActionContext) {
  const channel = ctx.envelope.context.channelId
  if (!channel) throw new ActionError('no_channel_context', false)
  return { channel, threadTs: ctx.envelope.context.threadId ?? ctx.envelope.context.messageId }
}

export function createSlackRuntime(deps: SlackRuntimeDeps): ProviderRuntime {
  const apiBase = (deps.apiBase ?? DEFAULT_SLACK_API_BASE_URL).replace(/\/+$/, '')

  async function call(
    ctx: ActionContext,
    method: string,
    args: Record<string, unknown>,
    httpMethod: 'POST' | 'GET' = 'POST',
  ): Promise<Record<string, unknown>> {
    const token = ctx.credentials.slack_user_token
    if (!token) throw new ActionError('no_credentials', false)
    let res: Response
    try {
      if (httpMethod === 'GET') {
        const url = new URL(`${apiBase}/${method}`)
        for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v))
        res = await ctx.fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      } else {
        res = await ctx.fetch(`${apiBase}/${method}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      }
    } catch {
      throw new ActionError('network_error', true)
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {})
      throw new ActionError('ratelimited', true, retryAfterMs)
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => {})
      throw new ActionError(`http_${res.status}`, true)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new ActionError(res.ok ? 'bad_response' : `http_${res.status}`, res.ok)
    }
    if (!res.ok) throw new ActionError(`http_${res.status}`, false)
    const parsed = z.looseObject({ ok: z.boolean(), error: z.string().optional() }).safeParse(body)
    if (!parsed.success) throw new ActionError('bad_response', true)
    if (!parsed.data.ok) {
      const code = parsed.data.error ?? 'unknown_error'
      throw new ActionError(code, RETRYABLE_SLACK_ERRORS.has(code), RETRYABLE_SLACK_ERRORS.has(code) ? retryAfterMs : null)
    }
    return parsed.data
  }

  const posted = (data: Record<string, unknown>, fallbackChannel: string) => {
    const ts = typeof data.ts === 'string' ? data.ts : null
    if (!ts) throw new ActionError('bad_response', false)
    const channel = typeof data.channel === 'string' ? data.channel : fallbackChannel
    return { result: { channel, ts }, sentMessage: { channel, ts } }
  }

  return {
    id: 'slack',
    actions: {
      reply: defineAction({
        mutating: true,
        params: z.object({ text }),
        async run(ctx, p) {
          const { channel, threadTs } = target(ctx)
          if (!threadTs) throw new ActionError('no_thread_context', false)
          return posted(await call(ctx, 'chat.postMessage', { channel, text: p.text, thread_ts: threadTs }), channel)
        },
      }),
      post: defineAction({
        mutating: true,
        params: z.object({ text }),
        async run(ctx, p) {
          const { channel } = target(ctx)
          return posted(await call(ctx, 'chat.postMessage', { channel, text: p.text }), channel)
        },
      }),
      react: defineAction({
        mutating: true,
        params: z.object({ name: z.string().regex(/^[A-Za-z0-9_+'-]+(::skin-tone-[2-6])?$/).max(100) }),
        async run(ctx, p) {
          const { channel } = target(ctx)
          const timestamp = ctx.envelope.context.messageId
          if (!timestamp) throw new ActionError('no_message_context', false)
          try {
            await call(ctx, 'reactions.add', { channel, timestamp, name: p.name })
          } catch (err) {
            if (err instanceof ActionError && err.code === 'already_reacted') return { result: { alreadyReacted: true } }
            throw err
          }
          return { result: {} }
        },
      }),
      update: defineAction({
        mutating: true,
        params: z.object({ messageId: z.string().min(1).max(40), text }),
        async run(ctx, p) {
          const { channel } = target(ctx)
          if (!(await hasSentMessage(deps.db, ctx.connection.id, channel, p.messageId))) {
            throw new ActionError('message_not_sent_by_relay', false)
          }
          const data = await call(ctx, 'chat.update', { channel, ts: p.messageId, text: p.text })
          return { result: { channel: typeof data.channel === 'string' ? data.channel : channel, ts: p.messageId } }
        },
      }),
      'thread.history': defineAction({
        mutating: false,
        params: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
        async run(ctx, p) {
          const { channel, threadTs } = target(ctx)
          if (!threadTs) throw new ActionError('no_thread_context', false)
          const data = await call(ctx, 'conversations.replies', { channel, ts: threadTs, limit: p.limit }, 'GET')
          const raw = Array.isArray(data.messages) ? data.messages : []
          const messages = raw.slice(0, p.limit).map((m) => {
            const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
            const str = (v: unknown) => (typeof v === 'string' ? v : null)
            return { ts: str(o.ts), user: str(o.user), text: str(o.text), thread_ts: str(o.thread_ts) }
          })
          return { result: { messages, hasMore: data.has_more === true } }
        },
      }),
    },

    async isSelfEcho(envelope, connection) {
      const { channelId, messageId } = envelope.context
      if (!channelId || !messageId) return false
      return hasSentMessage(deps.db, connection.id, channelId, messageId)
    },
  }
}
