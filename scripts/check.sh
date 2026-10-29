#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }

step "postgres"
if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  docker compose up -d --wait postgres
else
  docker compose up -d --wait postgres >/dev/null
fi

step "install (frozen lockfile)"
pnpm install --frozen-lockfile

step "typecheck"
pnpm typecheck

step "console typecheck"
pnpm typecheck:console

step "console production build"
pnpm build:console

step "no dangerouslySetInnerHTML in the console"
if grep -rnE "dangerouslySetInnerHTML|innerHTML" apps/console/src apps/console/index.html; then
  echo "dangerouslySetInnerHTML is banned: event text is untrusted" >&2
  exit 1
fi

step "migrations match schema"
pnpm db:check

step "tests"
pnpm test

printf '\ncheck passed\n'
