#!/usr/bin/env bash
# Zero-drift phase 5: export byte-exact repo files for applied migrations that
# have no file in supabase/migrations (see docs/audits/2026-08-31-zero-drift/06).
# Usage: DATABASE_URL=postgres://... scripts/dev/export-applied-migrations.sh [min_version]
set -euo pipefail
MIN="${1:-20260831}"
cd "$(git rev-parse --show-toplevel)"
psql "$DATABASE_URL" -At -F' ' -c "
  select version, name from supabase_migrations.schema_migrations
  where version >= '${MIN}' and version ~ '^[0-9]+$' order by version" |
while read -r v n; do
  f="supabase/migrations/${v}_${n}.sql"
  if [ -e "$f" ]; then continue; fi
  # a phase placeholder file may exist under the same stamp with our naming
  if ls "supabase/migrations/${v}_"*.sql >/dev/null 2>&1; then
    echo "note: ${v} has a placeholder file - replacing with canonical export" >&2
    rm -f "supabase/migrations/${v}_"*.sql
  fi
  psql "$DATABASE_URL" -At -c "
    select array_to_string(statements, E'\n') from supabase_migrations.schema_migrations
    where version='${v}'" > "$f"
  echo "exported $f"
done
echo "done - review with git status, then commit."
