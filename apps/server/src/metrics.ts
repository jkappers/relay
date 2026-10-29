import { createActionCounters, MetricsRegistry } from '@relay/core'

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
    ...createActionCounters(registry),
    replyTokensRejected: registry.counter(
      'relay_reply_tokens_rejected_total',
      'Reply tokens rejected by /actions, by reason.',
      ['reason'] as const,
    ),
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
    consoleLogins: registry.counter(
      'relay_console_logins_total',
      'Console login attempts by outcome.',
      ['outcome'] as const,
    ),
    consoleSignups: registry.counter(
      'relay_console_signups_total',
      'Console sign-up attempts by outcome.',
      ['outcome'] as const,
    ),
    tenantDenied: registry.counter(
      'relay_tenant_denied_total',
      'Console API requests for a connection the user is not a member of. Answered 404.',
    ),
    consoleMutations: registry.counter(
      'relay_console_mutations_total',
      'Successful console API changes by resource and action.',
      ['resource', 'action'] as const,
    ),
    adminDenied: registry.counter(
      'relay_admin_denied_total',
      'Admin API requests from a signed-in user who is not an instance admin. Answered 404.',
    ),
    providerAppChanges: registry.counter(
      'relay_provider_app_changes_total',
      'Provider app settings saved or removed through the admin API.',
      ['provider'] as const,
    ),
    providerAppTests: registry.counter(
      'relay_provider_app_tests_total',
      'Admin-initiated provider app tests by result.',
      ['provider', 'result'] as const,
    ),
    providerAppConfigErrors: registry.counter(
      'relay_provider_app_config_errors_total',
      'Provider app settings that could not be used, by reason.',
      ['provider', 'reason'] as const,
    ),
    oauthCallbacks: registry.counter(
      'relay_oauth_callbacks_total',
      'OAuth callback results.',
      ['provider', 'outcome'] as const,
    ),
  }
}

export type ServerMetrics = ReturnType<typeof createServerMetrics>
