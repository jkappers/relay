# ADR 0005: The console is a small Vite + React app served by the server

Status: accepted (M5)

## Decision

Add `apps/console`, a single-page admin UI. The server serves the built files from `apps/console/dist` and exposes a JSON API under `/api`.

New dependencies, all in `apps/console` only (exact pins):

| Package | Why |
|---|---|
| `react`, `react-dom` | UI rendering. React 19. |
| `@types/react`, `@types/react-dom` | Types. |
| `vite` | Dev server and production build. Already in the tree through vitest. |
| `@vitejs/plugin-react` | JSX transform. |

No router library, state library, UI kit, or CSS framework. Routing is the URL hash. Data loading is `fetch`. Styles are one CSS file with tokens on `:root` and a dark mode.

The server adds no new dependencies. It uses `hono/cookie`, `hono/secure-headers`, and `@hono/node-server/serve-static`.

## Auth

One owner, one password (`CONSOLE_PASSWORD`, at least 16 characters).

- Login compares HMAC digests with `timingSafeEqual`.
- The session is a stateless cookie: `v1.<expiry>.<hmac>`, signed with a key derived from `RELAY_MASTER_KEY` (label `relay/console-session/v1`). 12 hour expiry. `HttpOnly`, `SameSite=Strict`, `Secure` when `PUBLIC_URL` is https.
- Logout clears the cookie. A stateless cookie cannot be revoked server-side before it expires. Rotating `RELAY_MASTER_KEY` kills all sessions.
- Login throttle: in memory, 5 failures per IP in 15 minutes, then 429. It resets on restart and is per process. The IP is the socket address, not `X-Forwarded-For`, which a client can forge. Behind a reverse proxy this becomes one shared limit, which is acceptable for one user.
- CSRF: every POST, PUT, PATCH, and DELETE under `/api` needs `X-Relay-Console: 1`. A cross-site form or simple request cannot set it. `SameSite=Strict` is the second layer.
- Every `/api` route needs a session except `POST /api/session`. A test walks the router's route table so a new route cannot skip this.
- `GET /oauth/slack/start` needs a session. The callback keeps its state check and the user allowlist.

## Untrusted content

Event text and raw JSON come from outside senders. The UI renders them only as React text nodes. `dangerouslySetInnerHTML` and `innerHTML` are banned, and `scripts/check.sh` greps for them. The CSP is `default-src 'self'` with no inline script or style and `frame-ancestors 'none'`, so even a rendering bug would not run injected script.

## Logic reuse

The API calls the same core functions as the CLIs. New admin functions (update, delete, rotate, revoke) live in `packages/core/src/admin.ts` so a CLI can use them later.
