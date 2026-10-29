# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Relay has user accounts. Its first user is its owner, who runs it for their own Slack, Discord, and webhook traffic. The owner intends to offer it as a product, so other users are technical people. They sign in with their own account, connect their own Slack accounts, Discord servers, and services, and let Relay and its agents act on their behalf. Each user sees only their own connections.

These users open the console in three situations:
- **Something broke.** A delivery failed, an agent run went wrong, or an event didn't route, and they need the cause fast.
- **Routine check-ins.** They glance to confirm events are flowing.
- **Setup.** They add connections, destinations, routes, and agent prompts.

## Product Purpose

Relay is one place for events to come in and for actions to go back out:
- **Sources connect in two ways.** OAuth providers (Slack, and Discord through a bot) and signed generic webhooks.
- **Every event is stored first, then processed.** It's checked and stored before anything else happens to it.
- **Routes send events onward.** A route matches events to destinations: signed HTTP endpoints, or a Claude agent that runs inside Relay.
- **Destinations can act back on the source.** They can reply in the original Slack thread or DM as the connected user, or as the Relay bot in Discord, react, or read the thread.

Success means the user stops worrying about the plumbing. Events arrive, get handled exactly once, and anything that fails is visible, explained, and replayable.

## Positioning

Relay is built so that acting on someone's behalf is safe by construction. Concretely:
- **Signed both ways.** Inbound requests are signature-checked, and outbound deliveries are HMAC-signed.
- **Stored before processing.** Every event is stored, and deduped, before anything acts on it.
- **Actions are scoped.** They can only target the thread or channel the event came from.
- **Relay never answers itself.** A loop guard drops echoes of Relay's own posts.
- **Every side effect is idempotent.** Retries never double-post.
- **Agents are locked down.** They run with Relay's actions as their only tools: no shell, files, or web.
- **Stranded work is swept and re-queued.**

The console has to show these guarantees as facts the user can check.

## Operating Context

- **Deployment:** self-hosted on Node 24 with Postgres. The server and worker are separate processes. Slack reaches the server through a public URL, such as a tunnel. Discord needs a third process, the gateway, which holds one socket open to Discord.
- **The console:** a single-page web app at the server root. People sign in with an email and password. Sign-up is closed unless the operator opens it.
- **Tenancy:** each connection is a tenant. Its routes, destinations, events, deliveries, actions, and agent runs belong to it alone. Users are members of connections (owner role only, for now). A new user's first step is adding a connection.
- **What it covers:**
  - accounts: sign in, optional sign-up, and a switcher between your connections
  - connections (Slack via OAuth, Discord servers via a bot install, signed webhooks)
  - destinations (HTTP or agent)
  - routes, with a live match preview against recent events
  - an event log with full detail (envelope, raw payload, deliveries, actions, agent runs)
  - deliveries, with a failed filter and replay
  - reply-token revocation
  - a 24-hour overview
- **The command-line tools** do the same admin tasks.

## Capabilities and Constraints

- **Security constraints the console must keep:**
  - Strict CSP: `default-src`, `script-src`, and `style-src` limited to `'self'`, so no inline scripts and no inline style attributes. `frame-ancestors` is `'none'`.
  - The session cookie is `SameSite=Strict` and httpOnly, and every change sends the `X-Relay-Console` header.
  - Event text and payloads come from untrusted senders and render as text only, never as HTML.
- **Secrets** (webhook and destination signing secrets) are shown exactly once, when created or rotated.
- **Stack:** React 19 + Vite. Styling moves to Tailwind CSS v4 as decided in the 2026-10-25 design pass. No UI kit, router library, or state library. Fonts must be self-hosted.
- **Terminology:** connection, destination (`http` or `agent`), route, event, envelope, delivery, action, reply token, agent run, echo (skipped).
- **Undecided:** product name and branding beyond "Relay", hosting and pricing model, invites and roles beyond owner, and password reset by email (today the operator resets it with a CLI).

## Brand Commitments

- **Name:** "Relay".
- **Tone:** professional, plain-spoken, and calm. It reads as trustworthy infrastructure, not a toy.
- **Reading level:** docs and UI copy at about a 9th-grade reading level.
- There is no logo or visual identity yet.

## Evidence on Hand

- Real product behavior only:
  - the test suite
  - ADRs 0001–0007 in `docs/adr/`
  - metrics documented in `docs/metrics.md`
- **None of these exist:** customers, testimonials, case studies, uptime records, benchmarks, or pricing. Never fabricate them.
- Any demo data must be labeled as demo data.

## Product Principles

1. **Truth over reassurance.** Show the real state, including failures, attempts, and causes. Never a comforting summary that hides them.
2. **Safety is visible, not decorative.** Every guarantee the system makes shows up where it applies, stated as a fact.
3. **Fast under failure.** The path from "something broke" to the cause and a replay is the shortest path in the product.
4. **One grammar everywhere.** The same status, time, ID, and confirmation patterns appear on every page.
5. **Nothing irreversible by accident.** Destructive or outward-facing actions are explicit and confirmed, and secrets are handled once.

## Accessibility & Inclusion

Target WCAG 2.2 AA in both light and dark themes. Everything must work by keyboard with a visible focus ring, and async results must be announced. The console must work at phone width (375px) for urgent checks.
