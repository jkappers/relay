#!/usr/bin/env bash
# Fails if drizzle-kit would generate a new migration, i.e. the schema and the committed migrations disagree.
set -euo pipefail
cd "$(dirname "$0")"

pnpm exec drizzle-kit check

tmp=".drift-check"
rm -rf "$tmp"
trap 'rm -rf "$tmp"' EXIT
cp -R drizzle "$tmp"
out="$(RELAY_DRIZZLE_OUT="./$tmp" pnpm exec drizzle-kit generate 2>&1)" || { echo "$out" >&2; exit 1; }
if ! grep -q "No schema changes" <<<"$out"; then
  echo "$out" >&2
  echo "Schema drift: drizzle-kit generate wants a new migration. Run 'pnpm db:generate' and commit the result." >&2
  exit 1
fi
if ! diff -r drizzle "$tmp" >/dev/null; then
  diff -r drizzle "$tmp" >&2 || true
  echo "Schema drift: drizzle-kit generate changed the migrations folder." >&2
  exit 1
fi
echo "migrations match schema"
