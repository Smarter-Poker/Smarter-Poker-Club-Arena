#!/usr/bin/env bash

# Resolve exactly one release migration whether it is still held back as
# `<version>_<name>.sql.pending` or has been source-sealed to the version
# assigned by Supabase as `<version>_<name>.sql`.  Callers must never guess a
# reserved timestamp: apply_migration owns the durable version and source is
# renamed to that receipt only after the live statement is byte-verified.
resolve_staged_or_promoted_migration() {
  if [[ "$#" -ne 2 ]]; then
    echo 'Usage: resolve_staged_or_promoted_migration MIGRATION_DIRECTORY MIGRATION_NAME' >&2
    return 64
  fi

  local migration_directory="$1"
  local migration_name="$2"
  local resolved_count=0
  local only_resolved_path=''
  # `match` is a zsh special parameter.  Keep this helper safe when callers
  # source it from either Bash or zsh instead of mutating shell state.
  local resolved_path

  [[ -d "$migration_directory" ]] || {
    echo "Migration directory does not exist: $migration_directory" >&2
    return 66
  }
  [[ "$migration_name" =~ ^[a-z0-9_]+$ ]] || {
    echo "Invalid migration name: $migration_name" >&2
    return 64
  }

  while IFS= read -r resolved_path; do
    resolved_count=$((resolved_count + 1))
    only_resolved_path="$resolved_path"
  done < <(
    find "$migration_directory" -maxdepth 1 -type f \
      \( -name "*_${migration_name}.sql" \
         -o -name "*_${migration_name}.sql.pending" \) \
      -print | LC_ALL=C sort
  )

  if [[ "$resolved_count" -ne 1 ]]; then
    echo "Expected exactly one staged-or-promoted ${migration_name} migration; found ${resolved_count}." >&2
    return 66
  fi

  printf '%s\n' "$only_resolved_path"
}
