import { MetricsRegistry } from '@relay/core'

export const ROUTER_OUTCOMES = ['matched', 'unmatched', 'skipped_inactive'] as const
export const ATTEMPT_OUTCOMES = ['success', 'retry', 'failed_exhausted', 'failed_non_retryable'] as const

export function createWorkerMetrics(registry = new MetricsRegistry()) {
  return {
    registry,
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
    deliveryAttempts: registry.counter(
      'relay_delivery_attempts_total',
      'Delivery attempts by outcome.',
      ['outcome'] as const,
    ),
  }
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>
