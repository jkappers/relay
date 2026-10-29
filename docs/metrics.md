# Metrics

Served at `GET /metrics` on the server (`PORT`) and on the worker (`WORKER_METRICS_PORT`, default 9465) in Prometheus text format. Counters live in memory and reset when the process restarts.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_ingress_requests_total` | counter | `provider`, `outcome` | One per request to `/hooks/*`. |
| `relay_ingress_requeued_total` | counter | `provider` | A duplicate delivery found a stored event with null `enqueued_at` and enqueued it. |
| `relay_connections_revoked_total` | counter | `provider` | A `tokens_revoked` event was handled. Counts events, not connections. |
| `relay_oauth_callbacks_total` | counter | `provider`, `outcome` | One per OAuth callback. |

Worker metrics:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_router_events_total` | counter | `outcome` | One per `route` job that found its event. |
| `relay_deliveries_created_total` | counter | none | New delivery rows. Re-routing an event adds 0. |
| `relay_delivery_attempts_total` | counter | `outcome` | One per delivery attempt that reached a result. |
| `relay_sweeper_requeued_total` | counter | `kind` | Jobs the sweeper queued again. `kind` is `event` (a `route` job for an event enqueued but never routed) or `delivery` (a `dispatch` job for a delivery stuck `pending`). A sweep that finds a job already queued adds 0. |

## `relay_ingress_requests_total` outcomes

| Outcome | HTTP | Meaning |
|---|---|---|
| `accepted` | 200 | New event stored and enqueued. |
| `duplicate` | 200 | Event already stored (same provider and dedup key). |
| `bad_signature` | 401 | Signature missing, wrong, or timestamp outside 5 minutes. |
| `handshake` | 200 | Slack `url_verification` answered. |
| `lifecycle` | 200 | Provider control event handled (Slack `tokens_revoked`). Not stored. |
| `unknown_connection` | 200 | No active connection matches. Not stored. |
| `invalid_body` | 400 | Signed body isn't JSON or isn't a valid event payload. |
| `error` | 500 | Unexpected failure. Nothing is committed. |

## `relay_oauth_callbacks_total` outcomes

`success`, `bad_state`, `denied` (Slack sent `error` or no `code`), `exchange_failed`, `not_allowed` (the Slack user is not in `SLACK_ALLOWED_USER_IDS`; nothing stored, HTTP 403).

## `relay_router_events_total` outcomes

| Outcome | Meaning |
|---|---|
| `matched` | At least one route matched. Deliveries were created or already existed. |
| `unmatched` | No route matched. |
| `skipped_inactive` | The event's connection isn't `active`. |

## `relay_delivery_attempts_total` outcomes

| Outcome | Meaning |
|---|---|
| `success` | 2xx. Delivery is `succeeded`. |
| `retry` | Retryable failure with attempts left. Another job is scheduled. |
| `failed_exhausted` | Retryable failure on the last attempt. Delivery is `failed`. |
| `failed_non_retryable` | Non-retryable response (other 4xx, 3xx) or a disabled destination. Delivery is `failed`. |
