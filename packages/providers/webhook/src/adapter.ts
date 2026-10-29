import {
  computeSignature,
  notImplemented,
  safeEqual,
  sha256Hex,
  SignatureError,
  UnknownConnectionError,
  withinWindow,
  type ConnectionStore,
  type ProviderAdapter,
} from '@relay/core'

export const WEBHOOK_TIMESTAMP_WINDOW_SECONDS = 300
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPE_RE = /^[A-Za-z0-9._-]{1,64}$/

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return computeSignature(secret, timestamp, rawBody)
}

export function connectionIdFromRequest(req: Request): string | null {
  const last = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  return last && UUID_RE.test(last) ? last.toLowerCase() : null
}

export interface WebhookAdapterDeps {
  connections: ConnectionStore
  nowSeconds?: () => number
}

export function createWebhookAdapter(deps: WebhookAdapterDeps): ProviderAdapter {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))

  return {
    id: 'webhook',

    async verify(req, rawBody) {
      const connectionId = connectionIdFromRequest(req)
      if (!connectionId) throw new UnknownConnectionError('no connection id in path')
      const secret = await deps.connections.getWebhookSecret(connectionId)
      if (!secret) throw new UnknownConnectionError('unknown webhook connection')

      const timestamp = req.headers.get('x-relay-timestamp')
      const signature = req.headers.get('x-relay-signature')
      if (!timestamp || !signature) throw new SignatureError('missing signature headers')
      if (!/^\d+$/.test(timestamp)) throw new SignatureError('malformed timestamp')
      if (!withinWindow(Number(timestamp), nowSeconds(), WEBHOOK_TIMESTAMP_WINDOW_SECONDS)) {
        throw new SignatureError('timestamp outside window')
      }
      if (!safeEqual(computeWebhookSignature(secret, timestamp, rawBody), signature)) {
        throw new SignatureError('signature mismatch')
      }
    },

    async resolveConnection({ req }) {
      const connectionId = connectionIdFromRequest(req)
      if (!connectionId) return null
      const conn = await deps.connections.findById(connectionId)
      return conn && conn.provider === 'webhook' ? conn : null
    },

    dedupKey({ req, rawBody, connection }) {
      const eventId = req.headers.get('x-relay-event-id')?.trim()
      return `${connection.id}:${eventId ? `id:${eventId}` : `sha256:${sha256Hex(rawBody)}`}`
    },

    normalize({ payload, connection, eventId, receivedAt }) {
      const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      const rawType = body.type
      const type = typeof rawType === 'string' && TYPE_RE.test(rawType) ? rawType : 'event'
      return {
        id: eventId,
        provider: 'webhook',
        connectionId: connection.id,
        type: `webhook.${type}`,
        subtype: null,
        occurredAt: receivedAt.toISOString(),
        actor: null,
        context: { channelId: null, threadId: null, messageId: null },
        text: typeof body.text === 'string' ? body.text : null,
      }
    },

    actions: {},
    isSelfEcho: notImplemented('webhook.isSelfEcho'),
  }
}
