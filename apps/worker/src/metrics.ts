import { createActionCounters, MetricsRegistry } from '@relay/core'

export const ROUTER_OUTCOMES = ['matched', 'unmatched', 'skipped_inactive', 'skipped_echo', 'echo_recheck', 'classified_none'] as const
export const CLASSIFIER_CALL_OUTCOMES = ['ok', 'timeout', 'error', 'refusal', 'invalid', 'reused', 'budget_exceeded'] as const
export const CLASSIFIER_DECISION_RESULTS = ['selected', 'none', 'fallback_deliver', 'fallback_drop'] as const
export const ATTEMPT_OUTCOMES = ['success', 'retry', 'failed_exhausted', 'failed_non_retryable'] as const

export const AGENT_RUN_OUTCOMES = ['succeeded', 'failed', 'retried', 'not_retried_after_mutation'] as const
export const AGENT_TOOL_OUTCOMES = ['succeeded', 'failed', 'retry', 'denied', 'cap_reached'] as const
export const AGENT_TOOLS_WITHHELD_REASONS = ['missing', 'disabled', 'invalid', 'sensitive', 'name_collision'] as const
export const AGENT_TOKEN_KINDS = ['input', 'output', 'cache_read', 'cache_creation'] as const

export function createWorkerMetrics(registry = new MetricsRegistry()) {
  return {
    registry,
    ...createActionCounters(registry),
    routerEvents: registry.counter(
      'relay_router_events_total',
      'Events handled by the router, by outcome.',
      ['outcome'] as const,
    ),
    classifierCalls: registry.counter(
      'relay_classifier_calls_total',
      'Classifier steps for events with gated routes, by outcome.',
      ['outcome'] as const,
    ),
    classifierDecisions: registry.counter(
      'relay_classifier_decisions_total',
      'Stored classifier decisions, one per event, by mode and result.',
      ['mode', 'result'] as const,
    ),
    classifierTokens: registry.counter('relay_classifier_tokens_total', 'Tokens used by classifier calls, by kind.', ['kind'] as const),
    deliveriesCreated: registry.counter('relay_deliveries_created_total', 'New delivery rows created by the router.'),
    sweeperRequeued: registry.counter(
      'relay_sweeper_requeued_total',
      'Jobs the sweeper queued again for stranded work.',
      ['kind'] as const,
    ),
    agentRuns: registry.counter('relay_agent_runs_total', 'Agent run attempts by outcome.', ['outcome'] as const),
    agentToolCalls: registry.counter(
      'relay_agent_tool_calls_total',
      'Agent tool calls by action type (or "tool" for tool destinations) and outcome.',
      ['type', 'outcome'] as const,
    ),
    toolDestinationCalls: registry.counter(
      'relay_tool_destination_calls_total',
      'Agent calls to tool destinations, by outcome.',
      ['outcome'] as const,
    ),
    agentToolsWithheld: registry.counter(
      'relay_agent_tools_withheld_total',
      'Tool destinations listed on an agent but not offered in a run, by reason.',
      ['reason'] as const,
    ),
    agentTokens: registry.counter('relay_agent_tokens_total', 'Tokens used by agent runs, by kind.', ['kind'] as const),
    agentCostUsd: registry.counter('relay_agent_cost_usd_total', 'Estimated agent cost in US dollars, as reported by the SDK.'),
    crossTenantBlocked: registry.counter(
      'relay_cross_tenant_blocked_total',
      'Deliveries refused because the destination belongs to another connection than the event.',
      ['stage'] as const,
    ),
    deliveryAttempts: registry.counter(
      'relay_delivery_attempts_total',
      'Delivery attempts by outcome.',
      ['outcome'] as const,
    ),
  }
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>
