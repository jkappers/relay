# ADR 0007: Connections are tenants, and people sign in with accounts

Status: accepted (M6)

## Decision

The connection is the tenant. Every event, route, destination, delivery, action, and agent run belongs to exactly one connection. People sign in with an email and a password. A user is a member of one or more connections.

No new dependencies.

## Data

- `users`: email (unique, case-insensitive) and a password hash.
- `sessions`: one row per sign-in. The cookie holds a random 32-byte token. The table stores only its SHA-256.
- `connection_members`: (connection, user, role). The only role today is `owner`. There is no invite flow yet.
- `routes.connection_id` and `destinations.connection_id` are `NOT NULL`. A route can only link destinations in its own connection.
- Deliveries, actions, and agent runs have no new column. They reach their tenant through `event → connection`.
- `connections.name` is a label for the switcher.

Two migrations: the first adds the tables and nullable columns. The second sets `NOT NULL`. `tenancy:adopt` runs between them to give old rows an owner and a connection. It never copies or deletes rows, because deliveries point at routes and destinations with no cascade.

## Isolation

- Tenant API calls live under `/api/c/:connectionId/...`. One middleware checks that the signed-in user is a member of that connection. Every query in those handlers filters by it. Query params cannot widen the scope.
- A user who is not a member gets **404, never 403**. An id from another connection also gets 404. So ids cannot be probed. A test walks every tenant route as another user and checks for 404 and no changed rows.
- The router only matches routes of the event's connection. It skips a route link to a destination in another connection.
- The dispatcher and the agent handler check again, right before they send anything: if the destination's connection is not the event's connection, the delivery fails with `cross_tenant`. No HTTP call is made and no reply token is minted. Replays and the sweeper pass through here too, so an old bad row cannot leak.
- `POST /api/tokens/revoke` stays account-level. Jtis are random, revoking one only stops a token, and a lookup would miss older live tokens because `last_reply_jti` is overwritten on each attempt.

## Passwords

`node:crypto` scrypt, not argon2, so there is no native dependency.

- Parameters: **N = 2^13, r = 8, p = 10**, 16-byte salt, 32-byte key. This is the lowest-memory option in the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) (its list runs from N=2^17, r=8, p=1 at 128 MiB down to N=2^13, r=8, p=10 at 8 MiB). OWASP says the options give a similar level of defense. The trade-off is memory against CPU. We pick 8 MiB because the server is one process, and N=2^17 would need 128 MiB per check.
- `maxmem`: the [Node docs](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) say scrypt errors when about `128 * N * r > maxmem` (default 32 MiB). For our N and r that is exactly 8 MiB, and OpenSSL needs a little more (a check at exactly 8 MiB fails). We set `maxmem` to 2 × 128 × N × r = 16 MiB.
- At most 4 hashes run at once (libuv's default thread pool is also 4). Up to 64 more wait. Past that, sign-in answers 503. So a flood of sign-ins uses at most about 32 MiB for hashing.
- The hash is self-describing: `scrypt$N=8192,r=8,p=10$<salt>$<hash>` (base64url). Verify accepts only the current parameters. Changing them later means adding the old set to the allowed list.
- Passwords are NFKC-normalized before hashing. Length 12 to 1024.
- An unknown email is checked against a dummy hash made at startup, so it costs one scrypt like a wrong password. Both answer `401 bad_credentials`.

## Sessions

Server-side rows, not signed stateless cookies, so they can be revoked.

- Cookie: `relay_console`, `HttpOnly`, `SameSite=Strict`, `Secure` when `PUBLIC_URL` is https. 12 hours.
- Sign-out deletes the row. `users:set-password` deletes every session of that user. Deleting a user deletes its sessions.
- `X-Relay-Console: 1` is still required on every change.
- Limits (in memory, per process): 5 failures per IP and 10 per email in 15 minutes. Sign-ups: 5 per IP in 15 minutes.

## Sign-up

`SIGNUP_MODE=closed` (default) refuses `POST /api/users`. Accounts then come only from `users:create`. With `open`, anyone who can reach the server can make an account, and a taken email answers 409. There is no email reset (no mail provider yet). `users:set-password` covers it.

## Slack OAuth

- `/oauth/slack/start` needs a session. The signed state carries the Relay user id.
- The callback does not use the session. The session cookie is `SameSite=Strict`, and browsers do not send Strict cookies on a cross-site navigation like Slack's redirect back ([MDN, Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)). It trusts the HMAC state plus the `SameSite=Lax` nonce cookie, which is sent on a top-level GET from another site.
- A Slack identity (team + user) belongs to one Relay connection. If another account connects it, the callback answers 409, stores nothing, and leaves the owner's token alone. A connection with no members (from before accounts) is claimed by the first account that proves it owns the Slack identity.
- `SLACK_ALLOWED_USER_IDS` is optional. If set, it is still enforced.

## Alternatives

- **argon2id.** The OWASP first choice, but it needs a native package. scrypt is in Node.
- **Stateless signed cookies (the M5 design).** Cannot be revoked before they expire.
- **Workspaces above connections.** More flexible, but no current need. Membership is many-to-many, so a workspace can come later.
- **Clone shared destinations during adopt.** Rejected. It would split delivery history. Crossed links are reported and fixed by hand.
