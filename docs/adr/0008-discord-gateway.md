# ADR 0008: Discord comes in over the Gateway, through one bot

Status: accepted (M8)

## Decision

Discord is the second chat provider. A Discord connection is one bot installed in one Discord server. Relay reads messages over the Gateway WebSocket in a new process, `apps/gateway`, and acts through Discord's REST API with plain `fetch`.

New dependencies, in `apps/gateway` only:

- `@discordjs/ws` 2.0.4 (exact pin). It opens the Gateway socket, sends heartbeats, resumes after a drop, and handles sharding.
- `@discordjs/rest` 2.6.3 (exact pin). `@discordjs/ws` needs it to fetch `GET /gateway/bot`. Relay does not use it for actions.

Both come from the discord.js project (Apache-2.0). They bring `ws`, `discord-api-types`, and a few small helpers. `discord-api-types` resolved to 0.38.57, published 2026-10-19, which is newer than we like. It is types and enums only. Pin it with a pnpm override if that matters later.

## Why the Gateway

Checked on docs.discord.com, 2026-10-25:

- `MESSAGE_CREATE` is a Gateway event only. Discord's HTTP webhook events cover app, entitlement, and lobby events, not messages. So a socket is the only way to see messages.
- The Gateway socket is authenticated by the bot token, so there is no signature to check. The gateway writes to Postgres directly with the shared `storeAndEnqueue`. The route, deliver, and agent pipeline runs unchanged.
- Writing our own Gateway client means heartbeats, resume, zombie detection, rate limits on sends, and close-code rules. The library already does this well. We use only its socket layer, not the full `discord.js` client.

## What we ingest

- Intents: `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES` (4609). Never `MESSAGE_CONTENT`. It is privileged and needs a Discord review once the bot is in 100 or more servers.
- Without it, message text is empty except for DMs to the bot, messages that mention the bot, and the bot's own messages. So we keep only DMs and mentions. Other messages are counted and dropped.
- Messages from any bot or webhook are dropped at the gateway. This includes our own bot, so a bot reply can never start a loop.
- Event types: `discord.message.mention` and `discord.message.dm`. `context.channelId` is the channel, `threadId` is the thread channel (types 10, 11, 12) or null, and `messageId` is the message snowflake. The `<@bot>` mention is removed from `text`.
- Dedup key: `<connection id>:<message id>`. A DM can go to more than one connection, so the message id alone is not enough.

## Bot identity

- Discord has no way to post as a user. The bot posts as itself. One app-level `DISCORD_BOT_TOKEN` serves every connection. Connections store no credentials.
- The agent prompt says replies appear "as the Relay bot, visible to the channel", not as the user.
- Every bot send sets `allowed_mentions: {parse: []}`, so an agent cannot ping `@everyone`, roles, or people.
- `sent_messages` keeps its `channel, ts` columns. For Discord, `ts` holds the message snowflake. The name is naming debt we accept to avoid a migration.

## Install

- `/oauth/discord/start` sends the user to `https://discord.com/oauth2/authorize` with `scope=bot applications.commands identify`, `permissions` (view channel, send messages, send in threads, read history, add reactions), and `response_type=code`.
- The callback exchanges the code. The token response includes the `guild` the bot joined. We trust that, not the `guild_id` in the redirect, which Discord calls a hint. A redirect `guild_id` that does not match is refused (400). We call `GET /users/@me` with the user token to learn who installed it.
- One connection per server: `team_id` = server id, `user_id` = installer. If another Relay account already owns that server, the callback answers 409 and stores nothing. A reinstall by the owner reactivates the connection. The same state, nonce cookie, and allow-list (`DISCORD_ALLOWED_USER_IDS`) apply as for Slack.

## DMs

A DM has no server. A DM from Discord user X goes to every active connection where X is the installer. DMs from anyone else are dropped and counted in `relay_discord_dm_unrouted_total`.

## Lifecycle

`GUILD_DELETE` without an `unavailable` field means the bot was removed from the server. The connection is revoked, like Slack's `tokens_revoked`. With `unavailable: true` it is an outage, and nothing changes.

## One gateway at a time

- The gateway holds a session-level Postgres advisory lock on its own connection. A second copy waits and retries. So a double deploy cannot open two sessions and ingest every message twice.
- That connection never recycles itself. If it dies anyway, the next check sees a new backend pid, and the process stops so a supervisor can restart it as a waiter.
- Discord allows 1000 IDENTIFY calls a day. Going over ends every session and resets the bot token. Relay never re-identifies on its own. The library resumes after drops. Bad-token and bad-intent closes do not reconnect.
- Known risk: a process that crash-loops identifies once per start. Session info is kept in memory only, so a restart cannot resume. Keep the restart delay long (a minute or more). Storing session info in Postgres is a later step.

## Actions

Plain `fetch` to REST v10 (`DISCORD_API_BASE_URL`, stubbed in tests):

- `reply`: `POST /channels/{id}/messages` with `message_reference` to the event message.
- `post`: the same without a reference.
- `react`: `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me`. A Unicode emoji or `name:id`, URL-encoded.
- `update`: `PATCH` a message, only one Relay sent (checked in `sent_messages`).
- `thread.history`: `GET /channels/{id}/messages?limit=n`. Without the content intent, other people's messages that do not mention the bot come back with empty text.

Errors: 429 is retryable, after `retry_after` (seconds, a float) or the rate-limit headers. 5xx and network errors are retryable. Other 4xx are not. JSON error codes map to names, such as 50013 to `missing_permissions`.

## Alternatives

- **Interactions (slash commands) over HTTP.** No socket and no long-running process. But users would have to type a command instead of talking to the bot, and DMs would not work the same way. Kept as a later option: the `applications.commands` scope is already requested.
- **`discord.js`.** The full client caches every server, channel, and member in memory. We need none of that.
