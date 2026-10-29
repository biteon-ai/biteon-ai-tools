#!/bin/sh
set -eu
if [ -z "${DATABASE_URL:-}" ] || [ -z "${1:-}" ]; then
  echo "usage: DATABASE_URL=... scripts/restore.sh backups/<stamp>" >&2
  exit 1
fi
if [ "${CONFIRM:-}" != "restore" ]; then
  echo "Set CONFIRM=restore to replace the database from $1" >&2
  exit 1
fi
pg_restore --clean --if-exists --dbname="$DATABASE_URL" "$1/database.dump"
if [ -f "$1/workspaces.tgz" ] && [ -n "${WORKSPACES_DIR:-}" ]; then
  mkdir -p "$WORKSPACES_DIR"
  tar -C "$(dirname "$WORKSPACES_DIR")" -xzf "$1/workspaces.tgz"
fi
echo "restore finished"
