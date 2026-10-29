# ADR 0002: Delivery retries are app-managed

Status: accepted (M2)

## Decision

The dispatcher makes one HTTP attempt per job. On a retryable failure it saves the result in the `deliveries` row and queues a new `dispatch` job with `startAfter`. It does not use pg-boss's built-in retry for delivery failures.

## Why

- pg-boss retry has simple backoff. We want full jitter, a 15 min cap, and `Retry-After` on 429.
- The attempt count, last status, last error, and next attempt time must live in our table, so we can show and replay them.
- Each destination sets its own `max_attempts`. pg-boss sets that per queue.
- A failed delivery is a normal result, not a failed job. The job ends clean, so the queue stays free of noise.

## What pg-boss still does

If the handler throws (a DB outage, a bug), pg-boss retries the job. The `dispatch` queue allows 5 retries with backoff. The handler is safe to repeat: it only acts on `pending` deliveries and claims each attempt with an atomic `attempts + 1` update.

## Sweeper

If pg-boss gives up on a job, the work would be stranded. The worker sweeper (at startup, then every `SWEEP_INTERVAL_SECONDS`) requeues `route` jobs for events with `enqueued_at` set and `routed_at` null, and `dispatch` jobs for `pending` deliveries, once they are older than `SWEEP_GRACE_SECONDS`. The router sets `routed_at` when it finishes, even for unmatched or inactive events.

Both queues use policy `short` with the entity id as `singletonKey`: at most one waiting (`created`) job per id. A delayed retry job is `created` too, so a sweep during backoff adds nothing. The running job is `active`, so it can still queue its own retry. Queue policy is fixed when the queue is created. An older database needs the queue dropped and recreated.

## Known gap

If a job crashes after it claims an attempt but before it saves the result, the attempt is counted and the retry resends. Receivers should dedupe on `Relay-Delivery-Id`. 

## Dependencies

None added. `drizzle-orm` and `zod` (same pinned versions as the server) are now declared in `apps/worker`.
