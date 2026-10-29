import { MetricsRegistry } from '@relay/core'

export const INGRESS_OUTCOMES = [
  'accepted',
  'duplicate',
  'bad_signature',
  'handshake',
  'lifecycle',
  'unknown_connection',
  'invalid_body',
  'error',
] as const
export type IngressOutcome = (typeof INGRESS_OUTCOMES)[number]

export function createServerMetrics(registry = new MetricsRegistry()) {
  return {
    registry,
    ingressRequests: registry.counter(
      'relay_ingress_requests_total',
      'Inbound provider requests by outcome.',
      ['provider', 'outcome'] as const,
    ),
    ingressRequeued: registry.counter(
      'relay_ingress_requeued_total',
      'Duplicate deliveries whose stored event had not been enqueued and was enqueued again.',
      ['provider'] as const,
    ),
    connectionsRevoked: registry.counter(
      'relay_connections_revoked_total',
      'Connections marked revoked by provider lifecycle events.',
      ['provider'] as const,
    ),
    oauthCallbacks: registry.counter(
      'relay_oauth_callbacks_total',
      'OAuth callback results.',
      ['provider', 'outcome'] as const,
    ),
  }
}

export type ServerMetrics = ReturnType<typeof createServerMetrics>
