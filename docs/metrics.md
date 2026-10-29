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
| `relay_admin_denied_total` | counter | none | A signed-in user who is not an instance admin called `/api/admin/*`. Answered 404. |
| `relay_provider_app_changes_total` | counter | `provider` | Slack or Discord app settings saved (`PUT`) or removed (`DELETE`) through `/api/admin/integrations`. |
| `relay_provider_app_config_errors_total` | counter | `provider`, `reason` | Saved app settings that could not be used. See below. |
| `relay_provider_app_tests_total` | counter | `provider`, `result` | One per admin click on Test. See below. |
| `relay_slack_signature_previous_total` | counter | none | A Slack request was accepted with the previous signing secret, during the 24 hours after a change. Should fall to 0 once Slack signs with the new one. |

Worker metrics:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_router_events_total` | counter | `outcome` | One per `route` job that found its event. |
| `relay_deliveries_created_total` | counter | none | New delivery rows. Re-routing an event adds 0. |
| `relay_delivery_attempts_total` | counter | `outcome` | One per delivery attempt that reached a result. |
| `relay_sweeper_requeued_total` | counter | `kind` | Jobs the sweeper queued again. `kind` is `event` (a `route` job for an event enqueued but never routed), `delivery` (a `dispatch` job for a delivery stuck `pending`), or `actions` (an `actions` job for a succeeded delivery whose response actions never finished). `delivery` covers both kinds: a stuck `http` delivery gets a `dispatch` job, a stuck `agent` delivery gets an `agent` job, and one with a live run lease is skipped. A sweep that finds a job already queued adds 0. |
| `relay_agent_runs_total` | counter | `outcome` | One per agent run attempt that reached a result. See below. |
| `relay_agent_tool_calls_total` | counter | `type`, `outcome` | One per agent tool call. See below. |
| `relay_tool_destination_calls_total` | counter | `outcome` | One per agent call to a tool destination. See below. |
| `relay_agent_tools_withheld_total` | counter | `reason` | A tool destination listed on an agent that a run did not offer. One per tool per run. See below. |
| `relay_agent_tokens_total` | counter | `kind` | Tokens used by agent runs. See below. |
| `relay_agent_cost_usd_total` | counter | none | Estimated spend of agent runs in US dollars, as the SDK reports it. A float counter (the registry stores JS numbers), so there is no micro-dollar variant. It is an estimate, not a bill. |
| `relay_actions_total` | counter | `provider`, `type`, `mode`, `outcome` | One per action handled by the `actions` job (`mode="sync"`). See below. |
| `relay_cross_tenant_blocked_total` | counter | `stage` | A route link or delivery paired an event with a destination in another connection, and relay refused it. See below. |
| `relay_classifier_calls_total` | counter | `outcome` | One per `route` job whose event matched at least one gated route (`selection = classifier`, connection mode `shadow` or `enforce`). See below. |
| `relay_classifier_decisions_total` | counter | `mode`, `result` | One per event: counted by the job whose decision was stored. Reuse adds 0. See below. |
| `relay_classifier_tokens_total` | counter | `kind` | Tokens used by classifier calls: `input`, `output`. Counted for every call, including one whose decision lost a race. |
| `relay_provider_app_config_errors_total` | counter | `provider`, `reason` | As on the server. The worker reads the Discord bot token through the store (30 s cache). |

Gateway metrics (`apps/gateway`):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_discord_gateway_connected` | gauge | none | 1 while the Discord Gateway session is ready or resumed. 0 after a close, before the library reconnects. |
| `relay_discord_gateway_leader` | gauge | none | 1 while this process holds the leader lock. A second copy shows 0 and waits. |
| `relay_discord_gateway_closes_total` | counter | `code` | Gateway socket closes by close code. 4004 (bad token) and 4010 to 4014 (4014: disallowed intents) do not reconnect. Saving a new bot token starts a new session without a restart; other causes need a restart. |
| `relay_gateway_configured` | gauge | none | 1 while the leader has a Discord bot token (saved in Relay or `DISCORD_BOT_TOKEN`). 0 while it waits for one. |
| `relay_gateway_token_swaps_total` | counter | none | The bot token changed and the leader replaced its session (one new IDENTIFY). At most one per `GATEWAY_MIN_SWAP_SECONDS` (default 60). The first connect after waiting does not count. |
| `relay_provider_app_config_errors_total` | counter | `provider`, `reason` | As on the server. The leader reads the bot token every `GATEWAY_TOKEN_POLL_SECONDS` (default 30). |
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

## Discord easy connect (server only)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `relay_discord_link_total` | counter | `outcome` | One per identify-step callback (`/oauth/discord/start?step=identify`). `success`, `denied` (Discord sent `error` or no `code`), `not_allowed` (`DISCORD_ALLOWED_USER_IDS` is set and the user is not in it; HTTP 403), `exchange_failed` (token exchange, user lookup, or server list failed, or the code was a bot install code; HTTP 502). A bad or expired state counts in `relay_oauth_callbacks_total{outcome="bad_state"}`. |
| `relay_discord_guild_pick_total` | counter | `kind` | A server was picked in the console. `direct`: the bot was already there and the connection was stored with no Discord round trip. `invite`: the user was sent to Discord to add the bot to that server (counted at `/start?guild_id=`, before the callback). |
| `relay_discord_direct_connect_total` | counter | `outcome` | One per `POST /oauth/discord/connect`. `success`, `bad_grant` (the grant is expired, forged, or issued to another user; 410), `not_in_grant` (the server is not one the user was shown to manage; 403), `not_allowed` (403), `bot_absent` (the bot is not in the server; 409), `owned_elsewhere` (another account owns the server; 409), `error` (500). |

## `relay_oauth_callbacks_total` outcomes

`provider` is `slack` or `discord`.

`success`, `bad_state`, `denied` (the provider sent `error` or no `code`), `exchange_failed` (includes a Discord token response with no server), `not_allowed` (`SLACK_ALLOWED_USER_IDS` or `DISCORD_ALLOWED_USER_IDS` is set and the user is not in it; nothing stored, HTTP 403), `owned_elsewhere` (another Relay account already owns this Slack identity or Discord server; nothing stored, HTTP 409), `guild_mismatch` (Discord only: the redirect's `guild_id`, or the server the signed state was minted for, differs from the server in the token response; nothing stored, HTTP 400). Identify-step callbacks are counted in `relay_discord_link_total` instead, except `bad_state`.

## `relay_router_events_total` outcomes

| Outcome | Meaning |
|---|---|
| `matched` | At least one route matched. Deliveries were created or already existed. |
| `unmatched` | No route matched. This includes routes whose `actor_in` list does not hold the event's actor (or the event has no actor). There is no separate outcome: an `actor_in` miss is an ordinary non-match. |
| `skipped_inactive` | The event's connection isn't `active`. |
| `skipped_echo` | The provider says relay sent this message (Slack: its channel and ts are in `sent_messages`; SMS: the sender is the connection's own number; Discord: the channel and message id are in `sent_messages`, or the actor is the bot user). Marked routed, no deliveries. |
| `classified_none` | Only gated routes matched, and after the classifier (or its fallbacks) none of them gets the event. Marked routed, no deliveries. Shadow mode never gives this. The console shows these as "Not picked" (an `enforce` decision is stored and the event has no deliveries). |
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
| `failed_non_retryable` | Non-retryable response (other 4xx, 3xx), a disabled destination, or a delivery to a tool destination (`not_deliverable`; routes cannot link one). Delivery is `failed`. |

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

`type` is the action name (`reply`, `thread.history`, ...), or `tool` for a call to a tool destination (one label for all of them, so the label set stays small; `relay_tool_destination_calls_total` has the detail). Tool calls the model made that are neither are counted as `type="other"`.

| Outcome | Meaning |
|---|---|
| `succeeded` | The action ran. For `type="tool"`: the endpoint answered 2xx. |
| `failed` | The action failed for good (invalid params, not allowed, a non-retryable Slack error), or the run had already ended. For `type="tool"`: any outcome but `ok` (and the cap, below). |
| `retry` | A temporary failure. The model got an error and may try again. |
| `denied` | Blocked. Either a tool outside the relay list (`type="other"`), or a relay tool called after the run had ended (timeout). |
| `cap_reached` | A mutating call past `maxMutatingActions`. Nothing was sent. Mutating tool destinations share the cap with relay actions. |

## `relay_tool_destination_calls_total` outcomes

| Outcome | Meaning |
|---|---|
| `ok` | 2xx. The body (cut to 16000 chars) went to the model as untrusted data. |
| `timeout` | No full answer within the tool's `timeoutMs`. A mutating call counts as a change (see ADR 0010). |
| `error` | Network error, or the run ended mid-call. A mutating call counts as a change. |
| `http_3xx` | A redirect. Not followed. Not a change. |
| `http_4xx` | The endpoint refused. Not a change. |
| `http_5xx` | Server error. A mutating call counts as a change. |
| `too_large` | The request body was over 64 KB (not sent), or the response passed `maxResponseBytes` (the read stopped; a mutating call counts as a change). |
| `blocked` | Not sent: past `maxMutatingActions`, the run had ended, or the stored URL is not http(s). |
| `invalid` | The args failed the tool's schema. Not sent. |

The model gets only the outcome code and status, never the endpoint's error body.

## `relay_agent_tools_withheld_total` reasons

Counted when a run is built. A withheld tool is not in the tool list or the prompt.

| Reason | Meaning |
|---|---|
| `sensitive` | A `sensitive` tool, and the route that made the delivery has no `actor_in` list or the event's actor is not on it. Expected for every event from an untrusted actor. |
| `disabled` | The tool destination is disabled. |
| `missing` | The id is gone, or it is not a tool destination. |
| `invalid` | Its stored config no longer parses (for example a name that is now reserved). |
| `name_collision` | Its name matches a relay action tool or another tool in the run. Writes reject this, so it needs a hand-edited row or a new relay action. |

A tool destination in another connection is not counted here. It goes to `relay_cross_tenant_blocked_total{stage="agent_tool"}`.

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
| `agent_tool` | An agent's `toolDestinationIds` named a tool destination in another connection. That tool was skipped. The run went on without it. One per tool per run. |

All four should stay at 0. A non-zero count means a bad row from before accounts, or a bug.

## `relay_console_mutations_total`

Changes made through the console API that succeeded. Labels `resource` and `action`.

| Resource | Actions |
|---|---|
| `connection` | `create`, `revoke`, `update` (`create` covers webhook and SMS connections; `update` is `PUT /classifier`, the classifier mode and daily limit, from the console's Routes page or the API) |
| `destination` | `create`, `update`, `delete`, `rotate_secret` (all kinds: `http`, `agent`, `tool`) |
| `route` | `create`, `update`, `delete`, `enable`, `disable` |
| `event` | `replay` |
| `delivery` | `replay` |
| `token` | `revoke` |

## `relay_provider_app_config_errors_total` reasons

Emitted by the server, the worker, and the gateway. `decrypt`, `validate`, and `db` are counted by the provider app store each time it loads a provider's settings from the database (at most once per cache TTL per process). `unavailable` is counted per request.

| Reason | Meaning |
|---|---|
| `decrypt` | A saved secret does not decrypt (wrong `RELAY_MASTER_KEY`, or a corrupt row). The provider is `invalid`. Env is not used. |
| `validate` | The row decrypts but a value fails validation. The provider is `invalid`. Env is not used. |
| `db` | The read failed. The last good value is kept if there is one. |
| `unavailable` | Server only: a request to `/hooks/slack`, `/oauth/slack/*`, or `/oauth/discord/*` was answered 503 because the provider is `invalid`. |

## `relay_provider_app_tests_total` results

| Result | Meaning |
|---|---|
| `ok` | Every check that can run passed. The Slack signing secret is never testable and does not count against this. |
| `failed` | The provider rejected a value (bad secret, bad token, or a token from a different app). |
| `error` | The provider could not be reached, timed out, or answered something unexpected. |
| `incomplete` | A check was skipped because a value is missing (Discord from env without all three values). |
| `not_configured` | The provider is `missing` or `invalid`. No request was sent. |
