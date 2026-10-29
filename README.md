# relay

Relay is a personal event-ingest service. Providers like Slack send it events. Relay checks each event's signature, saves it, and puts it on a queue. A worker picks it up from there.

Milestones 1 and 2 are done: ingest, routing, and signed HTTP delivery with retries. Actions and agents come later.

## How an event flows

1. Ingress verifies and stores the event, then queues a `route` job.
2. The router loads the event. If its connection isn't active, it stops.
3. Each enabled route that matches creates one delivery per destination. A unique index on `(event, route, destination)` means routing an event twice never makes duplicates.
4. The dispatcher POSTs each delivery to its destination, signed. One attempt per job.
5. 2xx means `succeeded`. Network errors, timeouts, 408, 429, and 5xx retry with exponential backoff and full jitter (5s base, 15 min cap, up to the destination's `max_attempts`). A numeric `Retry-After` on a 429 is honored, up to the cap. Other responses (other 4xx, 3xx) fail at once. Redirects are not followed.
6. A sweeper in the worker runs at startup and every minute. It requeues `route` jobs for events that were enqueued but never routed (`routed_at` is null) and `dispatch` jobs for deliveries stuck `pending`, if they are older than the grace period. Queued jobs are keyed by event or delivery id (queue policy `short`), so a sweep never adds a second waiting job. Max 100 rows per kind per sweep.
7. A delivery that runs out of attempts, or fails at once, is `failed`. Replay it with the CLI.

A route matches when it is enabled, the connection filter fits (empty means any), and:

- `event_type` equals the type, or ends in `*` and the type starts with the prefix (`slack.message.*`).
- `text_contains` (case-insensitive) is in the text, if set.
- `text_regex` matches the text, if set. Max 200 characters, checked when saved. It has no flags.
- The envelope has no `subtype`, unless `include_subtypes` is on.

Events with no text never match a text filter.

## Layout

| Path | What it is |
|---|---|
| `apps/server` | Hono HTTP server: ingress, Slack OAuth, `/metrics`, `/healthz` |
| `apps/worker` | pg-boss consumers: router and dispatcher, plus `/metrics` and `/healthz` |
| `packages/core` | Config, crypto, DB schema and migrations, queue, envelope, provider interface, metrics |
| `packages/providers/slack` | Slack adapter: signature check, normalize, OAuth |
| `packages/providers/webhook` | Generic signed-webhook adapter |

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
| `PORT` | server | Default 3000 |
| `PUBLIC_URL` | server | Public HTTPS base URL. The OAuth `redirect_uri` is `$PUBLIC_URL/oauth/slack/callback`. |
| `SLACK_SIGNING_SECRET` | server | From the Slack app's Basic Information page |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | server | Same page |
| `SLACK_ALLOWED_USER_IDS` | server | Required. Comma-separated Slack user IDs that may connect. Others get a 403 and nothing is stored. |
| `WORKER_METRICS_PORT` | worker | Default 9465. Serves `/metrics` and `/healthz`. |
| `DISPATCH_BACKOFF_BASE_MS`, `DISPATCH_BACKOFF_CAP_MS` | worker | Retry backoff. Defaults 5000 and 900000. |
| `SWEEP_INTERVAL_SECONDS`, `SWEEP_GRACE_SECONDS` | worker | How often the sweeper runs (60) and how old stuck work must be before it is requeued (300). |
| `WORKER_POLL_SECONDS` | worker | Queue poll interval. Default 2, minimum 0.5. |
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
| `GET /oauth/slack/start` | Starts Slack OAuth (user scopes only) |
| `GET /oauth/slack/callback` | Slack OAuth redirect target |
| `GET /metrics` | Prometheus text. See `docs/metrics.md`. |
| `GET /healthz` | 200 when the DB answers |

The worker serves `GET /metrics` and `GET /healthz` on `WORKER_METRICS_PORT`.

## Admin CLIs

Temporary until the console. Run from the repo root with `pnpm --filter @relay/server <script>`. 
| Script | Does |
|---|---|
| `destinations:create --name N --url U [--max-attempts 8] [--timeout-ms 10000]` | Creates an HTTP destination. Prints its id and signing secret once. |
| `routes:create --name N --event-type T --destination ID [--destination ID...] [--connection ID] [--contains S] [--regex R] [--include-subtypes]` | Creates a route. |
| `routes:list` | Lists routes. |
| `deliveries:list [--status failed]` | Lists the 100 newest deliveries. |
| `deliveries:replay <deliveryId>` | Resets a `failed` delivery to `pending` with 0 attempts and queues it. |
| `events:replay <eventId>` | Queues the event for routing again. Existing deliveries are kept. Only new matches (a new route, a new destination) create deliveries. |

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

Reply with any 2xx. If the reply is JSON up to 64 KB, relay stores it on the delivery. Nothing acts on it yet.

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
