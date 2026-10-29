# relay

Relay is an event-ingest service. Providers like Slack and Discord send it events. Relay checks each event's signature, saves it, and puts it on a queue. A worker picks it up from there.

Milestones 1 to 11 are done: ingest, routing, signed HTTP delivery with retries, actions (reply, react, and more) with a loop guard, agent destinations that run Claude on an event, a web console, user accounts with each connection as its own tenant, SMS through Twilio, classifier routing (an LLM gate that can only narrow matched routes), and tool destinations (operator-registered HTTP tools an agent can call).

## How an event flows

1. Ingress verifies and stores the event, then queues a `route` job.
2. The router loads the event. If its connection isn't active, it stops.
3. Each enabled route of the event's connection that matches creates one delivery per destination. A unique index on `(event, route, destination)` means routing an event twice never makes duplicates.
4. The dispatcher POSTs each `http` delivery to its destination, signed. One attempt per job. For an `agent` destination it queues an `agent` job instead (see Agents below).
5. 2xx means `succeeded`. Network errors, timeouts, 408, 429, and 5xx retry with exponential backoff and full jitter (5s base, 15 min cap, up to the destination's `max_attempts`). A numeric `Retry-After` on a 429 is honored, up to the cap. Other responses (other 4xx, 3xx) fail at once. Redirects are not followed.
6. A sweeper in the worker runs at startup and every minute. It requeues `route` jobs for events that were enqueued but never routed (`routed_at` is null) and `dispatch` jobs (`agent` jobs for agent deliveries) for deliveries stuck `pending`, if they are older than the grace period. Queued jobs are keyed by event or delivery id (queue policy `short`), so a sweep never adds a second waiting job. Max 100 rows per kind per sweep.
7. A delivery that runs out of attempts, or fails at once, is `failed`. Replay it with the CLI.
8. If a succeeded delivery returned `{actions: [...]}`, an `actions` job runs them (see Actions below).
9. Before routing, the router drops events that relay itself posted (see Loop guard below).
10. If any matched route is gated by the classifier, one classifier call decides which of those gated routes get the event (see Classifier routing below).

A route belongs to one connection and only sees that connection's events. It matches when it is enabled and:

- `event_type` equals the type, or ends in `*` and the type starts with the prefix (`slack.message.*`).
- `text_contains` (case-insensitive) is in the text, if set.
- `text_regex` matches the text, if set. Max 200 characters, checked when saved. It has no flags.
- The envelope has no `subtype`, unless `include_subtypes` is on.
- The envelope's `actor` is in `actor_in`, if that list is set. Exact, case-sensitive match. An empty or missing list means anyone.

Events with no text never match a text filter. Events with no actor never match an `actor_in` list.

`actor_in` is the deterministic guard for routes that must only fire for certain people. How far you can trust the actor depends on the provider: Slack and Discord set it from the signed event (the user ID). SMS sets it to the `From` number, which Twilio signs but which carriers do not verify, so treat it as a filter, not an identity check. Webhook events have no actor, so an `actor_in` route never matches them. A route that misses on `actor_in` is just not matched: the event counts as `unmatched` (or matches other routes) and never reaches the classifier.

## Layout

| Path | What it is |
|---|---|
| `apps/server` | Hono HTTP server: ingress, Slack and Discord OAuth, `POST /actions`, `/metrics`, `/healthz`, the console API (`/api`), and the built console |
| `apps/console` | The web console: Vite + React. Built files go to `apps/console/dist` |
| `apps/worker` | pg-boss consumers: router, dispatcher, actions, and agent runs, plus `/metrics` and `/healthz` |
| `apps/gateway` | Discord Gateway client. One copy at a time (Postgres advisory lock). Stores mentions and DMs. `/metrics` and `/healthz` |
| `packages/core` | Config, crypto, DB schema and migrations, queue, envelope, provider interface, metrics |
| `packages/providers/slack` | Slack adapter: signature check, normalize, OAuth |
| `packages/providers/discord` | Discord: normalize, connection lookup, REST actions, OAuth bot install |
| `packages/providers/webhook` | Generic signed-webhook adapter |
| `packages/providers/sms` | Twilio SMS adapter: signature check, normalize, `send` action |
| `packages/destinations/agent` | Agent runner (Claude Agent SDK), tool set, prompts |
| `packages/classifier` | Classifier for gated routes: Anthropic Messages API call, prompt, label mapping, fake |

## Run it

Needs Node 24, pnpm 10, and Docker.

```sh
cp .env.example .env          # then fill in the values
docker compose up -d --wait   # Postgres 17 on localhost:54329
pnpm install
pnpm db:migrate
printf '%s' 'a long passphrase' | pnpm --filter @relay/server users:create --email you@example.com --admin
pnpm build:console
pnpm dev:server               # http://localhost:$PORT
pnpm dev:worker
pnpm dev:gateway              # only if you use Discord
```

Then sign in. As an admin, open **Settings** in the rail (or in the header before you have connections) and follow the steps on the Slack and Discord cards to set up each app. With no connections yet, the console asks you to add one: connect Slack, add a Discord server, or create a signed webhook. Connect Slack and Add Discord server show up for everyone once that provider is Ready. Until then, admins see a Set up link, other users see "Ask your admin to set up ...", and if no admin exists yet the console says to run `users:grant-admin`.

Run all checks (install, typecheck, migration drift, tests):

```sh
scripts/check.sh
```

Tests use the `relay_test` database. Compose creates it on first start, so tests never touch dev data. Set `TEST_DATABASE_URL` to use another one (each run drops and re-creates its tables).

## Environment

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | server, worker, gateway, CLI | Postgres URL |
| `RELAY_MASTER_KEY` | server, worker, gateway, CLI | 32 random bytes, base64. Encrypts stored tokens and secrets. Startup fails if it's missing or the wrong size. |
| `SIGNUP_MODE` | server | `closed` (default) or `open`. When closed, accounts come only from `users:create`. When open, anyone who can reach the console can sign up. |
| `PORT` | server | Default 3000 |
| `PUBLIC_URL` | server, worker | Public HTTPS base URL. The OAuth `redirect_uri` is `$PUBLIC_URL/oauth/<slack or discord>/callback`. The worker sends `$PUBLIC_URL/actions` to destinations. |
| `SLACK_API_BASE_URL` | server, worker | Slack Web API base. Default `https://slack.com/api`. Change only to stub Slack in tests. |
| `SMS_API_BASE_URL` | server, worker | Twilio API base. Default `https://api.twilio.com`. Change only to stub Twilio in tests. |
| `REPLY_TOKEN_TTL_SECONDS` | worker | How long a reply token lives. Default 3600. |
| `SLACK_SIGNING_SECRET` | server | From the Slack app's Basic Information page. Optional: Slack is on only when this and the two below are all set. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | server | Same page |
| `SLACK_ALLOWED_USER_IDS` | server | Optional. Comma-separated Slack user IDs that may connect. If set, others get a 403 and nothing is stored. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | server | From the Discord app's OAuth2 page. Optional: Discord install is on only when both are set. |
| `DISCORD_BOT_TOKEN` | server, worker, gateway | From the Discord app's Bot page. One token for every Discord connection. Without any bot token (here or saved in Settings), the gateway waits for one and Discord actions fail with `no_credentials`. |
| `DISCORD_API_BASE_URL` | server, worker | Discord REST base. Default `https://discord.com/api/v10`. Change only to stub Discord in tests. |
| `DISCORD_ALLOWED_USER_IDS` | server | Optional. Comma-separated Discord user IDs that may install the bot. If set, others get a 403 and nothing is stored. |
| `GATEWAY_METRICS_PORT` | gateway | Default 9466. Serves `/metrics` and `/healthz`. |
| `GATEWAY_LOCK_POLL_SECONDS` | gateway | How often a waiting copy retries the leader lock, and how often the leader checks it. Default 15. |
| `GATEWAY_TOKEN_POLL_SECONDS` | gateway | How often the leader reads the bot token from Settings (or env). Default 30. |
| `GATEWAY_MIN_SWAP_SECONDS` | gateway | At most one new Gateway session per this many seconds after a token change or a failed connect. Default 60. |
| `WORKER_METRICS_PORT` | worker | Default 9465. Serves `/metrics` and `/healthz`. |
| `DISPATCH_BACKOFF_BASE_MS`, `DISPATCH_BACKOFF_CAP_MS` | worker | Retry backoff. Defaults 5000 and 900000. |
| `SWEEP_INTERVAL_SECONDS`, `SWEEP_GRACE_SECONDS` | worker | How often the sweeper runs (60) and how old stuck work must be before it is requeued (300). |
| `WORKER_POLL_SECONDS` | worker | Queue poll interval. Default 2, minimum 0.5. |
| `ANTHROPIC_API_KEY` | worker | Needed to run agents and the classifier. Not needed otherwise. If it is missing, agent runs fail with `missing_api_key`, classifier calls fail and use their fallbacks, and the worker keeps running. Never logged. |
| `AGENT_CONCURRENCY` | worker | How many agent runs at once. Default 1. |
| `AGENT_BACKOFF_BASE_MS`, `AGENT_BACKOFF_CAP_MS` | worker | Retry backoff for agent runs that fail before any change. Defaults 15000 and 300000. |
| `RELAY_AGENT_RUNNER` | worker | `sdk` (default) or `fake`. `fake` posts a canned reply with no API call, for tests and demos. Refused when `NODE_ENV=production`. |
| `RELAY_CLASSIFIER` | worker | `anthropic` (default) or `fake`. `fake` picks routes whose intent shares a word with the text, with no API call, for tests and demos. Refused when `NODE_ENV=production`. |
| `TEST_DATABASE_URL` | tests | Optional. Defaults to `relay_test` in compose. |

The `SLACK_*` and `DISCORD_*` app settings (signing secret, client id and secret, bot token, allowed user ids) are deprecated in favor of Settings: an instance admin saves them through `/api/admin/integrations`, encrypted in the database. Env stays a fallback: it applies only while no settings are saved for that provider. Once saved, the database wins. If saved settings can't be decrypted or fail validation (for example after changing `RELAY_MASTER_KEY`), the provider is marked invalid and env is not used. See [ADR 0011](docs/adr/0011-instance-admins-and-provider-apps.md).

Changes apply without a restart. The server reads the settings per request (5 s cache): `/hooks/slack`, `/oauth/slack/*`, and `/oauth/discord/*` are always mounted and answer 404 while a provider is not set up and 503 while its saved settings are invalid. The worker reads the Discord bot token per action (30 s cache). The gateway checks the bot token every `GATEWAY_TOKEN_POLL_SECONDS`: with none it waits instead of exiting, and when the token changes it closes its session and opens one with the new token (at most one per `GATEWAY_MIN_SWAP_SECONDS`). A new Slack signing secret takes effect at once, and the previous one is still accepted for 24 hours. An install set up only through env vars works as before.

Make a master key:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Endpoints

| Route | Purpose |
|---|---|
| `POST /hooks/slack` | Slack Events API Request URL |
| `POST /hooks/webhook/:connectionId` | Generic webhook |
| `POST /hooks/sms/:connectionId` | Twilio inbound SMS webhook |
| `POST /actions` | Async actions, with a reply token. See Actions. |
| `GET /oauth/slack/start` | Starts Slack OAuth (user scopes only). Needs a console session. |
| `GET /oauth/slack/callback` | Slack OAuth redirect target. Sends you back to the console. |
| `GET /oauth/discord/start` | Starts the Discord bot install. Needs a console session. |
| `GET /oauth/discord/callback` | Discord OAuth redirect target. Sends you back to the console. |
| `GET /` | The web console (static files, with fallback to `index.html`) |
| `/api/*` | Console API. See below. |

Console API. Everything needs a session except signing in and signing up.

| Route | Purpose |
|---|---|
| `POST /api/session` | Sign in with `{email, password}`. Sets the session cookie. |
| `GET /api/session` | `{user, connections, signup, adminExists}`. `user.isAdmin` marks an instance admin. Signed out, it answers 401 with `signup`. |
| `DELETE /api/session` | Sign out. The session row is deleted. |
| `POST /api/users` | Sign up with `{email, password}`. Only when `SIGNUP_MODE=open`. |
| `GET /api/connections` | Your connections and your role in each. |
| `POST /api/connections/webhook` | New webhook connection you own. Body `{name?}`. The secret shows once. |
| `POST /api/connections/sms` | New SMS connection you own. Body `{name?, accountSid, number, authToken}`. Returns the webhook `url`. The auth token is never returned. 409 if that number is already connected. |
| `GET /api/connections/slack-url` | Where to start Slack OAuth. |
| `GET /api/connections/providers` | `{slack, discord}`: the install start URL for each, or null when its app settings are missing. |
| `POST /api/tokens/revoke` | Revoke a reply token by `jti`. |
| `/api/c/:connectionId/*` | Everything else, inside one connection: `overview`, `events`, `events/facets`, `events/:id`, `events/:id/replay`, `deliveries`, `deliveries/:id/replay`, `routes`, `routes/preview`, `routes/:id` (and `enable`, `disable`), `events/:id/decision`, `classifier` (`GET`, and `PUT {mode, dailyLimit}`), `destinations`, `destinations/:id`, `destinations/:id/rotate-secret`, `revoke`. `POST destinations` takes `kind` `http`, `agent`, or `tool`; `http` and `tool` return their signing secret once. |

If you are not a member of the connection, or an id belongs to another connection, the answer is 404.
| `GET /metrics` | Prometheus text. See `docs/metrics.md`. |
| `GET /healthz` | 200 when the DB answers |

The worker serves `GET /metrics` and `GET /healthz` on `WORKER_METRICS_PORT`, and the gateway on `GATEWAY_METRICS_PORT`.

## Admin CLIs

The console does most of what these do. Run from the repo root with `pnpm --filter @relay/server <script>`. CLIs talk to the database directly, so they skip account checks.

| Script | Does |
|---|---|
| `users:create --email E [--admin]` | Creates an account. Reads the password (12 to 1024 characters) from stdin. `--admin` makes it an instance admin. |
| `users:grant-admin --email E [--revoke]` | Makes E an instance admin, or with `--revoke` removes it. Applies on that user's next request. Sign-up through the console never grants admin. |
| `users:set-password --email E` | Sets a new password from stdin and signs that user out everywhere. Use it to reset a forgotten password. |
| `tenancy:adopt --email E --connection C` | One-time upgrade from before accounts. See below. |
| `connections:create-webhook --owner E [--name N]` | Creates a webhook connection owned by E. Prints its id and secret once. |
| `destinations:create --connection C --name N --url U [--max-attempts 8] [--timeout-ms 10000] [--allowed-actions reply,react]` | Creates an HTTP destination. Prints its id and signing secret once. |
| `destinations:create --connection C --kind agent --name N --system-prompt-file F [--model M] [--max-turns 8] [--timeout-seconds 300] [--max-mutating-actions 3] [--allowed-actions thread.history,reply] [--tool-destinations ID,ID]` | Creates an agent destination. See Agents. |
| `destinations:create --connection C --kind tool --name N --url U --tool-name T --description D --params-file F [--read-only] [--sensitive] [--timeout-ms 10000] [--max-response-bytes 32768]` | Creates a tool destination. `F` holds the params JSON Schema. Prints its id and signing secret once. See Tool destinations. |
| `agent-runs:list [--status failed]` | Lists the 100 newest agent runs: id, delivery, status, turns, tokens, cost. |
| `routes:create --connection C --name N --event-type T --destination ID [--destination ID...] [--contains S] [--regex R] [--include-subtypes] [--actor-in ID,ID...] [--selection always\|classifier] [--intent TEXT] [--fallback drop\|deliver]` | Creates a route. Every destination must be in connection C. `--actor-in` takes commas or repeats. `--selection classifier` needs `--intent`. |
| `routes:list` | Lists routes, with their actor list and classifier fields. |
| `tokens:revoke <jti>` | Revokes a reply token. Find the jti in `deliveries.last_reply_jti`. |
| `deliveries:list [--status failed]` | Lists the 100 newest deliveries. |
| `deliveries:replay <deliveryId>` | Resets a `failed` delivery to `pending` with 0 attempts and queues it. |
| `events:replay <eventId>` | Queues the event for routing again. Existing deliveries are kept. Only new matches (a new route, a new destination) create deliveries. |

### Upgrade to accounts

Data from before M6 has no owner, and its routes and destinations have no connection. Upgrade in four steps:

```sh
pnpm db:migrate --to 0005_tenancy_tables      # adds the new tables only
printf '%s' 'a long passphrase' | pnpm --filter @relay/server users:create --email you@example.com
pnpm --filter @relay/server tenancy:adopt --email you@example.com --connection <connection id>
pnpm db:migrate                               # makes connection_id required
```

`tenancy:adopt` makes you owner of every connection that has no members. It moves every route and destination with no connection to `--connection`. It never copies or deletes rows. It runs in one transaction, and running it again changes nothing.

Then it lists any route that links a destination in another connection, and exits with code 2. Fix those links by hand (move the destination, or drop the link), then run it again until it exits 0. A plain `pnpm db:migrate` fails until no route or destination is left without a connection.

## Console

A web UI. It does what the CLIs do, and it shows the event log.

Open it:

```sh
pnpm build:console   # writes apps/console/dist
pnpm dev:server      # then open http://localhost:$PORT
```

Sign in with your email and password. If you have no connections, the console shows only "Add a connection". After that, a switcher at the top of the rail picks the connection you are looking at. URLs look like `#/c/<connection id>/events`. Pages: Overview, Connections, Destinations, Routes (with a live match preview, the actor and classifier fields, and the connection's classifier mode and daily limit), Events (with raw and normalized JSON, deliveries, the classifier decision, and replay), and Deliveries (with a failed filter and replay). Each page shows only the current connection.

The Events list has a "Not picked" filter for `classified_none` events: only classifier routes matched, and the classifier (or its fallback) picked none. An event's panel shows its stored classifier decision, if any: mode, model, status, error code, latency, tokens, and each candidate label with its route and whether it was picked.

Secrets (a new webhook secret, a new destination secret, a rotated secret) show once in a copy box. Relay keeps only an encrypted copy.

Work on the UI with hot reload. Run the server, then:

```sh
pnpm dev:console     # http://localhost:5173, proxies /api and /oauth to the server
```

If the server is not on port 3000, set `RELAY_SERVER_URL`.

Security notes:

- Each connection is a tenant. You only see connections you are a member of. Anything else answers 404, so ids can't be probed.
- Passwords are hashed with scrypt (N=2^13, r=8, p=10). A wrong password and an unknown email take the same time and get the same answer.
- The session lives in the database. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when `PUBLIC_URL` is https. It lasts 12 hours. Signing out deletes the session. `users:set-password` ends all of that user's sessions.
- After 5 failed sign-ins from one address, or 10 for one email, in 15 minutes, sign-in returns 429. The counters are in memory and reset on restart.
- Every change needs the `X-Relay-Console: 1` header. The cookie's `SameSite=Strict` is a second guard against CSRF.
- `/oauth/slack/start` needs a console session. The callback checks its signed state, which names your account. A Slack account can belong to only one Relay account. If someone else already connected it, you get a 409 and nothing changes.
- Event text comes from other people. The UI only shows it as plain text, and the page runs under a strict Content-Security-Policy.
- Details are in `docs/adr/0005-console.md`.

Instance admins (granted only by `users:create --admin` or `users:grant-admin`) see a **Settings** item in the rail. It is an account-level page at `#/settings`, outside any connection, so it works before the admin has connections. Other users don't see it, and opening the URL sends them back. It has one card per provider with:

- a badge (Ready, Needs setup, Problem) and where the settings come from (From server environment, Set in Relay), plus the connection count;
- a numbered setup guide with portal links and copy buttons for the redirect and event addresses. For Slack, a link creates the app from a manifest with Relay's scopes, events, and addresses filled in. Paste the secrets into Relay and save first, then click Retry on Slack's Event Subscriptions page. The guide also covers Public Distribution;
- the form. Secrets are password fields that are never filled in. A saved secret shows "Set on <date> by <email>", and leaving it blank keeps it. The first save in Relay needs every secret, even if the server environment has them. "Advanced" sets who can connect: anyone with a Relay account, or only listed Slack or Discord member IDs;
- status: the Discord bot's state from the gateway (online, reconnecting, rejected token with its close code), and the last time Relay accepted a signed Slack request;
- a Test button (runs only when clicked), Remove (go back to the server environment settings), and a warning when `PUBLIC_URL` is not https or points at this machine.

Changing the client ID while connections exist opens a dialog: type the provider name to confirm that those connections will stop working.

`GET /api/session` returns `user.isAdmin` and `adminExists` (whether any admin exists), which the console uses for these hints.

The API behind it is `/api/admin/integrations`: the shared Slack and Discord app settings, a Test button per provider, and the redirect and event URLs to paste into each developer portal. Others get 404 there. Secrets are write-only: the API reports whether each is set, never its value. Changing the client id (or a Discord bot token from another app) while connections exist needs `confirmClientIdChange: true`, since every existing connection of that provider stops working. See [ADR 0011](docs/adr/0011-instance-admins-and-provider-apps.md).

## Agents

An `agent` destination does not POST anywhere. The worker runs a Claude agent on the event, with the [Claude Agent SDK](docs/adr/0004-agent-sdk.md). The agent can use relay's actions for that event, and nothing else. It can read the thread and reply as you.

Config (stored on the destination):

| Field | Default | Meaning |
|---|---|---|
| `systemPrompt` | required | Your instructions. Relay adds a fixed preamble before it. |
| `model` | `claude-sonnet-5-5` | Model ID. |
| `maxTurns` | 8 | Most tool round trips per run. |
| `timeoutSeconds` | 300 | Wall-clock limit per run. |
| `maxMutatingActions` | 3 | Most changes per run: Slack or Discord changes (reply, post, react, update) plus calls to mutating tool destinations. Past that, tools return an error. |
| `toolDestinationIds` | `[]` | Tool destinations (same connection only) the agent may call. See Tool destinations. |

`--allowed-actions` picks which tools exist. An action that is not allowed is not offered to the agent at all.

How a run goes: the dispatcher queues an `agent` job. The delivery stays `pending` until the run ends, then becomes `succeeded` or `failed`. Agent jobs have their own queue, so slow runs never hold up `http` deliveries. If a run fails before it changed anything, it is retried (3 attempts, with backoff). **If it fails after it changed something, it is never run again**, so you never get a second reply. It is marked `failed` with `error = not_retried_after_mutation`. The sweeper requeues stuck agent deliveries, and a lease on the run row means two jobs can never run the same delivery at once. `agent-runs:list` shows the outcome, and the run row keeps the final text and the tool calls.

### Security model

Anyone who can message you controls the event text, so **prompt injection is expected**. The design assumes the model may obey it. What holds even then:

- The agent has no shell, files, web, or other Claude Code tools. Only relay's action tools and the tool destinations you attached exist, and a tool the destination does not allow is missing.
- It loads none of your settings, CLAUDE.md, MCP servers, hooks, or skills. It runs in an empty temp directory with a minimal environment.
- It cannot pick a channel or thread. Every action goes to the source event's thread, as in Actions above.
- It is capped by turns, time, and Slack changes per run.
- The prompt tells the model the event is untrusted data, and so are tool results (`thread_history` returns other people's messages). That helps, but it is not the main control.

What can still happen: a crafted message may make the agent post an unwanted reply in that same thread, as you, up to the cap. Pick a prompt, a small `--allowed-actions` list, and a low cap with that in mind. Replies appear publicly as you.

### Tool destinations

A `tool` destination is an HTTP endpoint you register in a connection. An agent destination in the same connection can list it in `toolDestinationIds`, and the agent can then call it as one tool. It is not an MCP server: you write the name, description, and params, and the worker makes the call. Design: `docs/adr/0010-tool-destinations.md`.

| Field | Default | Meaning |
|---|---|---|
| `url` | required | http or https. Fixed. The model can never change it. |
| `toolName` | required | Lowercase slug, max 48. Unique in the connection. Relay action names (`reply`, `thread_history`, ...) are reserved. |
| `description` | required | What the model is told the tool does. |
| `params` | required | JSON Schema subset: `{type: "object", properties, required?}` with `string`, `number`, `integer`, `boolean` (optional `enum`, length and range limits), or an `array` of those (max 50 items). Max 20 params. Anything else is rejected when you save. |
| `mutating` | true | Counts toward `maxMutatingActions` and sets the run's changed flag (no rerun after it). |
| `sensitive` | false | Offered only when the route that made the delivery has an `actor_in` list that holds the event's actor. |
| `timeoutMs` | 10000 | Max 30000. |
| `maxResponseBytes` | 32768 | Max 262144. A bigger response is an error. |

Each call is `POST <url>` with JSON `{tool: {name, call}, args, event, delivery: {id}, run: {id}}` (`event` is the envelope without `raw`). Headers are the ones in [Verify a delivery](#verify-a-delivery), signed the same way with the tool's own secret, plus `Relay-Run-Id`, `Relay-Tool`, and `Idempotency-Key` (`agent:<runId>:<n>` for mutating calls, `agent:<runId>:r<n>` for read-only ones). Dedupe on that key. Redirects are not followed. Answer 2xx with any body; the model sees it (up to 16000 chars) as untrusted data. On any other answer the model sees only `error: http_4xx (404)` and the like.

Mutating calls are logged in `actions_log` as type `tool:<toolName>`, so they show with the event's actions in the console. A timeout, network error, 5xx, or oversize 2xx on a mutating call counts as a change, since relay cannot know whether the endpoint acted.

Treat every arg as attacker-controlled: event text can steer the agent to call the tool with anything the schema allows. Verify the signature, validate args, and mark anything risky `sensitive` with an `actor_in` route.

### Cost and limits

You pay for the Anthropic API calls. Each run records turns, tokens, and the SDK's cost estimate (an estimate, not a bill). Costs are bounded by `maxTurns`, `timeoutSeconds`, retries (3 attempts), and `AGENT_CONCURRENCY`. Watch `relay_agent_cost_usd_total` and `relay_agent_tokens_total` (see `docs/metrics.md`).

## Classifier routing

A route can be gated by a classifier. The deterministic match still runs first. The classifier can only narrow: of the gated routes that matched, it picks which get the event. It can never add a route, pick a destination, or see a URL. Design and trade-offs: `docs/adr/0009-classifier-routing.md`.

Route fields (console API):

| Field | Default | Meaning |
|---|---|---|
| `selection` | `always` | `always` delivers on match. `classifier` delivers on match only if the classifier picks it. |
| `intent` | none | What events this route is for, in plain words. Required for `classifier`. Max 500 chars. This is all the model sees of the route. |
| `classifierFallback` | `drop` | What a gated route does when there is no usable answer (timeout, error, refusal, bad output, or over the daily limit): `drop` or `deliver`. |
| `actorIn` | none | Actor IDs the route is limited to (max 100, each 1 to 200 chars, trimmed, deduped). `[]` or `null` clears it. Deterministic, checked before the classifier. |

On `PUT /routes/:id`, leaving out `selection`, `intent`, `classifierFallback`, or `actorIn` keeps the stored value. An old client that does not know a field can't clear it by accident.

`GET /events/:id/decision` returns `{decision: null}` or the stored decision: `mode`, `model`, `status` (`ok`, `fallback`, `budget_exceeded`), `error`, `latencyMs`, `inputTokens`, `outputTokens`, `createdAt`, `candidates` (`label`, `routeId`, `routeName`, `selected`), and `selected`. Route names come only from the path connection; a deleted route shows `routeName: null`.

Connection settings (`GET`/`PUT /api/c/:connectionId/classifier`, body `{mode, dailyLimit}`):

| Field | Default | Meaning |
|---|---|---|
| `mode` | `off` | `off`: `classifier` routes act like `always` and nothing is called. `shadow`: call and record, but deliver every gated route. `enforce`: deliver only what the classifier picks. |
| `dailyLimit` | 1000 | Most calls per UTC day (0 to 100000), counted from stored decisions. Over it, there is no call and the fallbacks apply. |

How it runs:

- One call per event, with `claude-haiku-5-5`, structured output limited to the labels `r1..rn`, 5 s timeout, 1 retry. Gated routes are shown only as a label plus their intent. Labels outside the set are dropped.
- The first decision is stored in `route_decisions` and is final. Retries, rechecks, sweeps, and replays reuse it, intersected with the routes that match now. A gated route added later never gets that event.
- Echoes are dropped before the classifier, so they never reach it.
- Event text is untrusted. Injected text can at most change which of the matched gated routes get the event. Never use a classifier route as the only guard in front of a high-risk destination. Use deterministic filters for that, such as `actor_in`. The console's route form says the same.
- Watch `relay_classifier_calls_total`, `relay_classifier_decisions_total`, and `relay_classifier_tokens_total` (see `docs/metrics.md`).

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

A destination can act back on the Slack or Discord event it got: reply in the thread, react, update a message relay sent, or read the thread. The table shows Slack. See [Discord](#discord) for how each action works there.

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

On Discord, the gateway drops every message written by a bot, so Relay's own posts never become events. The router still checks `sent_messages` and the bot's user id, and skips the 5 s recheck.

## Point a Slack app at relay

The easy way: as an admin, open Settings in the console and follow the Slack card. The steps below are the manual way, with env vars.

1. Create a Slack app. Copy its signing secret, client ID, and client secret into `.env`.
2. Expose the server over HTTPS and set `PUBLIC_URL` to that address.
3. **OAuth & Permissions**
   - Add the redirect URL `$PUBLIC_URL/oauth/slack/callback`.
   - Add these **user** token scopes: `chat:write`, `im:history`, `channels:history`, `groups:history`, `reactions:write`, `users:read`. Don't add bot scopes.
4. **Event Subscriptions**
   - Set the Request URL to `$PUBLIC_URL/hooks/slack`. Relay answers the `url_verification` check.
   - Under "Subscribe to events on behalf of users", add `message.im`, `message.channels`, and `message.groups`. Add `tokens_revoked` as well (it needs no scope).
5. Sign in to the console and press Connect Slack (or open `$PUBLIC_URL/oauth/slack/start`). Approve. Relay stores your user token, encrypted, in a connection you own, then sends you to its Routes page.

## Discord

A Discord connection is the Relay bot in one Discord server. The bot posts as itself. Discord has no way to post as a user. See [ADR 0008](docs/adr/0008-discord-gateway.md). The console connects a server in two steps: link Discord to list the servers you manage, then pick one. Servers the bot is already in connect at once; for the others, Discord opens with that server preselected. See [ADR 0012](docs/adr/0012-discord-easy-connect.md).

What comes in:

- Only messages that mention the bot (`discord.message.mention`) and DMs to the bot (`discord.message.dm`). Relay does not ask for the Message Content intent, and without it Discord sends no text for other messages.
- Messages from bots and webhooks are dropped, including Relay's own.
- A DM goes to every active connection you installed. DMs from anyone else are dropped.
- If the bot is removed from the server, the connection becomes `revoked`.

Actions work as in the table above, with these changes:

- Every post sets `allowed_mentions: {parse: []}`, so nothing Relay sends pings `@everyone`, a role, or a person.
- `reply` replies to the event message (`message_reference`). In a thread, it posts in that thread.
- `react` takes `emoji`: a Unicode emoji like `👍`, or `name:id` for a custom one.
- `update` takes `messageId`, the id of a message Relay sent.
- `thread.history` returns `{messages: [{messageId, user, bot, text, timestamp}], hasMore}`, oldest first, from the event's channel or thread. Other people's messages that do not mention the bot have empty text.
- Results have `messageId`, not `ts`.

### Point a Discord app at relay

The easy way: as an admin, open Settings in the console and follow the Discord card. The steps below are the manual way, with env vars.

1. Create a Discord app. Copy its client ID and client secret (OAuth2 page) and bot token (Bot page) into `.env`.
2. On the Bot page, leave the privileged intents off. Relay needs none.
3. On the OAuth2 page, add the redirect URL `$PUBLIC_URL/oauth/discord/callback`.
4. Run `pnpm dev:gateway` next to the server and worker. Only one copy connects. A second one waits.
5. Sign in to the console and press Add Discord server. Pick a server and approve. Relay checks the server named in Discord's token response and sends you to the new connection's Routes page.

Restart the gateway with a delay of a minute or more. Each fresh start counts against Discord's limit of 1000 logins a day. A bot token change does not need a restart: the gateway picks it up within `GATEWAY_TOKEN_POLL_SECONDS` and starts one new session. If Discord rejects the token (close code 4004), the gateway stops and waits for a different token.

## Generic webhook

Create one in the console (Connections, then New webhook), or with the CLI. The secret prints once:

```sh
pnpm --filter @relay/server connections:create-webhook --owner you@example.com --name Deploys
```

Send events to `POST /hooks/webhook/<connection id>` with these headers:

| Header | Value |
|---|---|
| `X-Relay-Timestamp` | Unix seconds. Must be within 5 minutes of server time. |
| `X-Relay-Signature` | `sha256=` + hex HMAC-SHA256 of `{timestamp}.{rawBody}`, keyed with the secret |
| `X-Relay-Event-Id` | Optional. Used for dedup. Without it, relay dedups on the body's SHA-256. |

The body must be JSON. The event type becomes `webhook.<body.type>`, or `webhook.event` if `type` is missing.

## SMS (Twilio)

One connection per Twilio number. Create it in the console (Connections, then New SMS) with the number (E.164), the Account SID, and the auth token. Relay stores the token encrypted and uses it both to check inbound signatures and to send.

In the Twilio console, set the number's "A message comes in" webhook to `$PUBLIC_URL/hooks/sms/<connection id>` with HTTP POST. The URL must match what Twilio signs, so set `PUBLIC_URL` to the exact public origin.

- Inbound events have type `sms.message.received`. `actor` and `context.channelId` are the sender's number, `context.messageId` is the `MessageSid`, and `text` is `Body`. Media URLs stay in the raw payload only; `subtype` is `media` when `NumMedia` is above 0.
- Relay answers Twilio with empty TwiML, so it never auto-replies.
- Action `send` (param `body`, 1 to 1600 chars) texts the sender from the connection's number. Like Slack actions, it can only target the source event's sender.
- Twilio errors: 429, 5xx and network errors are retried. Other errors fail at once with code `twilio_<code>` when Twilio gave one.
- Loop guard: an inbound message from the connection's own number is skipped (`skipped_echo`).
- Not supported yet: MMS sending, delivery status callbacks, Messaging Services as the sender.

## Ingress behavior

| Case | Response |
|---|---|
| Accepted | 200. The event row and the `route` job commit in one transaction. |
| Duplicate | 200. On Slack, also `X-Slack-No-Retry: 1`. If the stored event was never enqueued, relay enqueues it now. |
| Bad or stale signature | 401 |
| Unknown or revoked connection | 200. Nothing is stored. |
| Slack `tokens_revoked` | 200. Matching connections become `revoked`. |
| Body isn't JSON (SMS: bodies are form-encoded, so this can't happen) | 400 |
