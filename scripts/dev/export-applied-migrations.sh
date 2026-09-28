#!/usr/bin/env bash
# Export a repo file for every applied migration that has none, BY THE CI RULE.
#
# Rewritten 2026-09-28. The first version (zero-drift phase 5) had two faults:
#
#   1. It decided "has a file" by one exact path, `<version>_<name>.sql`. The
#      rule the estate is actually held to is
#      scripts/ci/check-applied-migrations-are-recorded.mjs: version match OR
#      name match with date stamps stripped on both sides, across Club Arena
#      AND World Hub. A different test here meant this script and the scheduled
#      audit disagreed about what was missing.
#   2. When any file already carried the version it ran `rm -f` on it and wrote
#      its own copy. That can delete another agent's migration, a tombstone, or
#      an author's annotated original. This script now never deletes or
#      overwrites anything: a version that already has a file is recorded, by
#      definition, and is skipped.
#
# The body written is byte-exact to what production ran: array_to_string(
# statements, E';\n'), the same text public.fn_ca_migration_text() returns and
# hashes, with no header and no trailing newline, so the file can be listed in
# scripts/ci/recorded-migrations.manifest.json (scripts/ci/recording-only.mjs).
# A version with NULL statements cannot be exported and is listed instead.
#
# READ-ONLY against the database (default_transaction_read_only=on). Use the
# direct host: the pooler ignores PGOPTIONS.
#
# Usage: DATABASE_URL=postgres://... GITHUB_TOKEN=... \
#          scripts/dev/export-applied-migrations.sh [min_version]
set -euo pipefail
MIN="${1:-20260831}"
cd "$(git rev-parse --show-toplevel)"
: "${DATABASE_URL:?set DATABASE_URL (read-only use; direct host, not the pooler)}"
export PGOPTIONS="${PGOPTIONS:-} -c default_transaction_read_only=on"

# The exporter body is held in a variable so node can read the rows on stdin.
read -r -d '' EXPORTER <<'NODE' || true
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { indexFrom, recordedBy, siblingMigrationFiles } from './scripts/ci/check-applied-migrations-are-recorded.mjs';

const DIR = 'supabase/migrations';
// The same index the scheduled audit builds: this checkout plus World Hub.
// siblingMigrationFiles throws when World Hub cannot be read, and so does this:
// a Club-Arena-only index would export World Hub's migrations as gaps.
const index = indexFrom([...readdirSync(DIR), ...(await siblingMigrationFiles())]);
const slug = (name) =>
  (name || 'recovered').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'recovered';

let written = 0;
const empty = [];
for (const line of readFileSync(0, 'utf8').split('\n')) {
  if (!line) continue;
  const [version, name, count, b64] = line.split('\t');
  if (recordedBy(index, { version, name })) continue;
  if (Number(count) === 0) {
    empty.push(`${version} ${name}`);
    continue;
  }
  const file = `${DIR}/${version}_${slug(name)}.sql`;
  if (existsSync(file)) continue; // never overwrite; recordedBy says this cannot happen
  const body = Buffer.from(b64, 'base64');
  writeFileSync(file, body, { flag: 'wx' });
  written++;
  console.log(`exported ${file}  md5 ${createHash('md5').update(body).digest('hex')}`);
}
console.log(`[export-applied-migrations] wrote ${written} file(s); nothing was deleted or overwritten.`);
if (empty.length) {
  console.log(`[export-applied-migrations] ${empty.length} applied migration(s) have NULL statements and were not exported:`);
  for (const e of empty) console.log(`  ${e}`);
}
console.log('Next: add a row per file to scripts/ci/recorded-migrations.manifest.json (md5 above), then commit.');
NODE

psql "$DATABASE_URL" -X -At -F $'\t' -v ON_ERROR_STOP=1 -c "
  select version, coalesce(name, ''), coalesce(array_length(statements, 1), 0),
         translate(encode(convert_to(coalesce(array_to_string(statements, E';\n'), ''), 'UTF8'), 'base64'), E'\n', '')
    from supabase_migrations.schema_migrations
   where version ~ '^[0-9]+$' and version >= '${MIN}'
   order by version" | node --input-type=module -e "$EXPORTER"
