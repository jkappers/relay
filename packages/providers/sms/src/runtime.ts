import { ActionError, defineAction, hasSentMessage, parseRetryAfterMs, type Db, type ProviderRuntime } from '@relay/core'
import { z } from 'zod'

export const DEFAULT_SMS_API_BASE_URL = 'https://api.twilio.com'
const REQUEST_TIMEOUT_MS = 15_000

export interface SmsRuntimeDeps {
  db: Db
  apiBase?: string
}

export function createSmsRuntime(deps: SmsRuntimeDeps): ProviderRuntime {
  const apiBase = (deps.apiBase ?? DEFAULT_SMS_API_BASE_URL).replace(/\/+$/, '')

  return {
    id: 'sms',
    actions: {
      send: defineAction({
        mutating: true,
        params: z.object({ body: z.string().min(1).max(1600) }),
        async run(ctx, p) {
          const authToken = ctx.credentials.sms_auth_token
          const accountSid = ctx.connection.teamId
          const from = ctx.connection.userId
          const to = ctx.envelope.context.channelId
          if (!authToken || !accountSid || !from) throw new ActionError('no_credentials', false)
          if (!to) throw new ActionError('no_channel_context', false)

          let res: Response
          try {
            res = await ctx.fetch(`${apiBase}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
              method: 'POST',
              headers: {
                authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ To: to, From: from, Body: p.body }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
          } catch {
            throw new ActionError('network_error', true)
          }
          if (res.status === 429) {
            await res.body?.cancel().catch(() => {})
            throw new ActionError('ratelimited', true, parseRetryAfterMs(res.headers.get('retry-after')))
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
          if (!res.ok) {
            const err = z.looseObject({ code: z.number() }).safeParse(body)
            throw new ActionError(err.success ? `twilio_${err.data.code}` : `http_${res.status}`, false)
          }
          const parsed = z.looseObject({ sid: z.string().min(1), status: z.string().optional() }).safeParse(body)
          if (!parsed.success) throw new ActionError('bad_response', false)
          return {
            result: { sid: parsed.data.sid, status: parsed.data.status ?? null },
            sentMessage: { channel: to, ts: parsed.data.sid },
          }
        },
      }),
    },

    async isSelfEcho(envelope, connection) {
      if (envelope.actor && envelope.actor === connection.userId) return true
      const { channelId, messageId } = envelope.context
      if (!channelId || !messageId) return false
      return hasSentMessage(deps.db, connection.id, channelId, messageId)
    },
  }
}
