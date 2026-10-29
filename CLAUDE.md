# relay: working rules

Read `README.md` first. Architecture decisions live in `docs/adr/`.

## Check before you hand off

```sh
scripts/check.sh
```

It starts the compose Postgres if needed, then runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm db:check` (migrations match the schema), and `pnpm test`. It must pass before any hand-back.

UI changes also need a browser check. The Playwright MCP browser runs in Docker, so open the local server at `http://host.docker.internal:<port>`, not `localhost`.

## Who does what

- The lead engineer plans each milestone and hands it to a subagent with a full brief.
- Hand-backs are claims. The lead re-runs the checks, reads the security-critical code (signature checks, crypto, reply tokens, loop guard), and runs extra probes.

## Branches and commits

- One branch per milestone. Never commit to `main`, merge, push, or rebase `main`. The lead squashes the branch into one Conventional Commits commit on `main`.
- After landing, `git diff <branch> main` must be empty.
- Conventional Commits. No attribution lines (no `Co-Authored-By`).
- Stage files by name. Never `git add -A` or `git add .`.
- Never bypass hooks (`--no-verify`).
- Never commit `.env` or secrets.

## Code and docs

- Migrations come only from `pnpm db:generate` (drizzle-kit). Never hand-edit generated SQL.
- No new dependency without an ADR entry in `docs/adr/`.
- Every new behavior gets a metric. Document it in `docs/metrics.md` in the same commit.
- Verify third-party API behavior against current docs before coding against it.
- Default to no code comments unless the reason isn't obvious.

## Process

- If a hook, permission, or setting blocks you, stop and report it. Don't work around it.
- Confirm before any outward-facing action: creating a Slack app, opening a tunnel, calling real provider APIs, posting anywhere. Tests stub all external HTTP.
