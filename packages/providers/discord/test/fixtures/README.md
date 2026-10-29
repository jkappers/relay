# Discord fixtures

All fixtures here are **doc-derived**. None are real captures yet. Real captures need a live Discord app and come later.

Source: docs.discord.com, checked 2026-10-25.

The bot user is `1100000000000000001` (made up). The server is `2909267986347357250`, the id in the OAuth token response example.

| File | Source page | Changes from the doc example |
|---|---|---|
| `message_create_mention.json` | `/developers/resources/message` "Example Message", wrapped as a `MESSAGE_CREATE` dispatch (`/developers/events/gateway-events#message-create`) | Dropped `reactions`. Added `guild_id`, `channel_type: 0`, `member`, the bot in `mentions`, and `<@bot>` in `content`. |
| `message_create_thread_mention.json` | Built from `message_create_mention.json` | `channel_type: 11` (public thread), new `id` and `channel_id`, mention at the end. No `member`. |
| `message_create_dm.json` | Built from the Example Message | `channel_type: 1`, no `guild_id`, new `id` and `channel_id`. |
| `message_create_no_mention.json` | Built from the Example Message | In a server, no mention. `content` is empty, as Discord sends it without the MESSAGE_CONTENT intent. |
| `message_create_bot_author.json` | Built from `message_create_mention.json` | `author.bot: true` (another bot). |
| `guild_delete_removed.json` | `/developers/events/gateway-events#guild-delete` | An unavailable guild object with no `unavailable` field: the bot was removed. |
| `guild_delete_unavailable.json` | Same | `unavailable: true`: an outage. Must not revoke. |
| `ready.json` | `/developers/events/gateway-events#ready` | The page lists fields only. All values are made up. |
| `oauth_token_response.json` | `/developers/topics/oauth2` "Advanced Bot Authorization" token response | `scope` changed to the three scopes Relay asks for. The `guild` object is cut down to a few fields. |

Doc quirks worth knowing:

- `MESSAGE_CREATE` has `channel_type`, so threads (10, 11, 12) and DMs (1) are told apart without a channel lookup.
- `guild_id` on `MESSAGE_CREATE` is also missing for ephemeral messages. The normalizer treats a missing `guild_id` as a DM only when `channel_type` is missing too.
