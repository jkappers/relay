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

export const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10'
export const DISCORD_USER_AGENT = 'DiscordBot (https://github.com/jkappers/relay, 1.0)'
const REQUEST_TIMEOUT_MS = 15_000

/** Bot sends never ping anyone, so an agent cannot reach @everyone, roles, or users. */
export const NO_MENTIONS = { parse: [] as string[] }

// docs.discord.com/developers/topics/opcodes-and-status-codes#json-json-error-codes
const ERROR_CODES: Record<number, string> = {
  10003: 'unknown_channel',
  10008: 'unknown_message',
  10014: 'unknown_emoji',
  50001: 'missing_access',
  50005: 'not_own_message',
  50007: 'cannot_message_user',
  50013: 'missing_permissions',
  50035: 'invalid_form_body',
  160002: 'reply_needs_read_history',
}

export interface DiscordRuntimeDeps {
  db: Db
  /** App-level bot token. Without it every action fails with no_credentials. */
  botToken?: string | undefined
  apiBase?: string | undefined
  fetch?: typeof fetch
}

const text = z.string().min(1).max(2000)
const snowflake = z.string().regex(/^\d{1,20}$/)
// A Unicode emoji, or name:id for a custom one. Encoded into the URL path when sent.
const emoji = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => /^[A-Za-z0-9_]{2,32}:\d{1,20}$/.test(v) || !/[\s/?#%:A-Za-z]/.test(v), 'unicode emoji or name:id')
  .describe('A Unicode emoji such as 👍, or name:id for a custom server emoji.')

function target(ctx: ActionContext) {
  const channel = ctx.envelope.context.channelId
  if (!channel) throw new ActionError('no_channel_context', false)
  return channel
}

function retryAfterMs(res: Response, body: unknown): number | null {
  const fromBody = body && typeof body === 'object' ? (body as { retry_after?: unknown }).retry_after : undefined
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody * 1000)
  const header = parseRetryAfterMs(res.headers.get('retry-after'))
  if (header !== null) return header
  const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'))
  return res.headers.has('x-ratelimit-reset-after') && Number.isFinite(resetAfter) && resetAfter >= 0 ? Math.ceil(resetAfter * 1000) : null
}

export function createDiscordRuntime(deps: DiscordRuntimeDeps): ProviderRuntime {
  const apiBase = (deps.apiBase ?? DEFAULT_DISCORD_API_BASE_URL).replace(/\/+$/, '')
  let botUserId: Promise<string | null> | null = null

  async function call(doFetch: typeof fetch, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    if (!deps.botToken) throw new ActionError('no_credentials', false)
    let res: Response
    try {
      res = await doFetch(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bot ${deps.botToken}`,
          'user-agent': DISCORD_USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new ActionError('network_error', true)
    }
    if (res.status === 204) return {}
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      if (res.ok) throw new ActionError('bad_response', true)
    }
    if (res.status === 429) throw new ActionError('ratelimited', true, retryAfterMs(res, data))
    if (res.status >= 500) throw new ActionError(`http_${res.status}`, true)
    if (!res.ok) {
      const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
      if (typeof code === 'number' && code !== 0) throw new ActionError(ERROR_CODES[code] ?? `discord_${code}`, false)
      throw new ActionError(`http_${res.status}`, false)
    }
    return data
  }

  const posted = (data: unknown, channel: string) => {
    const id = data && typeof data === 'object' ? (data as { id?: unknown }).id : undefined
    if (typeof id !== 'string') throw new ActionError('bad_response', false)
    return { result: { channel, messageId: id }, sentMessage: { channel, ts: id } }
  }

  const route = (channel: string) => `/channels/${encodeURIComponent(channel)}/messages`

  return {
    id: 'discord',
    echoRecheck: false,
    actions: {
      reply: defineAction({
        mutating: true,
        description: 'Reply to the event message, as the Relay bot. Everyone in the channel sees it.',
        params: z.object({ text }),
        async run(ctx, p) {
          const channel = target(ctx)
          const messageId = ctx.envelope.context.messageId
          if (!messageId) throw new ActionError('no_message_context', false)
          const data = await call(ctx.fetch, 'POST', route(channel), {
            content: p.text,
            allowed_mentions: NO_MENTIONS,
            message_reference: { message_id: messageId, fail_if_not_exists: false },
          })
          return posted(data, channel)
        },
      }),
      post: defineAction({
        mutating: true,
        description: 'Post a new message in the channel of the event, as the Relay bot. Everyone in the channel sees it.',
        params: z.object({ text }),
        async run(ctx, p) {
          const channel = target(ctx)
          return posted(await call(ctx.fetch, 'POST', route(channel), { content: p.text, allowed_mentions: NO_MENTIONS }), channel)
        },
      }),
      react: defineAction({
        mutating: true,
        description: 'Add an emoji reaction to the event message.',
        params: z.object({ emoji }),
        async run(ctx, p) {
          const channel = target(ctx)
          const messageId = ctx.envelope.context.messageId
          if (!messageId) throw new ActionError('no_message_context', false)
          await call(ctx.fetch, 'PUT', `${route(channel)}/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(p.emoji)}/@me`)
          return { result: {} }
        },
      }),
      update: defineAction({
        mutating: true,
        description: 'Edit a message that Relay sent earlier. messageId is the id of that message.',
        params: z.object({ messageId: snowflake, text }),
        async run(ctx, p) {
          const channel = target(ctx)
          if (!(await hasSentMessage(deps.db, ctx.connection.id, channel, p.messageId))) {
            throw new ActionError('message_not_sent_by_relay', false)
          }
          await call(ctx.fetch, 'PATCH', `${route(channel)}/${encodeURIComponent(p.messageId)}`, { content: p.text, allowed_mentions: NO_MENTIONS })
          return { result: { channel, messageId: p.messageId } }
        },
      }),
      'thread.history': defineAction({
        mutating: false,
        description: 'Read recent messages in the channel or thread of the event. Without the message content intent, other people\'s messages that do not mention the bot come back with empty text.',
        params: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
        async run(ctx, p) {
          const channel = target(ctx)
          const data = await call(ctx.fetch, 'GET', `${route(channel)}?limit=${p.limit}`)
          const raw = Array.isArray(data) ? data : []
          const str = (v: unknown) => (typeof v === 'string' ? v : null)
          // The API returns newest first. Agents read oldest first, as with Slack.
          const messages = raw
            .slice(0, p.limit)
            .map((m) => {
              const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
              const author = (o.author && typeof o.author === 'object' ? o.author : {}) as Record<string, unknown>
              return { messageId: str(o.id), user: str(author.id), bot: author.bot === true, text: str(o.content), timestamp: str(o.timestamp) }
            })
            .reverse()
          return { result: { messages, hasMore: raw.length >= p.limit } }
        },
      }),
    },

    async isSelfEcho(envelope, connection) {
      const { channelId, messageId } = envelope.context
      if (channelId && messageId && (await hasSentMessage(deps.db, connection.id, channelId, messageId))) return true
      if (!deps.botToken || envelope.actor === null) return false
      botUserId ??= call(deps.fetch ?? fetch, 'GET', '/users/@me')
        .then((u) => {
          const id = u && typeof u === 'object' ? (u as { id?: unknown }).id : undefined
          return typeof id === 'string' ? id : null
        })
        .catch(() => {
          botUserId = null
          return null
        })
      return envelope.actor === (await botUserId)
    },
  }
}
