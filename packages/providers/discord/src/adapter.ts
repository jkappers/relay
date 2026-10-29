import type { ConnectionStore, GatewayAdapter, GatewayDispatch } from '@relay/core'
import { classifyMessage, normalizeDiscord } from './normalize'
import { guildDeleteSchema, messageCreateSchema, type DiscordMessage } from './payload'

export interface DiscordAdapterDeps {
  connections: ConnectionStore
  /** The bot's own user id, learned from READY. Null until then. */
  botUserId: () => string | null
}

function parseMessage(dispatch: GatewayDispatch): DiscordMessage | null {
  if (dispatch.t !== 'MESSAGE_CREATE') return null
  const parsed = messageCreateSchema.safeParse(dispatch.d)
  return parsed.success ? parsed.data : null
}

export function createDiscordAdapter(deps: DiscordAdapterDeps): GatewayAdapter {
  const ingestable = (dispatch: GatewayDispatch) => {
    const msg = parseMessage(dispatch)
    if (!msg) throw new Error('not a MESSAGE_CREATE dispatch')
    const botUserId = deps.botUserId()
    const c = classifyMessage(msg, botUserId)
    if (!c.ingest || !botUserId) throw new Error('dispatch is not ingestable')
    return { msg, kind: c.kind, botUserId }
  }

  return {
    id: 'discord',

    async lifecycle(dispatch) {
      if (dispatch.t !== 'GUILD_DELETE') return null
      const parsed = guildDeleteSchema.safeParse(dispatch.d)
      // `unavailable` set means an outage. Not set means the bot was removed from the server.
      if (!parsed.success || parsed.data.unavailable !== undefined) return null
      return { kind: 'revoked', count: await deps.connections.revoke('discord', parsed.data.id) }
    },

    async resolveConnections(dispatch) {
      if (dispatch.t !== 'MESSAGE_CREATE') return { kind: 'ignore', reason: 'not_message' }
      const msg = parseMessage(dispatch)
      if (!msg) return { kind: 'ignore', reason: 'invalid_payload' }
      const c = classifyMessage(msg, deps.botUserId())
      if (!c.ingest) return { kind: 'ignore', reason: c.reason }
      if (c.kind === 'dm') {
        // A DM has no server. It goes to every active install whose installer wrote it.
        const connections = await deps.connections.findActive('discord', { userId: msg.author.id })
        return connections.length ? { kind: 'ingest', connections } : { kind: 'ingest', connections, reason: 'dm_unrouted' }
      }
      const connections = await deps.connections.findActive('discord', { teamId: msg.guild_id! })
      return connections.length ? { kind: 'ingest', connections } : { kind: 'ingest', connections, reason: 'unknown_connection' }
    },

    dedupKey(dispatch, connection) {
      return `${connection.id}:${ingestable(dispatch).msg.id}`
    },

    normalize({ dispatch, connection, eventId }) {
      const { msg, kind, botUserId } = ingestable(dispatch)
      return normalizeDiscord(msg, { eventId, connectionId: connection.id, kind, botUserId })
    },
  }
}
