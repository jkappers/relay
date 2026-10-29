# ADR 0003: Reply tokens are plain HMAC tokens, not JWTs

Status: accepted (M3)

## Decision

A reply token is `base64url(json).base64url(hmac)`. The JSON is `{ jti, did, exp, allowed[] }`: token id, delivery id, expiry (Unix seconds), and the action types it may use. The HMAC is SHA-256 over the base64url JSON string. The key is derived from `RELAY_MASTER_KEY` with the label `relay/reply-token/v1`, the same way OAuth state is.

## Why not a JWT library

- Relay both issues and verifies these tokens. No third party reads them.
- There is one algorithm and one key. JWT's algorithm negotiation (`alg`, `none`, key confusion) is attack surface we would have to switch off.
- It avoids a new dependency. Node's `crypto` is enough, and the code is about 80 lines.

## Rules

- The dispatcher mints a new token on every delivery attempt, bound to the delivery id. The jti is saved in `deliveries.last_reply_jti`, so it can be revoked with `tokens:revoke <jti>`.
- TTL is `REPLY_TOKEN_TTL_SECONDS` (default 3600). Older tokens stay valid until they expire or are revoked.
- `allowed` is the destination's `allowed_actions` (null means all) intersected with the provider runtime's action names. If it is empty, the envelope has no `reply`.
- `/actions` checks, in order: signature (constant-time), expiry, `revoked_tokens`, that the delivery exists, that its connection is `active`, then each action type against `allowed`. Failures return 401 with no detail, except a disallowed type (403).
- The token never carries a channel, thread, or message id. Those always come from the stored source event, so a destination can only act on the context it was given.

## Changing the format

The `v1` label is part of the key. A new format uses a new label, which makes all old tokens fail.
