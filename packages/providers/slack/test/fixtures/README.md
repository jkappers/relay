# Slack fixtures

All fixtures here are **doc-derived**. None are real captures yet. Real captures need a live Slack app and come later.

Source: the example payloads on docs.slack.dev, checked 2026-10-24.

| File | Source page | Changes from the doc example |
|---|---|---|
| `message_im.json` | `/reference/events/message.im` | Trailing comma removed. |
| `message_channels.json` | `/reference/events/message.channels` | Trailing comma removed. |
| `message_groups.json` | `/reference/events/message.groups` | Trailing comma removed. |
| `message_channels_thread_reply.json` | Built from `message_channels.json` | Added `thread_ts` and `parent_user_id`, new `ts` and `event_id`. |
| `message_changed.json` | `/reference/events/message/message_changed` | Trailing comma removed. |
| `message_deleted.json` | `/reference/events/message/message_deleted` | Trailing comma removed. |
| `thread_broadcast.json` | `/reference/events/message/thread_broadcast` | Trailing comma removed. |
| `bot_message.json` | `/reference/events/message/bot_message` | Trailing comma removed. The doc's `authorizations[0]` has no `user_id`; kept as-is. |
| `file_share.json` | `/reference/events/message/file_share` | Added `"subtype": "file_share"` (the doc example omits it). Dropped thumbnail URLs. |
| `tokens_revoked.json` | `/reference/events/tokens_revoked` | None. |
| `url_verification.json` | `/reference/events/url_verification` | The page shows field names only. `token` and `challenge` values are made up. |

Doc quirks worth knowing:

- `message_changed`, `message_deleted`, and `bot_message` examples have no `channel_type`. The normalizer falls back to the channel ID prefix (`D`, `C`, `G`).
- `bot_message` has no `channel` at all, so its type is plain `slack.message`.
- Not yet confirmed: whether posts made with a user token arrive with no `bot_id`. Capture this when the real app exists.
