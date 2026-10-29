# relay

Relay is a personal event-ingest service. Providers like Slack send it events. Relay checks each event's signature, saves it, and puts it on a queue. A worker picks it up from there.

Milestones 1 to 5 are done: ingest, routing, signed HTTP delivery with retries, actions (reply, react, and more) with a loop guard, agent destinations that run Claude on an event, and a web console.

## How an event flows

1. Ingress verifies and stores the event, then queues a `route` job.
2. The router loads the event. If its connection isn't active, it stops.
3. Each enabled route that matches creates one delivery per destination. A unique index on `(event, route, destination)` means routing an event twice never makes duplicates.
4. The dispatcher POSTs each `http` delivery to its destination, signed. One attempt per job. For an `agent` destination it queues an `agent` job instead (see Agents below).
5. 2xx means `succeeded`. Network errors, timeouts, 408, 429, and 5xx retry with exponential backoff and full jitter (5s base, 15 min cap, up to the destination's `max_attempts`). A numeric `Retry-After` on a 429 is honored, up to the cap. Other responses (other 4xx, 3xx) fail at once. Redirects are not followed.
6. A sweeper in the worker runs at startup and every minute. It requeues `route` jobs for events that were enqueued but never routed (`routed_at` is null) and `dispatch` jobs (`agent` jobs for agent deliveries) for deliveries stuck `pending`, if they are older than the grace period. Queued jobs are keyed by event or delivery id (queue policy `short`), so a sweep never adds a second waiting job. Max 100 rows per kind per sweep.
7. A delivery that runs out of attempts, or fails at once, is `failed`. Replay it with the CLI.
8. If a succeeded delivery returned `{actions: [...]}`, an `actions` job runs them (see Actions below).
9. Before routing, the router drops events that relay itself posted (see Loop guard below).

A route matches when it is enabled, the connection filter fits (empty means any), and:

- `event_type` equals the type, or ends in `*` and the type starts with the prefix (`slack.message.*`).
- `text_contains` (case-insensitive) is in the text, if set.
- `text_regex` matches the text, if set. Max 200 characters, checked when saved. It has no flags.
- The envelope has no `subtype`, unless `include_subtypes` is on.

Events with no text never match a text filter.

## Layout

| Path | What it is |
|---|---|
| `apps/server` | Hono HTTP server: ingress, Slack OAuth, `POST /actions`, `/metrics`, `/healthz`, the console API (`/api`), and the built console |
| `apps/console` | The web console: Vite + React. Built files go to `apps/console/dist` |
| `apps/worker` | pg-boss consumers: router, dispatcher, actions, and agent runs, plus `/metrics` and `/healthz` |
| `packages/core` | Config, crypto, DB schema and migrations, queue, envelope, provider interface, metrics |
| `packages/providers/slack` | Slack adapter: signature check, normalize, OAuth |
| `packages/providers/webhook` | Generic signed-webhook adapter |
| `packages/destinations/agent` | Agent runner (Claude Agent SDK), tool set, prompts |

## Run it

Needs Node 24, pnpm 10, and Docker.

```sh
cp .env.example .env          # then fill in the values
docker compose up -d --wait   # Postgres 17 on localhost:54329
pnpm install
pnpm db:migrate
pnpm dev:server               # http://localhost:$PORT
pnpm dev:worker
```

Run all checks (install, typecheck, migration drift, tests):

```sh
scripts/check.sh
```

Tests use the `relay_test` database. Compose creates it on first start, so tests never touch dev data.

## Environment

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | server, worker, CLI | Postgres URL |
| `RELAY_MASTER_KEY` | server, worker, CLI | 32 random bytes, base64. Encrypts stored tokens and secrets. Startup fails if it's missing or the wrong size. |
| `CONSOLE_PASSWORD` | server | Console login password. At least 16 characters. Required. |
| `PORT` | server | Default 3000 |
| `PUBLIC_URL` | server, worker | Public HTTPS base URL. The OAuth `redirect_uri` is `$PUBLIC_URL/oauth/slack/callback`. The worker sends `$PUBLIC_URL/actions` to destinations. |
| `SLACK_API_BASE_URL` | server, worker | Slack Web API base. Default `https://slack.com/api`. Change only to stub Slack in tests. |
| `REPLY_TOKEN_TTL_SECONDS` | worker | How long a reply token lives. Default 3600. |
| `SLACK_SIGNING_SECRET` | server | From the Slack app's Basic Information page |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | server | Same page |
| `SLACK_ALLOWED_USER_IDS` | server | Required. Comma-separated Slack user IDs that may connect. Others get a 403 and nothing is stored. |
| `WORKER_METRICS_PORT` | worker | Default 9465. Serves `/metrics` and `/healthz`. |
| `DISPATCH_BACKOFF_BASE_MS`, `DISPATCH_BACKOFF_CAP_MS` | worker | Retry backoff. Defaults 5000 and 900000. |
| `SWEEP_INTERVAL_SECONDS`, `SWEEP_GRACE_SECONDS` | worker | How often the sweeper runs (60) and how old stuck work must be before it is requeued (300). |
| `WORKER_POLL_SECONDS` | worker | Queue poll interval. Default 2, minimum 0.5. |
| `ANTHROPIC_API_KEY` | worker | Needed to run agents. Not needed otherwise. If it is missing, agent runs fail with `missing_api_key` and the worker keeps running. Never logged. |
| `AGENT_CONCURRENCY` | worker | How many agent runs at once. Default 1. |
| `AGENT_BACKOFF_BASE_MS`, `AGENT_BACKOFF_CAP_MS` | worker | Retry backoff for agent runs that fail before any change. Defaults 15000 and 300000. |
| `RELAY_AGENT_RUNNER` | worker | `sdk` (default) or `fake`. `fake` posts a canned reply with no API call, for tests and demos. Refused when `NODE_ENV=production`. |
| `TEST_DATABASE_URL` | tests | Optional. Defaults to `relay_test` in compose. |

Make a master key:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Endpoints

| Route | Purpose |
|---|---|
| `POST /hooks/slack` | Slack Events API Request URL |
| `POST /hooks/webhook/:connectionId` | Generic webhook |
| `POST /actions` | Async actions, with a reply token. See Actions. |
| `GET /oauth/slack/start` | Starts Slack OAuth (user scopes only) |
| `GET /oauth/slack/callback` | Slack OAuth redirect target |
| `GET /` | The web console (static files, with fallback to `index.html`) |
| `/api/*` | Console API. Needs a console session. |
| `GET /metrics` | Prometheus text. See `docs/metrics.md`. |
| `GET /healthz` | 200 when the DB answers |

The worker serves `GET /metrics` and `GET /healthz` on `WORKER_METRICS_PORT`.

## Admin CLIs

The console does everything these do. They still work. Run from the repo root with `pnpm --filter @relay/server <script>`. 
| Script | Does |
|---|---|
| `destinations:create --name N --url U [--max-attempts 8] [--timeout-ms 10000] [--allowed-actions reply,react]` | Creates an HTTP destination. Prints its id and signing secret once. |
| `destinations:create --kind agent --name N --system-prompt-file F [--model M] [--max-turns 8] [--timeout-seconds 300] [--max-mutating-actions 3] [--allowed-actions thread.history,reply]` | Creates an agent destination. See Agents. |
| `agent-runs:list [--status failed]` | Lists the 100 newest agent runs: id, delivery, status, turns, tokens, cost. |
| `routes:create --name N --event-type T --destination ID [--destination ID...] [--connection ID] [--contains S] [--regex R] [--include-subtypes]` | Creates a route. |
| `routes:list` | Lists routes. |
| `tokens:revoke <jti>` | Revokes a reply token. Find the jti in `deliveries.last_reply_jti`. |
| `deliveries:list [--status failed]` | Lists the 100 newest deliveries. |
| `deliveries:replay <deliveryId>` | Resets a `failed` delivery to `pending` with 0 attempts and queues it. |
| `events:replay <eventId>` | Queues the event for routing again. Existing deliveries are kept. Only new matches (a new route, a new destination) create deliveries. |

## Console

A small web UI for the one owner. It does what the CLIs do, and it shows the event log.

Open it:

```sh
pnpm build:console   # writes apps/console/dist
pnpm dev:server      # then open http://localhost:$PORT
```

Sign in with `CONSOLE_PASSWORD`. Pages: Overview, Connections, Destinations, Routes (with a live match preview), Events (with raw and normalized JSON, deliveries, and replay), and Deliveries (with a failed filter and replay).

Secrets (a new webhook secret, a new destination secret, a rotated secret) show once in a copy box. Relay keeps only an encrypted copy.

Work on the UI with hot reload. Run the server, then:

```sh
pnpm dev:console     # http://localhost:5173, proxies /api and /oauth to the server
```

If the server is not on port 3000, set `RELAY_SERVER_URL`.

Security notes:

- One user, one password. There are no accounts. Pick a long password and serve the console over HTTPS.
- The session is a signed cookie: `HttpOnly`, `SameSite=Strict`, `Secure` when `PUBLIC_URL` is https. It lasts 12 hours. Signing out clears it in your browser. Changing `RELAY_MASTER_KEY` ends every session.
- After 5 wrong passwords from one address in 15 minutes, login returns 429. The counter is in memory and resets on restart.
- Every change needs the `X-Relay-Console: 1` header. The cookie's `SameSite=Strict` is a second guard against CSRF.
- `/oauth/slack/start` needs a console session. Before, anyone could start it. The callback still checks its state and `SLACK_ALLOWED_USER_IDS`.
- Event text comes from other people. The UI only shows it as plain text, and the page runs under a strict Content-Security-Policy.
- Details are in `docs/adr/0005-console.md`.

## Agents

An `agent` destination does not POST anywhere. The worker runs a Claude agent on the event, with the [Claude Agent SDK](docs/adr/0004-agent-sdk.md). The agent can use relay's actions for that event, and nothing else. It can read the thread and reply as you.

Config (stored on the destination):

| Field | Default | Meaning |
|---|---|---|
| `systemPrompt` | required | Your instructions. Relay adds a fixed preamble before it. |
| `model` | `claude-sonnet-5-5` | Model ID. |
| `maxTurns` | 8 | Most tool round trips per run. |
| `timeoutSeconds` | 300 | Wall-clock limit per run. |
| `maxMutatingActions` | 3 | Most Slack changes (reply, post, react, update) per run. Past that, tools return an error. |

`--allowed-actions` picks which tools exist. An action that is not allowed is not offered to the agent at all.

How a run goes: the dispatcher queues an `agent` job. The delivery stays `pending` until the run ends, then becomes `succeeded` or `failed`. Agent jobs have their own queue, so slow runs never hold up `http` deliveries. If a run fails before it changed anything, it is retried (3 attempts, with backoff). **If it fails after it changed something, it is never run again**, so you never get a second reply. It is marked `failed` with `error = not_retried_after_mutation`. The sweeper requeues stuck agent deliveries, and a lease on the run row means two jobs can never run the same delivery at once. `agent-runs:list` shows the outcome, and the run row keeps the final text and the tool calls.

### Security model

Anyone who can message you controls the event text, so **prompt injection is expected**. The design assumes the model may obey it. What holds even then:

- The agent has no shell, files, web, or other Claude Code tools. Only relay's action tools exist, and a tool the destination does not allow is missing.
- It loads none of your settings, CLAUDE.md, MCP servers, hooks, or skills. It runs in an empty temp directory with a minimal environment.
- It cannot pick a channel or thread. Every action goes to the source event's thread, as in Actions above.
- It is capped by turns, time, and Slack changes per run.
- The prompt tells the model the event is untrusted data. That helps, but it is not the main control.

What can still happen: a crafted message may make the agent post an unwanted reply in that same thread, as you, up to the cap. Pick a prompt, a small `--allowed-actions` list, and a low cap with that in mind. Replies appear publicly as you.

### Cost and limits

You pay for the Anthropic API calls. Each run records turns, tokens, and the SDK's cost estimate (an estimate, not a bill). Costs are bounded by `maxTurns`, `timeoutSeconds`, retries (3 attempts), and `AGENT_CONCURRENCY`. Watch `relay_agent_cost_usd_total` and `relay_agent_tokens_total` (see `docs/metrics.md`).

## Verify a delivery

Relay sends `POST <url>` with a JSON body: the stored envelope plus `delivery: { id, attempt }`.

| Header | Value |
|---|---|
| `Relay-Delivery-Id` | Delivery id. Use it to dedupe, since retries resend the same id. |
| `Relay-Event-Id` | Event id |
| `Relay-Timestamp` | Unix seconds |
| `Relay-Signature` | `sha256=` + hex HMAC-SHA256 of `{timestamp}.{rawBody}`, keyed with the destination secret |
| `User-Agent` | `relay/<version>` |

Same scheme as the inbound webhook. Check against the raw body, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, headers, rawBody) {
  const ts = headers['relay-timestamp']
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  const got = headers['relay-signature'] ?? ''
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}
```

Reply with any 2xx. If the reply is JSON up to 64 KB, relay stores it on the delivery. If it holds `{"actions": [...]}`, relay runs them.

## Actions

A destination can act back on the Slack event it got: reply in the thread, react, update a message relay sent, or read the thread.

**Safety rule:** every action targets only the source event's context (its channel, thread, and message). A destination can never pick another channel, thread, or message. Extra params like `channel` are ignored.

| Action | Params | Does | Changes Slack |
|---|---|---|---|
| `reply` | `text` | Posts in the event's thread (`thread_ts` is the thread's parent, or the message itself if it isn't in a thread) | yes |
| `post` | `text` | Posts in the same channel, not in a thread | yes |
| `react` | `name` | Adds an emoji reaction to the event's message. `already_reacted` counts as success. | yes |
| `update` | `messageId`, `text` | Edits a message. Only allowed if relay sent it (it must be in `sent_messages` for this connection and channel). | yes |
| `thread.history` | `limit` (1 to 100, default 50) | Returns `{messages: [{ts, user, text, thread_ts}], hasMore}` | no |

Limit what a destination may do with `--allowed-actions` when you create it. Unset means all actions. If none remain, the envelope has no `reply` block.

### Sync: return actions in the response

```json
{ "actions": [{ "type": "reply", "text": "got it" }, { "type": "react", "name": "eyes" }] }
```

Max 20 actions. Relay runs them after it marks the delivery `succeeded`. The array index is the idempotency key. Read-only results (`thread.history`) are not returned on this path, so use the async API to read.

### Async: call `/actions`

Each delivery envelope has `reply: { actionsUrl, token, allowed }`. The token works for about an hour (`REPLY_TOKEN_TTL_SECONDS`) and only for that delivery. A retried delivery gets a new token.

```sh
curl -X POST "$ACTIONS_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"actions":[{"type":"react","name":"eyes","idempotencyKey":"react-1"},{"type":"thread.history","limit":10}]}'
```

Response `200`: `{"results":[{"type":"react","status":"succeeded","result":{}}, ...]}`. Per action, `status` is `succeeded`, `failed` (with `error`), `in_progress`, or `retry`. On `retry`, send it again with the same key (`retryAfterSeconds` and a `Retry-After` header show when, if Slack said so).

| Status | Meaning |
|---|---|
| 401 | Bad, expired, or revoked token, unknown delivery, or revoked connection. No detail. |
| 403 | An action type isn't in the token's `allowed` list. Nothing ran. |
| 400 | Bad body or params, more than 20 actions, or a mutating action with no `idempotencyKey`. Nothing ran. |
| 413 | Body over 64 KB. |

### Idempotency

- Actions that change Slack are logged in `actions_log`, unique on `(delivery, idempotency key)`. Async callers must send `idempotencyKey` (1 to 200 chars) on each of them.
- Sending the same key again returns the stored result and does not call Slack. The same key with different params is a `failed` result.
- A `pending` row under 60 s old means another run is in flight (`in_progress`). Over 60 s, relay assumes a crash and runs it again.
- **At least once, not exactly once.** If relay crashes after Slack accepts a post but before it saves the result, the re-run can post twice. The same goes for a network error where Slack did get the call.
- Slack errors: 429 (honors `Retry-After`), `ratelimited`, 5xx, `internal_error`, `service_unavailable` and network errors are retried. Other errors (`channel_not_found`, `not_in_channel`, ...) fail at once. After 8 tries an action fails for good.
- Sync actions that still need a retry are retried by the queue (5 retries with backoff). The sweeper also requeues succeeded deliveries whose actions never finished.

## Loop guard

Posts made with your user token look like your own messages. When an action posts, relay records the channel and ts in `sent_messages` in the same transaction that marks the action done. The router skips any event that matches (`skipped_echo`).

The echo can arrive before that row is committed. So if the event's actor is the connection's own user and nothing matched, the router waits 5 s and checks once more (`echo_recheck`), only for events under 30 s old. A message you send yourself that relay did not post (like a DM to yourself) is still routed after the recheck.

## Point a Slack app at relay

1. Create a Slack app. Copy its signing secret, client ID, and client secret into `.env`.
2. Expose the server over HTTPS and set `PUBLIC_URL` to that address.
3. **OAuth & Permissions**
   - Add the redirect URL `$PUBLIC_URL/oauth/slack/callback`.
   - Add these **user** token scopes: `chat:write`, `im:history`, `channels:history`, `groups:history`, `reactions:write`, `users:read`. Don't add bot scopes.
4. **Event Subscriptions**
   - Set the Request URL to `$PUBLIC_URL/hooks/slack`. Relay answers the `url_verification` check.
   - Under "Subscribe to events on behalf of users", add `message.im`, `message.channels`, and `message.groups`. Add `tokens_revoked` as well (it needs no scope).
5. Open `$PUBLIC_URL/oauth/slack/start` in a browser and approve. Relay stores your user token, encrypted.

## Generic webhook

Create a connection. The secret prints once:

```sh
pnpm --filter @relay/server connections:create-webhook
```

Send events to `POST /hooks/webhook/<connection id>` with these headers:

| Header | Value |
|---|---|
| `X-Relay-Timestamp` | Unix seconds. Must be within 5 minutes of server time. |
| `X-Relay-Signature` | `sha256=` + hex HMAC-SHA256 of `{timestamp}.{rawBody}`, keyed with the secret |
| `X-Relay-Event-Id` | Optional. Used for dedup. Without it, relay dedups on the body's SHA-256. |

The body must be JSON. The event type becomes `webhook.<body.type>`, or `webhook.event` if `type` is missing.

## Ingress behavior

| Case | Response |
|---|---|
| Accepted | 200. The event row and the `route` job commit in one transaction. |
| Duplicate | 200. On Slack, also `X-Slack-No-Retry: 1`. If the stored event was never enqueued, relay enqueues it now. |
| Bad or stale signature | 401 |
| Unknown or revoked connection | 200. Nothing is stored. |
| Slack `tokens_revoked` | 200. Matching connections become `revoked`. |
| Body isn't JSON | 400 |
