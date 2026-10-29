# ADR 0008: SMS through Twilio

Status: accepted (M7)

## Decision

Add an `sms` provider for Twilio. One connection is one Twilio number. No new dependencies: the signature check is HMAC-SHA1 from `node:crypto`, and sends are plain `fetch`.

## Connection

- `provider='sms'`, `team_id` = Account SID, `user_id` = the number in E.164. The existing unique index on `(provider, team_id, user_id)` stops the same number from being connected twice (the API answers 409).
- The Twilio auth token is stored encrypted as the new credential kind `sms_auth_token`. It both verifies inbound signatures and authenticates sends. Migration `0007` adds the enum value.
- The webhook URL is per connection: `$PUBLIC_URL/hooks/sms/<connection id>`. The connection is known before the signature check, like the generic webhook.

## Inbound

- Twilio posts `application/x-www-form-urlencoded`. Ingress learned `bodyFormat: 'form'` on the adapter, and `ack()` so Twilio gets empty TwiML instead of an empty body. Slack and webhook behavior is unchanged.
- Signature: `X-Twilio-Signature` is base64 HMAC-SHA1 of the full URL plus each param's name and value, names sorted (repeated names: distinct values, sorted). Checked against twilio-node's `getExpectedTwilioSignature`. The URL is built from `PUBLIC_URL`, not the request, because relay sits behind a proxy. Both the port-less and explicit-port forms are tried, as the SDK does.
- Twilio signs no timestamp, so there is no replay window. A replayed request carries the same `MessageSid`, and the dedup key `connectionId:MessageSid` makes it a `duplicate`.
- The body's `AccountSid` must equal the connection's, or the request is treated as an unknown connection.
- Envelope: type `sms.message.received`, `actor` and `channelId` = `From`, `messageId` = `MessageSid`, no thread. Media is left in `raw`.

## Outbound

- Action `send`, param `body`. Target is the source event's sender, from the connection's number, in line with the rule that actions only reach the source event's context. Sends use `POST /2010-04-01/Accounts/{sid}/Messages.json` with basic auth.
- Records `sentMessage {channel: to, ts: sid}` so it is in `sent_messages` like Slack posts.

## Loop guard

An SMS cannot echo like a Slack post. The only loop is another relay-owned number texting this one, so `isSelfEcho` is true when the sender is the connection's own number. The `sent_messages` lookup is kept as a second check.

## Not in scope

MMS sending, status callbacks, Messaging Services as sender, STOP/opt-out handling beyond what Twilio does itself.
