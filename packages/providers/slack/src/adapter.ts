import {
  InvalidPayloadError,
  notImplemented,
  type ConnectionStore,
  type IngressInput,
  type ProviderAdapter,
} from '@relay/core'
import { normalizeSlack } from './normalize'
import { SLACK_AUTHORIZE_URL, SLACK_USER_SCOPES } from './oauth'
import { eventCallbackSchema, urlVerificationSchema, type EventCallback } from './payload'
import { verifySlackSignature } from './signature'

export interface SlackAdapterDeps {
  signingSecret: string
  connections: ConnectionStore
  nowSeconds?: () => number
}

function parseCallback(payload: unknown): EventCallback {
  const parsed = eventCallbackSchema.safeParse(payload)
  if (!parsed.success) throw new InvalidPayloadError('not a Slack event_callback')
  return parsed.data
}

export function createSlackAdapter(deps: SlackAdapterDeps): ProviderAdapter {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))

  return {
    id: 'slack',
    oauth: { authorizeUrl: SLACK_AUTHORIZE_URL, userScopes: SLACK_USER_SCOPES },

    async verify(req, rawBody) {
      verifySlackSignature({
        signingSecret: deps.signingSecret,
        timestamp: req.headers.get('x-slack-request-timestamp'),
        signature: req.headers.get('x-slack-signature'),
        rawBody,
        nowSeconds: nowSeconds(),
      })
    },

    handshake({ payload }: IngressInput) {
      const parsed = urlVerificationSchema.safeParse(payload)
      if (!parsed.success) return null
      return new Response(parsed.data.challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
    },

    async lifecycle({ payload }) {
      const cb = eventCallbackSchema.safeParse(payload)
      if (!cb.success || cb.data.event.type !== 'tokens_revoked') return false
      const tokens = cb.data.event.tokens ?? {}
      const userIds = [...new Set([...(tokens.oauth ?? []), ...(tokens.bot ?? [])])]
      await deps.connections.revokeSlack(cb.data.team_id, userIds)
      return true
    },

    async resolveConnection({ payload }) {
      const cb = parseCallback(payload)
      const auth = cb.authorizations?.[0]
      const teamId = auth?.team_id ?? cb.team_id
      const userId = auth?.user_id
      if (!teamId || !userId) return null
      return deps.connections.findSlack(teamId, userId)
    },

    dedupKey({ payload }) {
      return parseCallback(payload).event_id
    },

    normalize({ payload, connection, eventId }) {
      return normalizeSlack(parseCallback(payload), { eventId, connectionId: connection.id })
    },

    actions: {},
    isSelfEcho: notImplemented('slack.isSelfEcho'),
  }
}
