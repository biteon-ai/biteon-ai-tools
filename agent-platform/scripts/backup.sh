#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-$ROOT/backups/$STAMP}"
mkdir -p "$OUT"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
pg_dump --format=custom --file="$OUT/database.dump" "$DATABASE_URL"
if [ -d "${WORKSPACES_DIR:-$ROOT/workspaces}" ]; then
  tar -C "$(dirname "${WORKSPACES_DIR:-$ROOT/workspaces}")" -czf "$OUT/workspaces.tgz" "$(basename "${WORKSPACES_DIR:-$ROOT/workspaces}")"
fi
echo "backup written to $OUT"
