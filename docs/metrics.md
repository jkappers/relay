# Metrics

Served at `GET /metrics` on the server (`PORT`), on the worker (`WORKER_METRICS_PORT`, default 9465), and on the Discord gateway (`GATEWAY_METRICS_PORT`, default 9466) in Prometheus text format. Counters live in memory and reset when the process restarts.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_ingress_requests_total` | counter | `provider`, `outcome` | One per request to `/hooks/*`. |
| `relay_ingress_requeued_total` | counter | `provider` | A duplicate delivery found a stored event with null `enqueued_at` and enqueued it. |
| `relay_connections_revoked_total` | counter | `provider` | A revocation event was handled (Slack `tokens_revoked` here; Discord `GUILD_DELETE` on the gateway). Counts events, not connections. |
| `relay_oauth_callbacks_total` | counter | `provider`, `outcome` | One per OAuth callback. |
| `relay_actions_total` | counter | `provider`, `type`, `mode`, `outcome` | One per action handled by `POST /actions` (`mode="async"`). See below. |
| `relay_reply_tokens_rejected_total` | counter | `reason` | One per `/actions` request rejected on its reply token. See below. |
| `relay_console_logins_total` | counter | `outcome` | One per console sign-in attempt. See below. |
| `relay_console_signups_total` | counter | `outcome` | One per `POST /api/users`. See below. |
| `relay_tenant_denied_total` | counter | none | A signed-in user asked for a connection they are not a member of. Answered 404. |
| `relay_console_mutations_total` | counter | `resource`, `action` | Console API changes that succeeded. See below. |

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
| `relay_cross_tenant_blocked_total` | counter | `stage` | A route link or delivery paired an event with a destination in another connection, and relay refused it. See below. |
| `relay_classifier_calls_total` | counter | `outcome` | One per `route` job whose event matched at least one gated route (`selection = classifier`, connection mode `shadow` or `enforce`). See below. |
| `relay_classifier_decisions_total` | counter | `mode`, `result` | One per event: counted by the job whose decision was stored. Reuse adds 0. See below. |
| `relay_classifier_tokens_total` | counter | `kind` | Tokens used by classifier calls: `input`, `output`. Counted for every call, including one whose decision lost a race. |

Gateway metrics (`apps/gateway`):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_discord_gateway_connected` | gauge | none | 1 while the Discord Gateway session is ready or resumed. 0 after a close, before the library reconnects. |
| `relay_discord_gateway_leader` | gauge | none | 1 while this process holds the leader lock. A second copy shows 0 and waits. |
| `relay_discord_gateway_closes_total` | counter | `code` | Gateway socket closes by close code. 4004 (bad token) and 4014 (disallowed intents) do not reconnect: fix the config and restart. |
| `relay_discord_dispatch_total` | counter | `type` | Gateway dispatches received, by event name (`MESSAGE_CREATE`, `GUILD_CREATE`, `READY`, ...). |
| `relay_discord_messages_total` | counter | `outcome` | One per `MESSAGE_CREATE`, or one per connection when it is stored. See below. |
| `relay_discord_dm_unrouted_total` | counter | none | A DM to the bot from someone who installed no active connection. Dropped. |
| `relay_connections_revoked_total` | counter | `provider` | `GUILD_DELETE` with no `unavailable` field (the bot was removed from a server). Counts events. |

## `relay_discord_messages_total` outcomes

| Outcome | Meaning |
|---|---|
| `accepted` | New event stored and enqueued for one connection. A DM routed to two installs counts 2. |
| `duplicate` | Already stored (same connection and message id). Discord can resend after a resume. |
| `requeued` | Already stored but never enqueued. Enqueued now. |
| `bot_author` | Written by a bot or webhook, including Relay's own bot. Dropped. |
| `unsupported_type` | A system message (not type 0 or 19). Dropped. |
| `not_mentioned` | A server message that does not mention the bot. Dropped. Without the MESSAGE_CONTENT intent its text is empty anyway. |
| `no_bot_user` | Arrived before `READY` told us the bot's user id. Dropped. |
| `invalid_payload` | The payload did not parse. Dropped. |
| `unknown_connection` | Mentions the bot in a server with no active connection. Dropped. |
| `dm_unrouted` | A DM from someone who installed no active connection. Dropped. |
| `error` | Storing failed. The Gateway does not resend, so the message is lost. See the logs. |

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

`provider` is `slack`, `webhook`, or `sms`. For `sms`, `bad_signature` means a missing or wrong `X-Twilio-Signature` (Twilio signs no timestamp, so there is no window check; replays are stopped by the `MessageSid` dedup key and show up as `duplicate`). `unknown_connection` also covers an `AccountSid` that doesn't match the connection. `handshake` and `lifecycle` never occur for `sms`.

`relay_actions_total` and `relay_router_events_total` carry `provider="sms"` and `type="send"` for SMS actions and `skipped_echo` for messages from the connection's own number.

## `relay_oauth_callbacks_total` outcomes

`provider` is `slack` or `discord`.

`success`, `bad_state`, `denied` (the provider sent `error` or no `code`), `exchange_failed` (includes a Discord token response with no server), `not_allowed` (`SLACK_ALLOWED_USER_IDS` or `DISCORD_ALLOWED_USER_IDS` is set and the user is not in it; nothing stored, HTTP 403), `owned_elsewhere` (another Relay account already owns this Slack identity or Discord server; nothing stored, HTTP 409), `guild_mismatch` (Discord only: the redirect's `guild_id` differs from the server in the token response; nothing stored, HTTP 400).

## `relay_router_events_total` outcomes

| Outcome | Meaning |
|---|---|
| `matched` | At least one route matched. Deliveries were created or already existed. |
| `unmatched` | No route matched. |
| `skipped_inactive` | The event's connection isn't `active`. |
| `skipped_echo` | The provider says relay sent this message (Slack: its channel and ts are in `sent_messages`; SMS: the sender is the connection's own number; Discord: the channel and message id are in `sent_messages`, or the actor is the bot user). Marked routed, no deliveries. |
| `classified_none` | Only gated routes matched, and after the classifier (or its fallbacks) none of them gets the event. Marked routed, no deliveries. Shadow mode never gives this. |
| `echo_recheck` | The actor is the connection's own user, nothing matched `sent_messages` yet, and the event is under 30 s old. A `route` job with `recheck: true` was queued 5 s out. The event is not marked routed. Never for Discord: the bot's own posts are dropped at the gateway. |

## `relay_classifier_calls_total` outcomes

| Outcome | Meaning |
|---|---|
| `ok` | The classifier answered with a parseable list. |
| `timeout` | Both attempts timed out (5 s each), or the 12 s overall deadline passed. Fallbacks apply. |
| `error` | API error, missing `ANTHROPIC_API_KEY`, or anything else that threw. Fallbacks apply. |
| `refusal` | The model refused (`stop_reason: refusal`). Fallbacks apply. |
| `invalid` | Output hit `max_tokens` or did not parse. Fallbacks apply. |
| `reused` | A decision for this event was already stored (retry, recheck, sweep, replay). No call. |
| `budget_exceeded` | The connection's daily limit was reached. No call. Fallbacks apply. |

## `relay_classifier_decisions_total` results

`mode` is `shadow` or `enforce`.

| Result | Meaning |
|---|---|
| `selected` | The classifier picked at least one gated route. |
| `none` | The classifier picked no route. |
| `fallback_deliver` | No usable answer (failure or over the limit), and at least one gated route has fallback `deliver`. |
| `fallback_drop` | No usable answer, and every gated route has fallback `drop`. |

In shadow mode every gated route is delivered whatever the result. The result shows what enforce would have done.

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

## `relay_console_logins_total`

Console sign-in attempts. Label `outcome`:

| Outcome | Meaning |
|---|---|
| `success` | Right email and password. A session was stored and its cookie set. |
| `bad_credentials` | Unknown email or wrong password (one answer for both). Counts toward both limits. |
| `throttled` | 5 failures from one IP in 15 minutes. Rejected with 429 before the password is checked. |
| `rate_limited` | 10 failures for one email in 15 minutes, from any IP. Rejected with 429 before the password is checked. |
| `busy` | 4 password checks were running and 64 more were waiting. Rejected with 503. |

## `relay_console_signups_total`

Label `outcome`:

| Outcome | Meaning |
|---|---|
| `created` | New account. A session was started. |
| `closed` | `SIGNUP_MODE` is `closed`. HTTP 403. |
| `email_taken` | An account with that email exists. HTTP 409. |
| `rate_limited` | 5 sign-ups from one IP in 15 minutes. HTTP 429. |
| `busy` | Too many password hashes in flight. HTTP 503. |

## `relay_cross_tenant_blocked_total` stages

| Stage | Meaning |
|---|---|
| `router` | A matched route linked a destination in another connection. That link was skipped. Other links still deliver. |
| `dispatch` | The dispatcher found a delivery whose destination is in another connection. Marked `failed` with `cross_tenant`. Nothing was sent and no reply token was made. |
| `agent` | The agent handler found the same. Marked `failed` with `cross_tenant`. No run started. |

All three should stay at 0. A non-zero count means a bad row from before accounts, or a bug.

## `relay_console_mutations_total`

Changes made through the console API that succeeded. Labels `resource` and `action`.

| Resource | Actions |
|---|---|
| `connection` | `create`, `revoke`, `update` (`create` covers webhook and SMS connections; `update` is `PUT /classifier`) |
| `destination` | `create`, `update`, `delete`, `rotate_secret` |
| `route` | `create`, `update`, `delete`, `enable`, `disable` |
| `event` | `replay` |
| `delivery` | `replay` |
| `token` | `revoke` |
