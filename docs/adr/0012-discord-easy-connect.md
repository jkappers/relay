# ADR 0012: Connecting a Discord server takes two clicks

Status: accepted (M12e)

## Decision

Adding a Discord server no longer starts on Discord's server picker. The user links Discord once, picks a server in the console, and Relay either connects it on the spot (the bot is already there) or sends them to Discord with that server preselected.

No new dependencies. No migration. Discord has no way to register an app or install a bot from the API (checked on docs.discord.com, 2026-10-27), so one shared app and bot stays, as in ADR 0008 and ADR 0011.

## Flow

1. **Link** (`/oauth/discord/start?step=identify`). Scope `identify guilds`: no `bot`, no `permissions`. The callback exchanges the code, calls `GET /users/@me` and `GET /users/@me/guilds` with the user token (`limit=200`, then `after` the last id), and drops the token. Nothing about the user token is stored. `/users/@me/guilds` needs the `guilds` scope; `permissions` is a string and `owner` is a boolean.
2. **Filter.** Keep a server if `owner` is true, or `permissions` has MANAGE_GUILD (`1 << 5`) or ADMINISTRATOR (`1 << 3`). `BigInt` math, because permissions pass 2^53.
3. **Grant.** The callback signs the filtered list (below) and redirects to `/#/new/discord/servers/<grant>`. The console posts the grant to `POST /oauth/discord/guilds`, which marks the servers the bot is in (bot-token `GET /users/@me/guilds`, paged). If that call fails, every server shows as "Add bot".
4. **Pick.**
   - Bot present: `POST /oauth/discord/connect {grant, guildId}` connects it with no Discord round trip.
   - Bot absent: the console links to `/oauth/discord/start?guild_id=<id>`. That is the existing bot install with `guild_id=<id>&disable_guild_select=true` added.
5. The old one-step flow (`/oauth/discord/start`, no params) is unchanged, for users who skip linking.

## The grant

`base64url(JSON{u, d, g, e}) . base64url(HMAC-SHA256(grantKey, body))`

- `u`: the Relay user it was issued to. `d`: the Discord user id. `g`: `[id, name]` pairs, only servers that passed the filter, at most 200. `e`: expiry, 15 minutes.
- `grantKey` is `HMAC(master, 'relay/discord-guild-grant/v1')`, separate from the OAuth state key, so a state can't be passed off as a grant or the reverse.
- It is stateless and not stored. It lives in the URL fragment, which the browser never sends to a server, and in POST bodies.
- `/guilds` and `/connect` need the console session (SameSite=Strict cookie) and the `X-Relay-Console` header, and the grant's `u` must equal the session user. A grant copied to another account or browser session is refused (410).
- `/connect` accepts only a guild id that is in the signed list. The bot being in a server proves nothing about the user, so a server missing from the list is refused (403) even if the bot is there. The bot's presence is checked again at connect time (409 `bot_absent`).
- The connection's `user_id` is `d` (the Discord user who proved they manage it), and `DISCORD_ALLOWED_USER_IDS` is checked against `d` both at the link step and at connect.
- A grant can be used more than once inside its 15 minutes. That only repeats connects the user was entitled to, and `upsertInstall` is idempotent per owner.

## State is bound to its step

The OAuth state now carries a step: `install`, `identify`, or `install-<guild id>`. The step is inside the HMAC. The callback reads the step from the verified state and runs only that step's code, so a state minted for one step can't complete the other. The identify step also refuses a token response that includes a server (a bot code), and a token without the `guilds` scope. The bot step still needs a `guild` in the token response.

`install-<guild id>` pins the server the console sent the user to. The callback refuses a token-response server that differs from it (400, `guild_mismatch`), even when Discord's redirect carries no `guild_id`. The old check stays: a redirect `guild_id` that differs from the token response's server is refused. The server always comes from the token response.

## What stays

The Lax nonce cookie plus signed state at the callback (the console session cookie is SameSite=Strict and doesn't arrive on Discord's redirect), `DISCORD_ALLOWED_USER_IDS`, and one owner per server (409 `owned_elsewhere`). Loop guard and bot-message dropping are untouched. Tests stub all HTTP.

## Not done

- **Sign in with Discord as an account login.** Same `identify` scope, but it needs a linked-identity table, a migration from `pnpm db:generate`, passwordless users, and a decision on `SIGNUP_MODE` and account linking. Its own milestone.
- `prompt=none` on the link URL, to skip the consent screen on repeat links. Not verified against the docs yet.
- A user in more than 200 manageable servers sees the first 200.
