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

step "migrations match schema"
pnpm db:check

step "tests"
pnpm test

printf '\ncheck passed\n'
