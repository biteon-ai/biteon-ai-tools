#!/bin/sh
set -eu
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *)
    echo "refusing to drill against a non-local database" >&2
    exit 1
    ;;
esac
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
"$ROOT/scripts/backup.sh" "$ROOT/backups/drill-$STAMP"
DRILL_URL="${DATABASE_URL%/*}/agent_platform_drill"
psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS agent_platform_drill;"
psql "$DATABASE_URL" -c "CREATE DATABASE agent_platform_drill;"
pg_restore --dbname="$DRILL_URL" "$ROOT/backups/drill-$STAMP/database.dump"
psql "$DRILL_URL" -c "SELECT id FROM schema_migrations;"
psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS agent_platform_drill;"
echo "recovery drill passed"
