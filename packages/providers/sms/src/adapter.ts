import { SignatureError, UnknownConnectionError, type ConnectionStore, type ProviderAdapter } from '@relay/core'
import { paramsFromForm, verifyTwilioSignature } from './signature'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

export interface SmsAdapterDeps {
  connections: ConnectionStore
  /** Origin Twilio calls, e.g. https://relay.example.com. The signed URL is built from this, not from the request. */
  publicUrl: string
}

export function smsConnectionIdFromRequest(req: Request): string | null {
  const last = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  return last && UUID_RE.test(last) ? last.toLowerCase() : null
}

export function smsWebhookUrl(publicUrl: string, connectionId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/hooks/sms/${connectionId}`
}

function asParams(payload: unknown): Record<string, string> {
  return payload && typeof payload === 'object' ? (payload as Record<string, string>) : {}
}

export function createSmsAdapter(deps: SmsAdapterDeps): ProviderAdapter {
  return {
    id: 'sms',
    bodyFormat: 'form',
    ack: () => new Response(EMPTY_TWIML, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } }),

    async verify(req, rawBody) {
      const connectionId = smsConnectionIdFromRequest(req)
      if (!connectionId) throw new UnknownConnectionError('no connection id in path')
      const connection = await deps.connections.findById(connectionId)
      if (!connection || connection.provider !== 'sms') throw new UnknownConnectionError('unknown sms connection')
      const authToken = (await deps.connections.getCredentials(connectionId)).sms_auth_token
      if (!authToken) throw new UnknownConnectionError('sms connection has no credentials')

      const header = req.headers.get('x-twilio-signature')
      if (!header) throw new SignatureError('missing signature header')
      const url = smsWebhookUrl(deps.publicUrl, connectionId) + new URL(req.url).search
      if (!verifyTwilioSignature(authToken, url, paramsFromForm(rawBody), header)) throw new SignatureError('signature mismatch')
    },

    async resolveConnection({ req, payload }) {
      const connectionId = smsConnectionIdFromRequest(req)
      if (!connectionId) return null
      const conn = await deps.connections.findById(connectionId)
      if (!conn || conn.provider !== 'sms') return null
      return asParams(payload).AccountSid === conn.teamId ? conn : null
    },

    dedupKey({ payload, connection }) {
      const p = asParams(payload)
      return `${connection.id}:${p.MessageSid ?? p.SmsSid ?? ''}`
    },

    normalize({ payload, connection, eventId, receivedAt }) {
      const p = asParams(payload)
      return {
        id: eventId,
        provider: 'sms',
        connectionId: connection.id,
        type: 'sms.message.received',
        subtype: Number(p.NumMedia) > 0 ? 'media' : null,
        occurredAt: receivedAt.toISOString(),
        actor: p.From ?? null,
        context: { channelId: p.From ?? null, threadId: null, messageId: p.MessageSid ?? null },
        text: p.Body ?? null,
      }
    },
  }
}
