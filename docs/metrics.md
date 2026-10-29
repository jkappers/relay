# Metrics

Served at `GET /metrics` on the server (`PORT`) and on the worker (`WORKER_METRICS_PORT`, default 9465) in Prometheus text format. Counters live in memory and reset when the process restarts.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_ingress_requests_total` | counter | `provider`, `outcome` | One per request to `/hooks/*`. |
| `relay_ingress_requeued_total` | counter | `provider` | A duplicate delivery found a stored event with null `enqueued_at` and enqueued it. |
| `relay_connections_revoked_total` | counter | `provider` | A `tokens_revoked` event was handled. Counts events, not connections. |
| `relay_oauth_callbacks_total` | counter | `provider`, `outcome` | One per OAuth callback. |
| `relay_actions_total` | counter | `provider`, `type`, `mode`, `outcome` | One per action handled by `POST /actions` (`mode="async"`). See below. |
| `relay_reply_tokens_rejected_total` | counter | `reason` | One per `/actions` request rejected on its reply token. See below. |

Worker metrics:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_router_events_total` | counter | `outcome` | One per `route` job that found its event. |
| `relay_deliveries_created_total` | counter | none | New delivery rows. Re-routing an event adds 0. |
| `relay_delivery_attempts_total` | counter | `outcome` | One per delivery attempt that reached a result. |
| `relay_sweeper_requeued_total` | counter | `kind` | Jobs the sweeper queued again. `kind` is `event` (a `route` job for an event enqueued but never routed), `delivery` (a `dispatch` job for a delivery stuck `pending`), or `actions` (an `actions` job for a succeeded delivery whose response actions never finished). `delivery` covers both kinds: a stuck `http` delivery gets a `dispatch` job, a stuck `agent` delivery gets an `agent` job, and one with a live run lease is skipped. A sweep that finds a job already queued adds 0. |
| `relay_agent_runs_total` | counter | `outcome` | One per agent run attempt that reached a result. See below. |
| `relay_agent_tool_calls_total` | counter | `type`, `outcome` | One per agent tool call. See below. |
| `relay_agent_tokens_total` | counter | `kind` | Tokens used by agent runs. See below. |
| `relay_agent_cost_usd_total` | counter | none | Estimated spend of agent runs in US dollars, as the SDK reports it. A float counter (the registry stores JS numbers), so there is no micro-dollar variant. It is an estimate, not a bill. |
| `relay_actions_total` | counter | `provider`, `type`, `mode`, `outcome` | One per action handled by the `actions` job (`mode="sync"`). See below. |

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
| `skipped_echo` | The provider says relay sent this message (Slack: its channel and ts are in `sent_messages`). Marked routed, no deliveries. |
| `echo_recheck` | The actor is the connection's own user, nothing matched `sent_messages` yet, and the event is under 30 s old. A `route` job with `recheck: true` was queued 5 s out. The event is not marked routed. |

## `relay_delivery_attempts_total` outcomes

| Outcome | Meaning |
|---|---|
| `success` | 2xx. Delivery is `succeeded`. |
| `retry` | Retryable failure with attempts left. Another job is scheduled. |
| `failed_exhausted` | Retryable failure on the last attempt. Delivery is `failed`. |
| `failed_non_retryable` | Non-retryable response (other 4xx, 3xx) or a disabled destination. Delivery is `failed`. |

## `relay_actions_total`

`mode` is `sync` (worker, from a response body), `async` (server, `POST /actions`), or `agent` (worker, a tool call from an agent run). `type` is the action name.

| Outcome | Meaning |
|---|---|
| `succeeded` | The provider call ran and succeeded. Read-only actions also count here. |
| `failed` | Final failure: invalid params, not allowed, a non-retryable provider error, or retries used up. |
| `replayed` | A stored final result (succeeded or failed) was returned without calling the provider. |
| `in_progress` | Another run of the same action holds a fresh `pending` claim (under 60 s). Nothing ran. |
| `retry` | Retryable provider failure. Sync: the `actions` job is retried. Async: the caller should retry with the same key. |

## `relay_reply_tokens_rejected_total` reasons

`malformed`, `bad_signature`, `expired`, `revoked`, `unknown_delivery`, `connection_inactive` (all HTTP 401), and `action_not_allowed` (HTTP 403, a valid token asked for an action type outside its `allowed` list).

## `relay_agent_runs_total` outcomes

| Outcome | Meaning |
|---|---|
| `succeeded` | The run finished. Run and delivery are `succeeded`. |
| `failed` | Final failure with no change made: timeout, `max_turns`, a non-retryable error, no usable tools, bad config, or attempts used up. |
| `retried` | Failed before any change and has attempts left. Another `agent` job is scheduled with backoff. |
| `not_retried_after_mutation` | Failed or crashed after a change (or a possible one). Marked `failed` and never run again. |

## `relay_agent_tool_calls_total`

`type` is the action name (`reply`, `thread.history`, ...). Tool calls the model made that are not relay actions are counted as `type="other"`.

| Outcome | Meaning |
|---|---|
| `succeeded` | The action ran. |
| `failed` | The action failed for good (invalid params, not allowed, a non-retryable Slack error), or the run had already ended. |
| `retry` | A temporary failure. The model got an error and may try again. |
| `denied` | Blocked. Either a tool outside the relay list (`type="other"`), or a relay tool called after the run had ended (timeout). |
| `cap_reached` | A mutating call past `maxMutatingActions`. Nothing was sent. |

## `relay_agent_tokens_total` kinds

`input`, `output`, `cache_read`, `cache_creation`. Summed over every model the SDK reports for the run.
