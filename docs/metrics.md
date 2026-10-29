# Metrics

Served at `GET /metrics` on the server in Prometheus text format. Counters live in memory and reset when the process restarts.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_ingress_requests_total` | counter | `provider`, `outcome` | One per request to `/hooks/*`. |
| `relay_ingress_requeued_total` | counter | `provider` | A duplicate delivery found a stored event with null `enqueued_at` and enqueued it. |
| `relay_connections_revoked_total` | counter | `provider` | A `tokens_revoked` event was handled. Counts events, not connections. |
| `relay_oauth_callbacks_total` | counter | `provider`, `outcome` | One per OAuth callback. |

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

`success`, `bad_state`, `denied` (Slack sent `error` or no `code`), `exchange_failed`.

The worker exposes no metrics in M1.
