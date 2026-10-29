# ADR 0011: Instance admins manage the Slack and Discord apps in the console

Status: accepted (M12a: data, admin API, CLIs. M12b: runtime reload. M12c: UI)

## Decision

Each relay instance has one shared Slack app and one shared Discord app. An instance admin sets their credentials in the console. Env vars stay as a fallback. Once a row is saved in the database, it wins.

No new dependencies.

## Instance admins

- `users.is_admin boolean not null default false`. A separate axis from `connection_members.role`. Being an admin gives no access to anyone's connections.
- Granted only from the CLI: `users:create --admin` and `users:grant-admin --email E [--revoke]`. `POST /api/users` never sets it, even with `isAdmin` in the body (the body schema drops unknown keys). There is no "first user becomes admin": on an open-signup instance that would hand the instance to whoever signs up first.
- The admin middleware reads `is_admin` from the database on every `/api/admin/*` request. A demotion applies on the next request, with no need to end sessions.
- A signed-in non-admin gets **404**, as in ADR 0007, so the admin surface can't be probed. Counted in `relay_admin_denied_total`. The tenant-isolation walk test also walks every admin route as a non-admin.
- `GET /api/session` returns `user.isAdmin` so the UI can show the Settings page. The server never trusts it.

## Data

- `provider_apps`: one row per provider (`slack` or `discord`, primary key). `client_id` in plain text. Secrets are encrypted: `client_secret_ct`, `signing_secret_ct` (Slack), `bot_token_ct` (Discord), and `previous_signing_secret_ct` with `previous_expires_at` (Slack). `allowed_user_ids text[]`, `version`, `updated_by` (user, set null on delete), `updated_at`.
- `version` comes from the `provider_app_versions` sequence and is bumped on every write. A sequence, not `version + 1`, so deleting a row and saving a new one never reuses a version. Readers can memoize on it.
- `provider_app_status`: one row per provider, written by the gateway (M12b) and read by the UI: `state`, `last_ready_at`, `last_close_code`, `last_signed_ok_at` (the last Slack request whose signature passed), `updated_at`.

## Encryption

- Secrets use a subkey: `HMAC-SHA256(master, 'relay/provider-apps/v1')`, built like the OAuth state key. The cipher is the same `createCipher` (libsodium secretbox). A ciphertext from `credentials` can't be moved into `provider_apps` and decrypted, and the other way round.
- **Debt:** no master key rotation and no key ids. Rotating `RELAY_MASTER_KEY` makes every row `invalid` (below), and an admin must save the secrets again. Same debt as `credentials`.

## Reading the config

`createProviderAppStore` in `packages/core` answers `get(provider)` with `{state, source, config, version}`:

- `ready`, source `db`: a row exists and decrypts and validates.
- `ready`, source `env`: no row, and the env vars are set (Slack: all three; Discord: any of client id, client secret, bot token, as today).
- `missing`: no row and no env.
- `invalid`, source `db`: a row exists but does not decrypt or validate.

**An invalid row never falls back to env.** If it did, a bad key or a corrupt row would quietly switch the instance to a different app (the old env one), and every connection made with the saved app would break with no sign of why. `invalid` is loud: M12b answers 503 and counts `relay_provider_app_config_errors_total`.

The store caches each provider for a TTL (server 5 s, worker and gateway 30 s, set in M12b). A write through the store drops its local cache at once; other processes see it after their TTL. On a database error it keeps serving the last good value. There is no LISTEN/NOTIFY.

## Secrets hygiene

- `GET /api/admin/integrations` returns no secret, ever. Per secret: `{set, source, updatedAt, updatedBy}`.
- `PUT` answers 204. An omitted (or empty) secret keeps the stored one, so the UI never needs to read one back.
- Validation errors list field names only, never the value or a message that could quote it.
- Log lines name the changed fields, never their values. Metric labels carry the provider name only.
- A test plants secret strings and greps every admin response body and every captured log line for them.

## Dangerous change

Slack user tokens are bound to the client id that issued them. A Discord connection relies on one bot being in each server (ADR 0008). So pointing relay at a different app silently cuts off every existing connection of that provider.

- On `PUT`, if the new `client_id` differs from the one in effect now (the row, or env if there is no row), and the provider has active connections, the body must hold `confirmClientIdChange: true`. Otherwise the answer is `409 {error: 'client_id_change', connections: N}` and nothing changes.
- A Discord bot token whose bot id (the first token segment) differs from the stored token's bot id counts as the same change.
- `DELETE` (revert to env) follows the same rule, with `?confirmClientIdChange=true`, when the env client id differs or there is no env.
- Rotating a secret on the same app is safe and needs no confirmation. A new Slack signing secret keeps the old one for 24 hours (`previous_*`), so requests Slack signed just before the change still pass (used by M12b).

## Test button

`POST /api/admin/integrations/:provider/test` is user-initiated only. Nothing calls it on a timer. Tests stub all HTTP. The calls below were checked against the linked docs on 2026-10-26.

- **Discord** ([API reference: authentication and User-Agent](https://docs.discord.com/developers/reference), [Users](https://docs.discord.com/developers/resources/user), [OAuth2](https://docs.discord.com/developers/topics/oauth2)):
  1. `GET /users/@me` with `Authorization: Bot <token>`: the token works.
  2. `GET /oauth2/applications/@me` with the bot token (Get Current Bot Application Information): its `id` must equal the saved client id, so the token and the client id belong to one app.
  3. `POST /oauth2/token`, form-encoded, HTTP Basic `client_id:client_secret`, `grant_type=client_credentials&scope=identify` (team apps are limited to `identify`): a 2xx proves the secret. The access token is dropped unused. The docs do not name the error for a bad secret; any 400 or 401 counts as a bad secret.
- **Slack** ([oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access)): `POST oauth.v2.access` with HTTP Basic client id and secret and a code that can't be valid. `invalid_code` means Slack got past the client checks, so the id and secret are good. `invalid_client_id` and `bad_client_secret` name the bad field. The docs do not state the order Slack checks in; the owner confirms this with a real app.
- The signing secret can't be tested by calling Slack. The answer includes `lastSignedOkAt` from `provider_app_status` instead.
- Results carry check names and short codes (`invalid_code`, `http_401`), never a provider's response body.

## Alternatives

- **Per-account apps (bring your own).** More flexible, but every user would need a developer portal. Later, if asked.
- **First user becomes admin.** Rejected, see above.
- **403 for non-admins.** Rejected: 404 matches ADR 0007 and hides the surface.
- **Keep env only.** Needs a restart and shell access to change an app. The goal is that a non-technical user only clicks Connect.
- **Fall back to env when a row is bad.** Rejected, see Reading the config.
