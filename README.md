# relay

Relay is a personal event-ingest service. Providers like Slack send it events. Relay checks each event's signature, saves it, and puts it on a queue. A worker picks it up from there.

Milestone 1 covers ingest only. The worker logs each job and does nothing else yet. Routing, destinations, and actions come later.

## Layout

| Path | What it is |
|---|---|
| `apps/server` | Hono HTTP server: ingress, Slack OAuth, `/metrics`, `/healthz` |
| `apps/worker` | pg-boss consumer (stub `route` handler) |
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
