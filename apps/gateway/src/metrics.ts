import { MetricsRegistry } from '@relay/core'

export const MESSAGE_OUTCOMES = [
  'accepted',
  'duplicate',
  'requeued',
  'bot_author',
  'unsupported_type',
  'not_mentioned',
  'no_bot_user',
  'invalid_payload',
  'unknown_connection',
  'dm_unrouted',
  'error',
] as const
export type MessageOutcome = (typeof MESSAGE_OUTCOMES)[number]

export function createGatewayMetrics(registry = new MetricsRegistry()) {
  return {
    registry,
    connected: registry.gauge('relay_discord_gateway_connected', '1 while the Discord Gateway session is ready, else 0.'),
    leader: registry.gauge('relay_discord_gateway_leader', '1 while this process holds the gateway leader lock, else 0.'),
    closes: registry.counter('relay_discord_gateway_closes_total', 'Gateway socket closes by close code.', ['code'] as const),
    dispatches: registry.counter('relay_discord_dispatch_total', 'Gateway dispatches received, by event name.', ['type'] as const),
    messages: registry.counter('relay_discord_messages_total', 'MESSAGE_CREATE handling by outcome. accepted and duplicate count once per connection.', ['outcome'] as const),
    dmUnrouted: registry.counter('relay_discord_dm_unrouted_total', 'DMs to the bot from a user who installed no active connection. Dropped.'),
    connectionsRevoked: registry.counter('relay_connections_revoked_total', 'Connections marked revoked by provider lifecycle events.', ['provider'] as const),
  }
}

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>
