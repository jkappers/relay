import { createActionCounters, MetricsRegistry } from '@relay/core'

export const ROUTER_OUTCOMES = ['matched', 'unmatched', 'skipped_inactive', 'skipped_echo', 'echo_recheck'] as const
export const ATTEMPT_OUTCOMES = ['success', 'retry', 'failed_exhausted', 'failed_non_retryable'] as const

export const AGENT_RUN_OUTCOMES = ['succeeded', 'failed', 'retried', 'not_retried_after_mutation'] as const
export const AGENT_TOOL_OUTCOMES = ['succeeded', 'failed', 'retry', 'denied', 'cap_reached'] as const
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
    deliveriesCreated: registry.counter('relay_deliveries_created_total', 'New delivery rows created by the router.'),
    sweeperRequeued: registry.counter(
      'relay_sweeper_requeued_total',
      'Jobs the sweeper queued again for stranded work.',
      ['kind'] as const,
    ),
    agentRuns: registry.counter('relay_agent_runs_total', 'Agent run attempts by outcome.', ['outcome'] as const),
    agentToolCalls: registry.counter(
      'relay_agent_tool_calls_total',
      'Agent tool calls by action type and outcome.',
      ['type', 'outcome'] as const,
    ),
    agentTokens: registry.counter('relay_agent_tokens_total', 'Tokens used by agent runs, by kind.', ['kind'] as const),
    agentCostUsd: registry.counter('relay_agent_cost_usd_total', 'Estimated agent cost in US dollars, as reported by the SDK.'),
    deliveryAttempts: registry.counter(
      'relay_delivery_attempts_total',
      'Delivery attempts by outcome.',
      ['outcome'] as const,
    ),
  }
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>
