#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration_resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
[[ -r "$migration_resolver" ]] || {
  echo 'Staged-or-promoted migration resolver is unreadable.' >&2
  exit 1
}
# shellcheck source=../ops/lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$migration_resolver"
migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  tournament_fractional_stacks_are_normalized_once)"
fixture="$repo_dir/scripts/dev/fixtures/tournament-fractional-stack-normalization-pg17-bootstrap.sql"
measurement="$repo_dir/scripts/dev/probe-tournament-fractional-stack-measurement-pg17.sql"
success_probe="$repo_dir/scripts/dev/probe-tournament-fractional-stack-normalization-pg17.sql"
operator_renderer="$repo_dir/scripts/ops/render-tournament-fractional-stack-cutover.sh"
operator_verifier="$repo_dir/scripts/ops/verify-tournament-fractional-stack-cutover-artifact.sh"
generic_ledger_verifier="$repo_dir/scripts/ops/verify-migration-ledger-artifact.sh"
postcondition_verifier="$repo_dir/scripts/ops/verify-tournament-fractional-stack-cutover-postconditions.sh"
zero_authority_verifier="$repo_dir/scripts/ops/verify-tournament-fractional-stack-zero-authority.sh"
materializer="$repo_dir/scripts/ops/materialize-tournament-fractional-stack-cutover.awk"

if [[ ! -f "$migration" ]] || [[ ! -f "$fixture" ]] \
   || [[ ! -f "$measurement" ]] || [[ ! -f "$success_probe" ]] \
   || [[ ! -x "$operator_renderer" ]] || [[ ! -x "$operator_verifier" ]] \
   || [[ ! -x "$generic_ledger_verifier" ]] \
   || [[ ! -x "$postcondition_verifier" ]] \
   || [[ ! -x "$zero_authority_verifier" ]] \
   || [[ ! -r "$materializer" ]]; then
  echo 'Tournament fractional-stack PG17 probe inputs are incomplete.' >&2
  exit 1
fi

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-fractional-stack-pg17.XXXXXX")"
socket_dir="${probe_root}/socket"
probe_root="$(CDPATH='' cd -- "$probe_root" && pwd -P)"
cluster_dir="${probe_root}/cluster"
render_dir="${probe_root}/rendered"
probe_root_name="$(basename "$probe_root")"
mkdir -p "$socket_dir" "$render_dir"
chmod 700 "$render_dir"
port="$((48432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root_name" == ca-fractional-stack-pg17.* \
     && -d "$probe_root" && ! -L "$probe_root" ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" -U postgres \
  --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-k ${socket_dir} -p ${port}" -w start >/dev/null

pg_exec() {
  local database="$1"
  shift
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
    -U postgres -h "$socket_dir" -p "$port" -d "$database" "$@"
}

clone_fixture() {
  local database="$1"
  "${pg17_bin}/createdb" -U postgres -h "$socket_dir" -p "$port" \
    -T fractional_fixture "$database"
}

render_migration() {
  local database="$1"
  local destination="$2"
  local observed
  local tournament_count
  local table_count
  local active_seat_count
  local fractional_seat_count
  local total_chips
  local preimage_sha
  local postimage_sha
  observed="$(pg_exec "$database" -qAt -f "$measurement")"
  IFS='|' read -r tournament_count table_count active_seat_count \
    fractional_seat_count total_chips preimage_sha postimage_sha <<<"$observed"
  if [[ "$tournament_count" != '2' ]] \
     || [[ "$table_count" != '3' ]] \
     || [[ "$active_seat_count" != '5' ]] \
     || [[ "$fractional_seat_count" != '5' ]] \
     || [[ ! "$total_chips" =~ ^[0-9]+([.]0+)?$ ]] \
     || [[ ! "$preimage_sha" =~ ^[0-9a-f]{64}$ ]] \
     || [[ ! "$postimage_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Invalid locked cohort measurement for ${database}: ${observed}" >&2
    return 1
  fi

  awk \
    -v engine_sha8='deadbeef' \
    -v tournament_ids='00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002' \
    -v tournament_count="$tournament_count" \
    -v table_count="$table_count" \
    -v active_seat_count="$active_seat_count" \
    -v fractional_seat_count="$fractional_seat_count" \
    -v total_chips="$total_chips" \
    -v preimage_sha="$preimage_sha" \
    -v postimage_sha="$postimage_sha" \
    -f "$materializer" "$migration" > "$destination"
}

expect_file_failure() {
  local database="$1"
  local marker="$2"
  local source_file="$3"
  local output
  if output="$(pg_exec "$database" -f "$source_file" 2>&1)"; then
    echo "Expected ${marker} failure in ${database}, but migration succeeded." >&2
    return 1
  fi
  if ! grep -Fq "$marker" <<<"$output"; then
    echo "Expected ${marker} in ${database}; got:" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
}

expect_sql_failure() {
  local database="$1"
  local marker="$2"
  local statement="$3"
  local output
  if output="$(pg_exec "$database" -c "$statement" 2>&1)"; then
    echo "Expected ${marker} SQL failure in ${database}, but statement succeeded." >&2
    return 1
  fi
  if ! grep -Fq "$marker" <<<"$output"; then
    echo "Expected ${marker} in ${database}; got:" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
}

assert_legacy_preimage() {
  local database="$1"
  local result
  result="$(pg_exec "$database" -Atc "
    SELECT
      (SELECT string_agg(s.stack::text, ',' ORDER BY s.id)
         FROM public.table_seats s
        WHERE s.id BETWEEN
          '20000000-0000-0000-0000-000000000001'::uuid AND
          '20000000-0000-0000-0000-000000000005'::uuid),
      (SELECT string_agg(tp.chips::text, ',' ORDER BY tp.id)
         FROM public.tournament_players tp
        WHERE tp.id BETWEEN
          '40000000-0000-0000-0000-000000000001'::uuid AND
          '40000000-0000-0000-0000-000000000005'::uuid);")"
  if [[ "$result" != '33.34,33.33,33.33,50.50,49.50|33,33,33,50,49' ]]; then
    echo "Partial cutover leaked in ${database}: ${result}" >&2
    return 1
  fi
}

assert_normalized_sync_postimage() {
  local database="$1"
  local result
  result="$(pg_exec "$database" -Atc "
    SELECT string_agg(tp.chips::text, ',' ORDER BY tp.id)
      FROM public.tournament_players tp
     WHERE tp.id BETWEEN
       '40000000-0000-0000-0000-000000000001'::uuid AND
       '40000000-0000-0000-0000-000000000005'::uuid;")"
  if [[ "$result" != '34,33,33,51,49' ]]; then
    echo "Tournament chip sync leaked a partial result in ${database}: ${result}" >&2
    return 1
  fi
}

"${pg17_bin}/createdb" -U postgres -h "$socket_dir" -p "$port" fractional_fixture
pg_exec fractional_fixture -f "$fixture" >/dev/null

# The production renderer must observe the dynamic cohort with the exact
# LEFT-JOIN/hash semantics used by the migration, emit all nine literals, and
# produce an immediately applicable artifact without exposing row JSON.
clone_fixture operator_render
operator_rendered="$render_dir/operator-rendered.sql"
operator_receipt="$operator_rendered.receipt"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
  "$zero_authority_verifier" deadbeef >"$render_dir/operator-zero-authority.log"
grep -Fq 'TOURNAMENT_CUTOVER_ZERO_AUTHORITY_VERIFIED' \
  "$render_dir/operator-zero-authority.log"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres PGDATABASE=operator_render \
  PSQL_BIN="${pg17_bin}/psql" CUTOVER_MIN_REMAINING_SECONDS=210 \
  "$operator_renderer" deadbeef "$operator_rendered" >"$render_dir/operator.log"
grep -Fxq 'CUTOVER_ENGINE_SHA8=deadbeef' "$operator_receipt"
grep -Fxq 'CUTOVER_TOURNAMENT_COUNT=2' "$operator_receipt"
grep -Fxq 'CUTOVER_TABLE_COUNT=3' "$operator_receipt"
grep -Fxq 'CUTOVER_ACTIVE_SEAT_COUNT=5' "$operator_receipt"
grep -Fxq 'CUTOVER_FRACTIONAL_SEAT_COUNT=5' "$operator_receipt"
if grep -Eq 'tournament_before|player_before|user_id' "$operator_receipt"; then
  echo 'Operator receipt leaked row-level tournament/player JSON.' >&2
  exit 1
fi
"$operator_verifier" deadbeef "$operator_rendered" \
  >"$render_dir/operator-verify.log"
grep -Fq 'RENDERED_ARTIFACT_VERIFIED' "$render_dir/operator-verify.log"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
  "$operator_verifier" deadbeef "$operator_rendered" PREAPPLY \
  >"$render_dir/operator-ledger-pristine.log"
grep -Fq 'LEDGER_NAME_PRISTINE' "$render_dir/operator-ledger-pristine.log"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
  "$generic_ledger_verifier" tournament_fractional_stacks_are_normalized_once \
    PREAPPLY >"$render_dir/operator-generic-ledger-pristine.log"
grep -Fq 'MIGRATION_LEDGER_NAME_PRISTINE' \
  "$render_dir/operator-generic-ledger-pristine.log"
pg_exec operator_render -c "
  INSERT INTO supabase_migrations.schema_migrations(version, statements, name)
  VALUES (
    '20260908193000',
    ARRAY[pg_read_file('${operator_rendered}')],
    'tournament_fractional_stacks_are_normalized_once'
  );
" >/dev/null
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
  "$operator_verifier" deadbeef "$operator_rendered" 20260908193000 \
  >"$render_dir/operator-ledger-verify.log"
grep -Fq 'LEDGER_ARTIFACT_VERIFIED version=20260908193000' \
  "$render_dir/operator-ledger-verify.log"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
  "$generic_ledger_verifier" tournament_fractional_stacks_are_normalized_once \
    20260908193000 "$operator_rendered" \
    >"$render_dir/operator-generic-ledger-verify.log"
grep -Fq 'MIGRATION_LEDGER_ARTIFACT_VERIFIED' \
  "$render_dir/operator-generic-ledger-verify.log"

# A second wall-clock version under the same one-shot name is an ambiguous
# history, even when both rows contain identical bytes. The supplied version
# must not be allowed to hide global name duplication.
pg_exec operator_render -c "
  INSERT INTO supabase_migrations.schema_migrations(version, statements, name)
  VALUES (
    '20260908193001',
    ARRAY[pg_read_file('${operator_rendered}')],
    'tournament_fractional_stacks_are_normalized_once'
  );
" >/dev/null
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
   "$operator_verifier" deadbeef "$operator_rendered" 20260908193000 \
     >"$render_dir/operator-ledger-duplicate.log" 2>&1; then
  echo 'Ledger verifier accepted two versions of the one-shot migration name.' >&2
  exit 1
fi
grep -Fq 'name/version uniqueness' "$render_dir/operator-ledger-duplicate.log"
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
   "$generic_ledger_verifier" tournament_fractional_stacks_are_normalized_once \
     20260908193000 "$operator_rendered" \
     >"$render_dir/operator-generic-ledger-duplicate.log" 2>&1; then
  echo 'Generic ledger verifier accepted a duplicate migration name.' >&2
  exit 1
fi
grep -Fq 'name/version uniqueness' "$render_dir/operator-generic-ledger-duplicate.log"
pg_exec operator_render -c "
  DELETE FROM supabase_migrations.schema_migrations
   WHERE version = '20260908193001';
" >/dev/null

# The receipt hash and canonical byte comparison independently reject artifact
# and receipt tampering before any migration tool sees the SQL.
tampered_artifact="$render_dir/operator-tampered.sql"
cp "$operator_rendered" "$tampered_artifact"
cp "$operator_receipt" "${tampered_artifact}.receipt"
printf '\n-- adversarial byte\n' >>"$tampered_artifact"
chmod 600 "$tampered_artifact" "${tampered_artifact}.receipt"
if "$operator_verifier" deadbeef "$tampered_artifact" \
     >"$render_dir/operator-tampered.log" 2>&1; then
  echo 'Artifact verifier accepted a byte changed after rendering.' >&2
  exit 1
fi
grep -Fq 'SHA-256 does not match' "$render_dir/operator-tampered.log"

tampered_receipt="$render_dir/operator-receipt-tampered.sql"
cp "$operator_rendered" "$tampered_receipt"
cp "$operator_receipt" "${tampered_receipt}.receipt"
sed 's/^RENDERED_MIGRATION_SHA256=./RENDERED_MIGRATION_SHA256=0/' \
  "${tampered_receipt}.receipt" >"${tampered_receipt}.receipt.next"
mv "${tampered_receipt}.receipt.next" "${tampered_receipt}.receipt"
chmod 600 "$tampered_receipt" "${tampered_receipt}.receipt"
if "$operator_verifier" deadbeef "$tampered_receipt" \
     >"$render_dir/operator-receipt-tampered.log" 2>&1; then
  echo 'Artifact verifier accepted a changed receipt digest.' >&2
  exit 1
fi
grep -Fq 'SHA-256 does not match' "$render_dir/operator-receipt-tampered.log"

trailing_receipt="$render_dir/operator-receipt-trailing.sql"
cp "$operator_rendered" "$trailing_receipt"
cp "$operator_receipt" "${trailing_receipt}.receipt"
printf 'UNDELIMITED_TRAILING_BYTES' >>"${trailing_receipt}.receipt"
chmod 600 "$trailing_receipt" "${trailing_receipt}.receipt"
if "$operator_verifier" deadbeef "$trailing_receipt" \
     >"$render_dir/operator-receipt-trailing.log" 2>&1; then
  echo 'Artifact verifier accepted trailing receipt bytes.' >&2
  exit 1
fi
grep -Fq 'exactly ten newline-terminated fields' \
  "$render_dir/operator-receipt-trailing.log"
pg_exec operator_render -f "$operator_rendered" >/dev/null
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
  "$postcondition_verifier" "$operator_rendered" \
  >"$render_dir/operator-postconditions.log"
grep -Fq 'TOURNAMENT_WHOLE_CHIP_POSTCONDITIONS_VERIFIED' \
  "$render_dir/operator-postconditions.log"

# The legacy fractions can disappear naturally before the scheduled cutover
# (players leave or bust). That is still a live estate, not an empty replay.
# Render a canonical zero-row receipt, prove it byte-for-byte, and require the
# same migration to widen cumulative chip storage and install all permanent
# ingress guards without manufacturing a data rewrite.
clone_fixture operator_zero_cohort
pg_exec operator_zero_cohort -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats s
     SET stack = trunc(s.stack)
    FROM public.tables tb
   WHERE tb.id = s.table_id
     AND tb.tournament_id IS NOT NULL
     AND s.left_at IS NULL;
  UPDATE public.tournament_players tp
     SET chips = s.stack::integer
    FROM public.tables tb
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE tb.tournament_id = tp.tournament_id
     AND s.user_id = tp.user_id;
  COMMIT;
" >/dev/null
zero_rendered="$render_dir/operator-zero-cohort.sql"
zero_receipt="${zero_rendered}.receipt"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_zero_cohort PSQL_BIN="${pg17_bin}/psql" \
  CUTOVER_MIN_REMAINING_SECONDS=210 \
  "$operator_renderer" deadbeef "$zero_rendered" \
  >"$render_dir/operator-zero-cohort.log"
grep -Fxq 'CUTOVER_TOURNAMENT_IDS_CSV=' "$zero_receipt"
grep -Fxq 'CUTOVER_TOURNAMENT_COUNT=0' "$zero_receipt"
grep -Fxq 'CUTOVER_TABLE_COUNT=0' "$zero_receipt"
grep -Fxq 'CUTOVER_ACTIVE_SEAT_COUNT=0' "$zero_receipt"
grep -Fxq 'CUTOVER_FRACTIONAL_SEAT_COUNT=0' "$zero_receipt"
grep -Fxq 'CUTOVER_TOTAL_CHIPS=0' "$zero_receipt"
grep -Fxq 'CUTOVER_PREIMAGE_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' "$zero_receipt"
grep -Fxq 'CUTOVER_POSTIMAGE_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' "$zero_receipt"
"$operator_verifier" deadbeef "$zero_rendered" \
  >"$render_dir/operator-zero-cohort-verify.log"
grep -Fq 'RENDERED_ARTIFACT_VERIFIED' \
  "$render_dir/operator-zero-cohort-verify.log"
pg_exec operator_zero_cohort -f "$zero_rendered" >/dev/null
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_zero_cohort PSQL_BIN="${pg17_bin}/psql" \
  "$postcondition_verifier" "$zero_rendered" \
  >"$render_dir/operator-zero-cohort-postconditions.log"
grep -Fq 'TOURNAMENT_WHOLE_CHIP_POSTCONDITIONS_VERIFIED tournaments=0 tables=0 seats=0 total=0' \
  "$render_dir/operator-zero-cohort-postconditions.log"

clone_fixture zero_cohort_unrelated_missing_mirror
pg_exec zero_cohort_unrelated_missing_mirror -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats s
     SET stack = trunc(s.stack)
    FROM public.tables tb
   WHERE tb.id = s.table_id
     AND tb.tournament_id IS NOT NULL
     AND s.left_at IS NULL;
  UPDATE public.tournament_players tp
     SET chips = s.stack::integer
    FROM public.tables tb
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE tb.tournament_id = tp.tournament_id
     AND s.user_id = tp.user_id;
  DELETE FROM public.tournament_players
   WHERE id = '40000000-0000-0000-0000-000000000003';
  COMMIT;
" >/dev/null
zero_unrelated_rendered="$render_dir/operator-zero-unrelated-missing-mirror.sql"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=zero_cohort_unrelated_missing_mirror \
  PSQL_BIN="${pg17_bin}/psql" CUTOVER_MIN_REMAINING_SECONDS=210 \
  "$operator_renderer" deadbeef "$zero_unrelated_rendered" \
  >"$render_dir/operator-zero-unrelated-missing-mirror.log"
expect_file_failure zero_cohort_unrelated_missing_mirror \
  FRACTIONAL_STACK_IDENTITY_MISMATCH "$zero_unrelated_rendered"
if [[ "$(pg_exec zero_cohort_unrelated_missing_mirror -Atc "SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='chips' AND NOT attisdropped;")" != 'integer' ]]; then
  echo 'A refused zero-cohort cutover leaked its schema widening.' >&2
  exit 1
fi

# A zero-cohort receipt is a snapshot, not permission to ignore a legacy
# residue that appears before apply. The apply predicate must be identical to
# measurement and refuse the newly unmeasured tournament.
clone_fixture unmeasured_residue_after_zero_render
pg_exec unmeasured_residue_after_zero_render -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats s
     SET stack = trunc(s.stack)
    FROM public.tables tb
   WHERE tb.id = s.table_id
     AND tb.tournament_id IS NOT NULL
     AND s.left_at IS NULL;
  UPDATE public.tournament_players tp
     SET chips = s.stack::integer
    FROM public.tables tb
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE tb.tournament_id = tp.tournament_id
     AND s.user_id = tp.user_id;
  COMMIT;
" >/dev/null
zero_residue_race="$render_dir/unmeasured-residue-after-zero-render.sql"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=unmeasured_residue_after_zero_render \
  PSQL_BIN="${pg17_bin}/psql" CUTOVER_MIN_REMAINING_SECONDS=210 \
  "$operator_renderer" deadbeef "$zero_residue_race" \
  >"$render_dir/unmeasured-residue-after-zero-render.log"
pg_exec unmeasured_residue_after_zero_render -c "
  UPDATE public.tournament_players
     SET chips = chips - 1
   WHERE id = '40000000-0000-0000-0000-000000000001';
" >/dev/null
expect_file_failure unmeasured_residue_after_zero_render \
  FRACTIONAL_STACK_UNMEASURED_LIVE_COHORT "$zero_residue_race"
if [[ "$(pg_exec unmeasured_residue_after_zero_render -Atc "SELECT chips || ':' || (SELECT stack::text FROM public.table_seats WHERE id='20000000-0000-0000-0000-000000000001') FROM public.tournament_players WHERE id='40000000-0000-0000-0000-000000000001';")" != '32:33.00' ]]; then
  echo 'The refused zero-cohort residue race changed its source rows.' >&2
  exit 1
fi

# The same late residue must be refused when the rendered artifact already has
# a positive cohort. Insert a complete third tournament after observation so
# it cannot hide behind drift inside one of the measured tournaments.
clone_fixture unmeasured_residue_after_positive_render
positive_residue_race="$render_dir/unmeasured-residue-after-positive-render.sql"
render_migration unmeasured_residue_after_positive_render "$positive_residue_race"
pg_exec unmeasured_residue_after_positive_render -c "
  INSERT INTO public.tournaments(
    id, name, status, starting_chips, rebuy_chips, addon_chips,
    blind_structure, created_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000098', 'Late Legacy Residue',
    'REGISTERING', 10, 10, 10,
    '[{\"level\":1,\"smallBlind\":1,\"bigBlind\":2,\"ante\":0}]',
    '2026-09-08 17:08:00+00'
  );
  INSERT INTO public.tables(
    id, tournament_id, game_type, status, small_blind, big_blind, ante,
    bomb_pot_enabled, bomb_pot_ante_fixed, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000098',
    '00000000-0000-0000-0000-000000000098', 'tournament', 'running',
    1, 2, 0, false, NULL, '2026-09-08 17:08:00+00'
  );
  INSERT INTO public.table_seats(
    id, table_id, seat_number, user_id, stack, joined_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000098',
    '10000000-0000-0000-0000-000000000098', 1,
    '30000000-0000-0000-0000-000000000098', 10,
    '2026-09-08 17:08:01+00'
  );
  INSERT INTO public.tournament_players(
    id, tournament_id, user_id, chips, status, table_id, seat_number, registered_at
  ) VALUES (
    '40000000-0000-0000-0000-000000000098',
    '00000000-0000-0000-0000-000000000098',
    '30000000-0000-0000-0000-000000000098', 9, 'registered',
    '10000000-0000-0000-0000-000000000098', 1,
    '2026-09-08 17:08:00+00'
  );
" >/dev/null
expect_file_failure unmeasured_residue_after_positive_render \
  FRACTIONAL_STACK_UNMEASURED_LIVE_COHORT "$positive_residue_race"
assert_legacy_preimage unmeasured_residue_after_positive_render

# The prior seat-only half-chip transition can leave an exact +1 seat/roster
# mirror residue when a rounded-up tournament never reaches its next live sync.
# It is part of this one-time transition only when the stopped observation
# proves the exact seat generation and the roster is exactly one chip low.
clone_fixture operator_residual_only
pg_exec operator_residual_only -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats s
     SET stack = trunc(s.stack)
    FROM public.tables tb
   WHERE tb.id = s.table_id
     AND tb.tournament_id IS NOT NULL
     AND s.left_at IS NULL;
  UPDATE public.tournament_players tp
     SET chips = s.stack::integer
    FROM public.tables tb
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE tb.tournament_id = tp.tournament_id
     AND s.user_id = tp.user_id;
  UPDATE public.tournament_players
     SET chips = chips - 1
   WHERE id = '40000000-0000-0000-0000-000000000001';
  COMMIT;
" >/dev/null
residual_rendered="$render_dir/operator-residual-only.sql"
residual_receipt="${residual_rendered}.receipt"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_residual_only PSQL_BIN="${pg17_bin}/psql" \
  CUTOVER_MIN_REMAINING_SECONDS=210 \
  "$operator_renderer" deadbeef "$residual_rendered" \
  >"$render_dir/operator-residual-only.log"
grep -Fxq 'CUTOVER_TOURNAMENT_COUNT=1' "$residual_receipt"
grep -Fxq 'CUTOVER_TABLE_COUNT=1' "$residual_receipt"
grep -Fxq 'CUTOVER_ACTIVE_SEAT_COUNT=3' "$residual_receipt"
grep -Fxq 'CUTOVER_FRACTIONAL_SEAT_COUNT=0' "$residual_receipt"
"$operator_verifier" deadbeef "$residual_rendered" \
  >"$render_dir/operator-residual-only-verify.log"
pg_exec operator_residual_only -f "$residual_rendered" >/dev/null
if [[ "$(pg_exec operator_residual_only -Atc "SELECT chips FROM public.tournament_players WHERE id='40000000-0000-0000-0000-000000000001';")" != '33' ]]; then
  echo 'Exact one-chip legacy mirror residue was not repaired atomically.' >&2
  exit 1
fi

# A broader or ambiguous mismatch is never normalized merely because a second
# row in the same tournament carries the exact legacy signature.
clone_fixture operator_residual_ambiguous
pg_exec operator_residual_ambiguous -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats s
     SET stack = trunc(s.stack)
    FROM public.tables tb
   WHERE tb.id = s.table_id
     AND tb.tournament_id IS NOT NULL
     AND s.left_at IS NULL;
  UPDATE public.tournament_players tp
     SET chips = s.stack::integer
    FROM public.tables tb
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE tb.tournament_id = tp.tournament_id
     AND s.user_id = tp.user_id;
  UPDATE public.tournament_players
     SET chips = CASE
       WHEN id = '40000000-0000-0000-0000-000000000001' THEN chips - 2
       WHEN id = '40000000-0000-0000-0000-000000000002' THEN chips - 1
       ELSE chips
     END
   WHERE id IN (
     '40000000-0000-0000-0000-000000000001',
     '40000000-0000-0000-0000-000000000002'
   );
  COMMIT;
" >/dev/null
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_residual_ambiguous PSQL_BIN="${pg17_bin}/psql" \
   CUTOVER_MIN_REMAINING_SECONDS=210 \
   "$operator_renderer" deadbeef "$render_dir/operator-residual-ambiguous.sql" \
     >"$render_dir/operator-residual-ambiguous.log" 2>&1; then
  echo 'Renderer accepted a mirror mismatch broader than the exact legacy one-chip residue.' >&2
  exit 1
fi
grep -Fq 'FRACTIONAL_STACK_MEASUREMENT_IDENTITY_MISMATCH' \
  "$render_dir/operator-residual-ambiguous.log"

clone_fixture operator_missing_mirror
pg_exec operator_missing_mirror -c "
  DELETE FROM public.tournament_players
   WHERE id = '40000000-0000-0000-0000-000000000003';
" >/dev/null
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_missing_mirror PSQL_BIN="${pg17_bin}/psql" \
   "$operator_renderer" deadbeef "$render_dir/operator-missing.sql" \
     >"$render_dir/operator-missing.log" 2>&1; then
  echo 'Production renderer accepted a live seat with no roster mirror.' >&2
  exit 1
fi
grep -Fq 'FRACTIONAL_STACK_MEASUREMENT_IDENTITY_MISMATCH' \
  "$render_dir/operator-missing.log"

# A password-bearing URI must never be copied into psql's argv. Refusal occurs
# before psql lookup/connection and the secret is absent from diagnostics.
if DATABASE_URL='postgresql://operator:do-not-print@invalid.example/cutover' \
   PSQL_BIN=false "$operator_renderer" deadbeef \
     "$render_dir/operator-secret-uri.sql" \
     >"$render_dir/operator-secret-uri.log" 2>&1; then
  echo 'Production renderer accepted DATABASE_URL.' >&2
  exit 1
fi
grep -Fq 'DATABASE_URL is not accepted' "$render_dir/operator-secret-uri.log"
if grep -Fq 'do-not-print' "$render_dir/operator-secret-uri.log"; then
  echo 'Production renderer exposed a database credential in diagnostics.' >&2
  exit 1
fi

# Dynamic evidence is valid only in a current-user-owned mode-0700 directory.
# A permissive parent lets another process replace a verified pathname before
# apply_migration reads it, so both producer and verifier refuse it first.
world_writable_dir="$probe_root/world-writable"
mkdir "$world_writable_dir"
chmod 777 "$world_writable_dir"
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
   "$operator_renderer" deadbeef "$world_writable_dir/rendered.sql" \
     >"$render_dir/operator-world-writable.log" 2>&1; then
  echo 'Production renderer accepted a world-writable evidence parent.' >&2
  exit 1
fi
grep -Fq 'mode 0700' "$render_dir/operator-world-writable.log"
if "$operator_verifier" deadbeef "$world_writable_dir/rendered.sql" \
     >"$render_dir/verifier-world-writable.log" 2>&1; then
  echo 'Artifact verifier accepted a world-writable evidence parent.' >&2
  exit 1
fi
grep -Fq 'mode 0700' "$render_dir/verifier-world-writable.log"

wait_for_install_hook() {
  local log_file="$1"
  local child_pid="$2"
  for _ in {1..200}; do
    if grep -Fq 'CUTOVER_TEST_INSTALL_READY' "$log_file" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$child_pid" 2>/dev/null; then
      break
    fi
    sleep 0.02
  done
  echo "Renderer never reached its deterministic install hook: $log_file" >&2
  return 1
}

# An output or receipt created after measurement must win create-if-absent;
# neither can be overwritten by the renderer's final publication step.
clone_fixture operator_output_race
output_race="$render_dir/operator-output-race.sql"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_output_race PSQL_BIN="${pg17_bin}/psql" \
  CUTOVER_TEST_MODE=1 CUTOVER_TEST_INSTALL_DELAY_SECONDS=1 \
  "$operator_renderer" deadbeef "$output_race" \
  >"$render_dir/operator-output-race.log" 2>&1 &
output_race_pid=$!
wait_for_install_hook "$render_dir/operator-output-race.log" "$output_race_pid"
printf 'operator-owned-output\n' >"$output_race"
chmod 600 "$output_race"
if wait "$output_race_pid"; then
  echo 'Renderer overwrote a post-measurement output-path race.' >&2
  exit 1
fi
grep -Fq 'atomic install' "$render_dir/operator-output-race.log"
[[ "$(<"$output_race")" == 'operator-owned-output' \
   && ! -e "${output_race}.receipt" ]] || {
  echo 'Output-path race changed operator-owned evidence.' >&2
  exit 1
}

clone_fixture operator_receipt_race
receipt_race="$render_dir/operator-receipt-race.sql"
DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
  PGDATABASE=operator_receipt_race PSQL_BIN="${pg17_bin}/psql" \
  CUTOVER_TEST_MODE=1 CUTOVER_TEST_INSTALL_DELAY_SECONDS=1 \
  "$operator_renderer" deadbeef "$receipt_race" \
  >"$render_dir/operator-receipt-race.log" 2>&1 &
receipt_race_pid=$!
wait_for_install_hook "$render_dir/operator-receipt-race.log" "$receipt_race_pid"
printf 'operator-owned-receipt\n' >"${receipt_race}.receipt"
chmod 600 "${receipt_race}.receipt"
if wait "$receipt_race_pid"; then
  echo 'Renderer overwrote a post-measurement receipt-path race.' >&2
  exit 1
fi
grep -Fq 'atomic install' "$render_dir/operator-receipt-race.log"
[[ -f "$receipt_race" \
   && "$(<"${receipt_race}.receipt")" == 'operator-owned-receipt' ]] || {
  echo 'Receipt-path race changed operator-owned evidence or lost the private artifact.' >&2
  exit 1
}
if "$operator_verifier" deadbeef "$receipt_race" \
     >"$render_dir/operator-receipt-race-verify.log" 2>&1; then
  echo 'Verifier accepted the deliberately incomplete receipt-race pair.' >&2
  exit 1
fi

# Output paths are evidence boundaries. A dangling symlink must not bypass the
# renderer's no-overwrite contract and redirect the reviewed artifact.
ln -s "$render_dir/operator-symlink-target.sql" \
  "$render_dir/operator-symlink.sql"
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
   "$operator_renderer" deadbeef "$render_dir/operator-symlink.sql" \
     >"$render_dir/operator-symlink.log" 2>&1; then
  echo 'Production renderer followed a dangling output symlink.' >&2
  exit 1
fi
grep -Fq 'Refusing to overwrite' "$render_dir/operator-symlink.log"

ln -s "$render_dir/operator-receipt-target" \
  "$render_dir/operator-receipt-symlink.sql.receipt"
if DATABASE_URL='' PGHOST="$socket_dir" PGPORT="$port" PGUSER=postgres \
   PGDATABASE=operator_render PSQL_BIN="${pg17_bin}/psql" \
   "$operator_renderer" deadbeef "$render_dir/operator-receipt-symlink.sql" \
     >"$render_dir/operator-receipt-symlink.log" 2>&1; then
  echo 'Production renderer followed a dangling receipt symlink.' >&2
  exit 1
fi
grep -Fq 'Refusing to overwrite' "$render_dir/operator-receipt-symlink.log"

# The checked-in artifact is fail-closed on any real estate but still supports
# a clean chronological replay after proving strict prerequisites and schema.
clone_fixture unset_literals
expect_file_failure unset_literals FRACTIONAL_STACK_CUTOVER_LITERALS_UNSET "$migration"
assert_legacy_preimage unset_literals

clone_fixture empty_sentinel
pg_exec empty_sentinel -c '
  TRUNCATE public.hand_atomic_commits, public.settlement_idempotency_keys,
    public.hand_state_snapshots, public.engine_tournament_leases,
    public.engine_table_leases, public.engine_leader,
    public.engine_maintenance_break, public.table_seats,
    public.tournament_players, public.tables, public.tournaments CASCADE;
' >/dev/null
pg_exec empty_sentinel -f "$migration" >/dev/null
if [[ "$(pg_exec empty_sentinel -Atc "SELECT count(*) FROM pg_trigger WHERE tgname = 'a1_require_whole_tournament_chips' AND NOT tgisinternal;")" != '4' ]]; then
  echo 'Sentinel clean replay did not install all four ingress guards.' >&2
  exit 1
fi

# One legacy bootstrap declared flight bags as numeric(18,4). An empty
# chronological replay must accept that known shape, prove it whole, and
# canonicalize it without leaving a second cumulative-width contract.
clone_fixture numeric_flight_legacy
pg_exec numeric_flight_legacy -c '
  TRUNCATE public.hand_atomic_commits, public.settlement_idempotency_keys,
    public.hand_state_snapshots, public.engine_tournament_leases,
    public.engine_table_leases, public.engine_leader,
    public.engine_maintenance_break, public.table_seats,
    public.tournament_players, public.tables, public.tournaments CASCADE;
  ALTER TABLE public.tournament_flights
    ALTER COLUMN bagged_chips TYPE numeric(18,4) USING bagged_chips::numeric;
' >/dev/null
pg_exec numeric_flight_legacy -f "$migration" >/dev/null
if [[ "$(pg_exec numeric_flight_legacy -Atc "SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_flights'::regclass AND attname='bagged_chips' AND NOT attisdropped;")" != 'bigint' ]]; then
  echo 'Legacy numeric(18,4) flight bags were not canonicalized to bigint.' >&2
  exit 1
fi

# exact-postimage-topology-drift: the row-image hash intentionally contains
# seat generations, so a seatless roster row is outside it. A retry must still
# re-prove the complete bidirectional topology and refuse this new corruption.
clone_fixture exact_postimage_topology_drift
rendered_topology="$render_dir/exact-postimage-topology-drift.sql"
render_migration exact_postimage_topology_drift "$rendered_topology"
pg_exec exact_postimage_topology_drift -f "$rendered_topology" >/dev/null
pg_exec exact_postimage_topology_drift -c "
  INSERT INTO public.tournament_players(
    id, tournament_id, user_id, chips, status, table_id, seat_number,
    registered_at
  ) VALUES (
    '40000000-0000-0000-0000-000000000098',
    '00000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000098',
    25, 'playing', NULL, NULL, '2026-09-08 18:00:00+00'
  );
" >/dev/null
expect_file_failure exact_postimage_topology_drift \
  FRACTIONAL_STACK_IDENTITY_MISMATCH "$rendered_topology"
if [[ "$(pg_exec exact_postimage_topology_drift -Atc "SELECT count(*) FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000098';")" != '1' ]]; then
  echo 'Exact-postimage topology refusal did not preserve the drift testimony.' >&2
  exit 1
fi

clone_fixture success
rendered_success="$render_dir/success.sql"
render_migration success "$rendered_success"
apply_started="$(perl -MTime::HiRes=time -e 'printf "%.6f", time')"
pg_exec success -f "$rendered_success" >/dev/null
apply_ms="$(perl -MTime::HiRes=time -e '$started = shift; printf "%d", (time - $started) * 1000' "$apply_started")"
pg_exec success -f "$rendered_success" >/dev/null
pg_exec success -c "
  UPDATE public.engine_maintenance_break
     SET phase = 'completed', enforce_freeze = false,
         break_ends_at = clock_timestamp() - interval '1 second';
" >/dev/null
pg_exec success -f "$success_probe" >/dev/null

# Permanent database ingress guards reject every authoritative numeric source.
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.table_seats SET stack = 34.5 WHERE id = '20000000-0000-0000-0000-000000000001';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "SET ROLE service_role; SELECT public.probe_write_tournament_stack('20000000-0000-0000-0000-000000000001', 34.5);"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tables SET small_blind = 1.5 WHERE id = '10000000-0000-0000-0000-000000000001';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tables SET bomb_pot_ante_fixed = 2.5 WHERE id = '10000000-0000-0000-0000-000000000001';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tables SET bomb_pot_ante_multiplier = -1 WHERE id = '10000000-0000-0000-0000-000000000001';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tables SET bomb_pot_enabled = true WHERE id = '10000000-0000-0000-0000-000000000004';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.table_seats SET left_at = NULL WHERE id = '20000000-0000-0000-0000-000000000009';"
# Preserved terminal testimony can be closed without changing its fractional
# stack, but that exact row can never be made playable again.
pg_exec success -c "
  UPDATE public.table_seats SET left_at = clock_timestamp()
   WHERE id = '20000000-0000-0000-0000-000000000006';
" >/dev/null
if [[ "$(pg_exec success -Atc "SELECT stack::text || '|' || (left_at IS NOT NULL)::text FROM public.table_seats WHERE id = '20000000-0000-0000-0000-000000000006';")" != '9.50|true' ]]; then
  echo 'Terminal fractional testimony could not be closed unchanged.' >&2
  exit 1
fi
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.table_seats SET left_at = NULL WHERE id = '20000000-0000-0000-0000-000000000006';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tournaments SET status = 'RUNNING' WHERE id = '00000000-0000-0000-0000-000000000003';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tournament_players SET chips = -1 WHERE id = '40000000-0000-0000-0000-000000000001';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.table_seats SET stack = 100.5 WHERE id = '20000000-0000-0000-0000-000000000099';"
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tables SET bomb_pot_ante_fixed = 3.5 WHERE id = '10000000-0000-0000-0000-000000000099';"

for fractional_structure in \
  '[{"smallBlind":1.5,"bigBlind":2,"ante":0}]' \
  '[{"small_blind":1,"big_blind":2.5,"ante":0}]' \
  '[{"small":1,"big":2,"ante":0.5}]' \
  '[{"sb":0.5,"bb":2,"ante":0}]'; do
  expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
    "UPDATE public.tournaments SET blind_structure = '${fractional_structure}' WHERE id = '00000000-0000-0000-0000-000000000099';"
done

# The arbitrary JSON child is owner-only. The service role must reach it only
# through the source-owning live-seat wrapper; owner-context calls below test
# the child's exact validation without manufacturing a second application RPC.
if [[ "$(pg_exec success -Atc "SELECT has_function_privilege('service_role', 'public.fn_sync_tournament_chips(uuid,jsonb)', 'EXECUTE');")" != 'f' ]]; then
  echo 'The arbitrary tournament-chip JSON child is exposed to service_role.' >&2
  exit 1
fi
expect_sql_failure success 'permission denied for function fn_sync_tournament_chips' \
  "SET ROLE service_role; SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000001', '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":35}]');"
pg_exec success -c "
  BEGIN;
  SELECT public.fn_sync_tournament_chips(
    '00000000-0000-0000-0000-000000000001',
    '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":35},
      {\"user_id\":\"30000000-0000-0000-0000-000000000002\",\"chips\":32}]'
  );
  DO \$proof\$
  BEGIN
    IF (SELECT chips FROM public.tournament_players
         WHERE id = '40000000-0000-0000-0000-000000000001') <> 35
       OR (SELECT chips FROM public.tournament_players
         WHERE id = '40000000-0000-0000-0000-000000000002') <> 32 THEN
      RAISE EXCEPTION 'PROBE_STRICT_SYNC_DID_NOT_UPDATE';
    END IF;
  END;
  \$proof\$;
  ROLLBACK;
" >/dev/null
assert_normalized_sync_postimage success

# BIGINT is a real cumulative contract, not merely a catalog rename.
pg_exec success -c "
  BEGIN;
  SELECT public.fn_sync_tournament_chips(
    '00000000-0000-0000-0000-000000000001',
    '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":2147483648}]'
  );
  DO \$proof\$
  BEGIN
    IF (SELECT chips FROM public.tournament_players
         WHERE id = '40000000-0000-0000-0000-000000000001') <> 2147483648 THEN
      RAISE EXCEPTION 'PROBE_BIGINT_SYNC_DID_NOT_UPDATE';
    END IF;
  END;
  \$proof\$;
  ROLLBACK;
" >/dev/null
assert_normalized_sync_postimage success
expect_sql_failure success TOURNAMENT_CHIP_SYNC_INPUT_INVALID \
  "SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000001', '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":10000000000000}]');"
assert_normalized_sync_postimage success

expect_sql_failure success TOURNAMENT_CHIP_SYNC_INPUT_INVALID \
  "SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000001', '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":35},{\"user_id\":\"30000000-0000-0000-0000-000000000002\",\"chips\":32.5}]');"
assert_normalized_sync_postimage success
expect_sql_failure success TOURNAMENT_CHIP_SYNC_INPUT_INVALID \
  "SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000001', '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":35},{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":36}]');"
assert_normalized_sync_postimage success
expect_sql_failure success TOURNAMENT_CHIP_SYNC_INPUT_INVALID \
  "SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000001', '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":35,\"extra\":true}]');"
assert_normalized_sync_postimage success
expect_sql_failure success TOURNAMENT_CHIP_SYNC_RECIPIENT_MISMATCH \
  "SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000001', '[{\"user_id\":\"30000000-0000-0000-0000-000000000001\",\"chips\":35},{\"user_id\":\"ffffffff-ffff-ffff-ffff-ffffffffffff\",\"chips\":1}]');"
assert_normalized_sync_postimage success
expect_sql_failure success TOURNAMENT_CHIP_SYNC_RECIPIENT_MISMATCH \
  "SELECT public.fn_sync_tournament_chips('00000000-0000-0000-0000-000000000002', '[{\"user_id\":\"30000000-0000-0000-0000-000000000004\",\"chips\":51}]');"
assert_normalized_sync_postimage success

pg_exec success -c "
  SET ROLE service_role;
  SELECT public.fn_sync_tournament_live_seat_chips(
    '00000000-0000-0000-0000-000000000001'
  );
" >/dev/null
assert_normalized_sync_postimage success

# A hand that already owns the seat row may commit after the sweep RPC starts.
# The RPC must wait for that exact source and then read the committed new stack,
# never overwrite tournament_players with the stale pre-hand snapshot.
pg_exec success -c "
  BEGIN;
  SET LOCAL application_name = 'live-seat-newer-source';
  UPDATE public.table_seats SET stack = 41
   WHERE id = '20000000-0000-0000-0000-000000000001';
  SELECT pg_sleep(2);
  COMMIT;
" >"$probe_root/live-seat-newer-source.log" 2>&1 &
newer_source_pid=$!
for _ in {1..40}; do
  if [[ "$(pg_exec success -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'live-seat-newer-source' AND wait_event = 'PgSleep';")" != '0' ]]; then
    break
  fi
  sleep 0.05
done
pg_exec success -qAtc "
  SET application_name = 'live-seat-snapshot-wrapper';
  SET statement_timeout = '5s';
  SET ROLE service_role;
  SELECT public.fn_sync_tournament_live_seat_chips(
    '00000000-0000-0000-0000-000000000001'
  );
" >"$probe_root/live-seat-snapshot-wrapper.log" 2>&1 &
snapshot_wrapper_pid=$!
snapshot_wrapper_blocked=0
for _ in {1..40}; do
  if [[ "$(pg_exec success -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'live-seat-snapshot-wrapper' AND wait_event_type = 'Lock';")" != '0' ]]; then
    snapshot_wrapper_blocked=1
    break
  fi
  sleep 0.05
done
if [[ "$snapshot_wrapper_blocked" != '1' ]]; then
  echo 'Live-seat wrapper did not reach the adversarial source-seat lock.' >&2
  exit 1
fi
# The live wrapper must not lock eliminated historical roster rows. This write
# completes while the wrapper is demonstrably blocked on an active source seat.
pg_exec success -c "
  SET statement_timeout = '1s';
  UPDATE public.tournament_players SET status = 'winner'
   WHERE id = '40000000-0000-0000-0000-000000000010';
" >/dev/null
wait "$newer_source_pid"
wait "$snapshot_wrapper_pid"
if grep -Fq 'deadlock detected' "$probe_root/live-seat-newer-source.log" \
   || grep -Fq 'deadlock detected' "$probe_root/live-seat-snapshot-wrapper.log"; then
  echo 'Live-seat snapshot deadlocked with a committed hand source.' >&2
  exit 1
fi
if [[ "$(pg_exec success -Atc "SELECT stack::text FROM public.table_seats WHERE id = '20000000-0000-0000-0000-000000000001';")" != '41.00' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000001';")" != '41' ]]; then
  echo 'Live-seat sync overwrote or missed the newer committed hand stack.' >&2
  exit 1
fi
pg_exec success -c "
  UPDATE public.tournament_players SET status = 'eliminated'
   WHERE id = '40000000-0000-0000-0000-000000000010';
  UPDATE public.table_seats SET stack = 34
   WHERE id = '20000000-0000-0000-0000-000000000001';
  UPDATE public.tournament_players SET chips = 34
   WHERE id = '40000000-0000-0000-0000-000000000001';
" >/dev/null
assert_normalized_sync_postimage success

# Atomic elimination owns tournament -> player -> seat. Starting the sweep
# while that transaction is paused must serialize behind it, then observe the
# player and seat both terminal; a legitimate transition is never reported as
# a stale active/non-playing mismatch and cannot deadlock.
pg_exec success -c "
  BEGIN;
  SET LOCAL application_name = 'live-seat-atomic-elimination';
  SELECT id FROM public.tournaments
   WHERE id = '00000000-0000-0000-0000-000000000001' FOR UPDATE;
  SELECT id FROM public.tournament_players
   WHERE id = '40000000-0000-0000-0000-000000000001' FOR UPDATE;
  UPDATE public.tournament_players SET chips = 0, status = 'eliminated'
   WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE public.table_seats SET left_at = clock_timestamp()
   WHERE id = '20000000-0000-0000-0000-000000000001';
  SELECT pg_sleep(2);
  COMMIT;
" >"$probe_root/live-seat-atomic-elimination.log" 2>&1 &
atomic_elimination_pid=$!
for _ in {1..40}; do
  if [[ "$(pg_exec success -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'live-seat-atomic-elimination' AND wait_event = 'PgSleep';")" != '0' ]]; then
    break
  fi
  sleep 0.05
done
atomic_result="$(pg_exec success -qAtc "
  SET statement_timeout = '5s';
  SET ROLE service_role;
  WITH snapshot AS (
    SELECT public.fn_sync_tournament_live_seat_chips(
      '00000000-0000-0000-0000-000000000001'
    ) AS value
  )
  SELECT value->>'ok' FROM snapshot;
")"
wait "$atomic_elimination_pid"
if [[ "$atomic_result" != 'true' ]] \
   || grep -Fq 'deadlock detected' "$probe_root/live-seat-atomic-elimination.log"; then
  echo "Atomic elimination did not serialize cleanly with live-seat sync: ${atomic_result}" >&2
  exit 1
fi
if [[ "$(pg_exec success -Atc "SELECT chips::text || '|' || status FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000001';")" != '0|eliminated' ]] \
   || [[ "$(pg_exec success -Atc "SELECT (left_at IS NOT NULL)::text FROM public.table_seats WHERE id = '20000000-0000-0000-0000-000000000001';")" != 'true' ]]; then
  echo 'Atomic elimination state was changed by live-seat sync.' >&2
  exit 1
fi
pg_exec success -c "
  UPDATE public.tournament_players SET chips = 34, status = 'playing'
   WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE public.table_seats SET stack = 34, left_at = NULL
   WHERE id = '20000000-0000-0000-0000-000000000001';
" >/dev/null
assert_normalized_sync_postimage success

for corrupt_stack in '34.5' 'NULL' '-1'; do
  pg_exec success -c "
    ALTER TABLE public.table_seats
      DISABLE TRIGGER a1_require_whole_tournament_chips;
    UPDATE public.table_seats SET stack = ${corrupt_stack}
     WHERE id = '20000000-0000-0000-0000-000000000001';
    ALTER TABLE public.table_seats
      ENABLE TRIGGER a1_require_whole_tournament_chips;
  " >/dev/null
  expect_sql_failure success TOURNAMENT_LIVE_SEAT_CHIP_INPUT_INVALID \
    "SET ROLE service_role; SELECT public.fn_sync_tournament_live_seat_chips('00000000-0000-0000-0000-000000000001');"
  assert_normalized_sync_postimage success
  pg_exec success -c "
    UPDATE public.table_seats SET stack = 34
     WHERE id = '20000000-0000-0000-0000-000000000001';
  " >/dev/null
done

# A genuinely stale active seat with a non-playing mirror is quarantined while
# every exact healthy identity still synchronizes. The caller removes the
# returned recipient mismatch before every zero-chip and finish inference.
pg_exec success -c "
  UPDATE public.tournament_players SET chips = 0, status = 'eliminated'
   WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE public.tournament_players SET chips = 30
   WHERE id = '40000000-0000-0000-0000-000000000002';
" >/dev/null
recipient_mismatch_result="$(pg_exec success -qAtc "
  SET ROLE service_role;
  WITH snapshot AS (
    SELECT public.fn_sync_tournament_live_seat_chips(
      '00000000-0000-0000-0000-000000000001'
    ) AS value
  )
  SELECT
    (value->'recipient_mismatch_user_ids' =
      '[\"30000000-0000-0000-0000-000000000001\"]'::jsonb)::text
    || '|' || (value->'ambiguous_user_ids' = '[]'::jsonb)::text
    || '|' || (value->>'synced')
  FROM snapshot;
")"
if [[ "$recipient_mismatch_result" != 'true|true|1' ]]; then
  echo "Stable recipient mismatch did not quarantine only the corrupt identity while syncing healthy rows: ${recipient_mismatch_result}" >&2
  exit 1
fi
if [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000001';")" != '0' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000002';")" != '33' ]]; then
  echo 'Stable recipient mismatch changed the quarantined mirror or stalled a healthy sync.' >&2
  exit 1
fi
pg_exec success -c "
  UPDATE public.tournament_players SET chips = 34, status = 'playing'
   WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE public.tournament_players SET chips = 33
   WHERE id = '40000000-0000-0000-0000-000000000002';
" >/dev/null
assert_normalized_sync_postimage success

# live-seat-seatless-playing: the quarantine relation is bidirectional. A
# playing zero with no active seat must not disappear merely because the old
# wrapper built its output only FROM seats. Healthy seat mirrors still sync.
pg_exec success -c "
  UPDATE public.table_seats SET left_at = clock_timestamp()
   WHERE id = '20000000-0000-0000-0000-000000000001';
  UPDATE public.tournament_players SET chips = 0
   WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE public.tournament_players SET chips = 30
   WHERE id = '40000000-0000-0000-0000-000000000002';
" >/dev/null
seatless_playing_result="$(pg_exec success -qAtc "
  SET ROLE service_role;
  WITH snapshot AS (
    SELECT public.fn_sync_tournament_live_seat_chips(
      '00000000-0000-0000-0000-000000000001'
    ) AS value
  )
  SELECT
    (value->'recipient_mismatch_user_ids' =
      '[\"30000000-0000-0000-0000-000000000001\"]'::jsonb)::text
    || '|' || (value->'ambiguous_user_ids' = '[]'::jsonb)::text
    || '|' || (value->>'synced')
  FROM snapshot;
")"
if [[ "$seatless_playing_result" != 'true|true|1' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000001';")" != '0' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000002';")" != '33' ]]; then
  echo "A seatless playing zero escaped quarantine or stalled healthy sync: ${seatless_playing_result}" >&2
  exit 1
fi
pg_exec success -c "
  UPDATE public.table_seats SET left_at = NULL
   WHERE id = '20000000-0000-0000-0000-000000000001';
  UPDATE public.tournament_players SET chips = 34
   WHERE id = '40000000-0000-0000-0000-000000000001';
" >/dev/null
assert_normalized_sync_postimage success

# live-seat-ambiguous-generation: equal newest generations are not guessed.
# The ambiguous zero remains untouched while an independent healthy user moves.
pg_exec success -c "
  INSERT INTO public.table_seats(
    id, table_id, seat_number, user_id, stack, joined_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000090',
    '10000000-0000-0000-0000-000000000001', 4,
    '30000000-0000-0000-0000-000000000002', 0,
    '2026-09-08 15:10:02+00'
  );
  UPDATE public.tournament_players SET chips = 0
   WHERE id = '40000000-0000-0000-0000-000000000002';
  UPDATE public.tournament_players SET chips = 30
   WHERE id = '40000000-0000-0000-0000-000000000003';
" >/dev/null
ambiguous_generation_result="$(pg_exec success -qAtc "
  SET ROLE service_role;
  WITH snapshot AS (
    SELECT public.fn_sync_tournament_live_seat_chips(
      '00000000-0000-0000-0000-000000000001'
    ) AS value
  )
  SELECT
    (value->'ambiguous_user_ids' =
      '[\"30000000-0000-0000-0000-000000000002\"]'::jsonb)::text
    || '|' || (value->'recipient_mismatch_user_ids' = '[]'::jsonb)::text
    || '|' || (value->>'synced')
  FROM snapshot;
")"
if [[ "$ambiguous_generation_result" != 'true|true|1' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000002';")" != '0' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000003';")" != '33' ]]; then
  echo "An ambiguous generation escaped quarantine or stalled healthy sync: ${ambiguous_generation_result}" >&2
  exit 1
fi

# live-seat-unequal-active-generations: a uniquely newest seat still is not an
# exact identity while an older row remains active/dealable. Require one active
# row, not merely one row tied for the latest timestamp.
pg_exec success -c "
  UPDATE public.table_seats SET joined_at = '2026-09-08 15:09:02+00', stack = 777
   WHERE id = '20000000-0000-0000-0000-000000000090';
  UPDATE public.tournament_players SET chips = 30
   WHERE id = '40000000-0000-0000-0000-000000000003';
" >/dev/null
unequal_generation_result="$(pg_exec success -qAtc "
  SET ROLE service_role;
  WITH snapshot AS (
    SELECT public.fn_sync_tournament_live_seat_chips(
      '00000000-0000-0000-0000-000000000001'
    ) AS value
  )
  SELECT
    (value->'ambiguous_user_ids' =
      '[\"30000000-0000-0000-0000-000000000002\"]'::jsonb)::text
    || '|' || (value->'recipient_mismatch_user_ids' = '[]'::jsonb)::text
    || '|' || (value->>'synced')
  FROM snapshot;
")"
if [[ "$unequal_generation_result" != 'true|true|1' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000002';")" != '0' ]] \
   || [[ "$(pg_exec success -Atc "SELECT chips::text FROM public.tournament_players WHERE id = '40000000-0000-0000-0000-000000000003';")" != '33' ]]; then
  echo "Unequal duplicate active generations were guessed or stalled healthy sync: ${unequal_generation_result}" >&2
  exit 1
fi
pg_exec success -c "
  DELETE FROM public.table_seats
   WHERE id = '20000000-0000-0000-0000-000000000090';
  UPDATE public.tournament_players SET chips = 33
   WHERE id = '40000000-0000-0000-0000-000000000002';
" >/dev/null
assert_normalized_sync_postimage success

# Reclassifying a cash table with a fractional active seat must be rejected
# even when all of the table's own chip settings are whole.
pg_exec success -c "
  INSERT INTO public.tables(
    id, tournament_id, game_type, status, small_blind, big_blind, ante,
    bomb_pot_enabled, bomb_pot_ante_fixed, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000098', NULL, 'cash', 'running',
    1, 2, 0, false, NULL, '2026-09-08 17:03:00+00'
  );
  INSERT INTO public.table_seats(
    id, table_id, seat_number, user_id, stack, joined_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000098',
    '10000000-0000-0000-0000-000000000098', 1,
    '30000000-0000-0000-0000-000000000098', 10.25,
    '2026-09-08 17:04:00+00'
  );
" >/dev/null
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "UPDATE public.tables SET game_type = 'tournament' WHERE id = '10000000-0000-0000-0000-000000000098';"

# Prove the parent-classification/child-stack race in both orders. The losing
# statement gets the invariant error after bounded waiting; neither order can
# cycle into 40P01 because the table trigger never locks a child row.
pg_exec success -c "
  INSERT INTO public.tables(
    id, tournament_id, game_type, status, small_blind, big_blind, ante,
    bomb_pot_enabled, bomb_pot_ante_fixed, created_at
  ) VALUES
    ('10000000-0000-0000-0000-000000000095', NULL, 'cash', 'running',
     1, 2, 0, false, NULL, '2026-09-08 17:08:00+00'),
    ('10000000-0000-0000-0000-000000000094', NULL, 'cash', 'running',
     1, 2, 0, false, NULL, '2026-09-08 17:09:00+00');
  INSERT INTO public.table_seats(
    id, table_id, seat_number, user_id, stack, joined_at
  ) VALUES
    ('20000000-0000-0000-0000-000000000095',
     '10000000-0000-0000-0000-000000000095', 1,
     '30000000-0000-0000-0000-000000000095', 10,
     '2026-09-08 17:10:00+00'),
    ('20000000-0000-0000-0000-000000000094',
     '10000000-0000-0000-0000-000000000094', 1,
     '30000000-0000-0000-0000-000000000094', 10,
     '2026-09-08 17:11:00+00');
" >/dev/null

pg_exec success -c "
  BEGIN;
  SET LOCAL application_name = 'fractional-table-first';
  UPDATE public.tables SET game_type = 'tournament'
   WHERE id = '10000000-0000-0000-0000-000000000095';
  SELECT pg_sleep(2);
  COMMIT;
" >"$probe_root/table-first.log" 2>&1 &
table_first_pid=$!
for _ in {1..40}; do
  if [[ "$(pg_exec success -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'fractional-table-first' AND wait_event = 'PgSleep';")" != '0' ]]; then
    break
  fi
  sleep 0.05
done
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "SET statement_timeout = '5s'; UPDATE public.table_seats SET stack = 10.5 WHERE id = '20000000-0000-0000-0000-000000000095';"
wait "$table_first_pid"
if grep -Fq 'deadlock detected' "$probe_root/table-first.log"; then
  echo 'Table-first classification race deadlocked.' >&2
  exit 1
fi

pg_exec success -c "
  BEGIN;
  SET LOCAL application_name = 'fractional-seat-first';
  UPDATE public.table_seats SET stack = 10.5
   WHERE id = '20000000-0000-0000-0000-000000000094';
  SELECT pg_sleep(2);
  COMMIT;
" >"$probe_root/seat-first.log" 2>&1 &
seat_first_pid=$!
for _ in {1..40}; do
  if [[ "$(pg_exec success -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'fractional-seat-first' AND wait_event = 'PgSleep';")" != '0' ]]; then
    break
  fi
  sleep 0.05
done
expect_sql_failure success TOURNAMENT_WHOLE_CHIP_REQUIRED \
  "SET statement_timeout = '5s'; UPDATE public.tables SET game_type = 'tournament' WHERE id = '10000000-0000-0000-0000-000000000094';"
wait "$seat_first_pid"
if grep -Fq 'deadlock detected' "$probe_root/seat-first.log"; then
  echo 'Seat-first classification race deadlocked.' >&2
  exit 1
fi
if [[ "$(pg_exec success -Atc "
  SELECT count(*) FROM public.tables tb
  JOIN public.table_seats s ON s.table_id = tb.id
  WHERE (tb.tournament_id IS NOT NULL OR lower(tb.game_type) = 'tournament')
    AND s.left_at IS NULL AND s.stack <> trunc(s.stack)
    AND tb.id IN ('10000000-0000-0000-0000-000000000094',
                  '10000000-0000-0000-0000-000000000095');")" != '0' ]]; then
  echo 'Classification race committed a fractional tournament seat.' >&2
  exit 1
fi

# A checked-in patched artifact also remains safe on a later clean rebuild.
clone_fixture empty_patched
pg_exec empty_patched -c '
  TRUNCATE public.hand_atomic_commits, public.settlement_idempotency_keys,
    public.hand_state_snapshots, public.engine_tournament_leases,
    public.engine_table_leases, public.engine_leader,
    public.engine_maintenance_break, public.table_seats,
    public.tournament_players, public.tables, public.tournaments CASCADE;
' >/dev/null
pg_exec empty_patched -f "$rendered_success" >/dev/null

# Runtime/freeze/hand/cohort drift all fail before a row can change.
# historical-old-build-lease: rows last authoritative before the exact break
# announcement are inert history. Relation/row NOWAIT locks stop them from
# freshening, and they do not falsely block the cutover.
clone_fixture stale_historical_lease
render_migration stale_historical_lease "$render_dir/stale_historical_lease.sql"
pg_exec stale_historical_lease -c "
  UPDATE public.engine_table_leases
     SET engine_version = 'c3821317', protocol_version = 1
   WHERE table_id = '10000000-0000-0000-0000-000000000001';
" >/dev/null
pg_exec stale_historical_lease -f "$render_dir/stale_historical_lease.sql" >/dev/null
if [[ "$(pg_exec stale_historical_lease -Atc "SELECT stack::text FROM public.table_seats WHERE id = '20000000-0000-0000-0000-000000000001';")" != '34.00' ]]; then
  echo 'Historical old-build lease incorrectly blocked the normalized postimage.' >&2
  exit 1
fi

clone_fixture live_lease
render_migration live_lease "$render_dir/live_lease.sql"
pg_exec live_lease -c "
  UPDATE public.engine_table_leases
     SET heartbeat_at = clock_timestamp(), engine_version = 'c3821317', protocol_version = 1;
" >/dev/null
expect_file_failure live_lease FRACTIONAL_STACK_ENGINE_STILL_LIVE "$render_dir/live_lease.sql"
assert_legacy_preimage live_lease

# causal-wrong-build-lease: even after it ages past the 30-second liveness
# floor, a wrong build observed after the break announcement disproves the
# exact-build cutover and fails independently of stale historical debris.
clone_fixture causal_wrong_build_lease
render_migration causal_wrong_build_lease "$render_dir/causal_wrong_build_lease.sql"
pg_exec causal_wrong_build_lease -c "
  UPDATE public.engine_table_leases
     SET heartbeat_at = (
           SELECT announced_at + interval '5 seconds'
             FROM public.engine_maintenance_break WHERE id
         ),
         engine_version = 'c3821317', protocol_version = 1
   WHERE table_id = '10000000-0000-0000-0000-000000000001';
" >/dev/null
expect_file_failure causal_wrong_build_lease FRACTIONAL_STACK_ENGINE_VERSION_DRIFT "$render_dir/causal_wrong_build_lease.sql"
assert_legacy_preimage causal_wrong_build_lease

clone_fixture inflight_hand
render_migration inflight_hand "$render_dir/inflight_hand.sql"
pg_exec inflight_hand -c "
  INSERT INTO public.hand_state_snapshots(id, table_id, hand_number, is_complete)
  VALUES ('70000000-0000-0000-0000-000000000001',
          '10000000-0000-0000-0000-000000000001', 1, false);
" >/dev/null
expect_file_failure inflight_hand FRACTIONAL_STACK_HAND_IN_FLIGHT "$render_dir/inflight_hand.sql"
assert_legacy_preimage inflight_hand

clone_fixture source_drift
render_migration source_drift "$render_dir/source_drift.sql"
pg_exec source_drift -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats SET stack = 33.35
   WHERE id = '20000000-0000-0000-0000-000000000001';
  UPDATE public.table_seats SET stack = 33.32
   WHERE id = '20000000-0000-0000-0000-000000000002';
  COMMIT;
" >/dev/null
expect_file_failure source_drift FRACTIONAL_STACK_SOURCE_DRIFT "$render_dir/source_drift.sql"

clone_fixture identity_mismatch
pg_exec identity_mismatch -c "
  UPDATE public.tournament_players
     SET table_id = '10000000-0000-0000-0000-000000000003',
         seat_number = 2
   WHERE id = '40000000-0000-0000-0000-000000000004';
" >/dev/null
render_migration identity_mismatch "$render_dir/identity_mismatch.sql"
expect_file_failure identity_mismatch FRACTIONAL_STACK_IDENTITY_MISMATCH "$render_dir/identity_mismatch.sql"

clone_fixture fractional_aggregate
pg_exec fractional_aggregate -c "
  BEGIN;
  SET LOCAL app.freeze_bypass = 'on';
  UPDATE public.table_seats SET stack = 33.35
   WHERE id = '20000000-0000-0000-0000-000000000001';
  UPDATE public.table_seats SET stack = 49.49
   WHERE id = '20000000-0000-0000-0000-000000000005';
  COMMIT;
" >/dev/null
render_migration fractional_aggregate "$render_dir/fractional_aggregate.sql"
expect_file_failure fractional_aggregate FRACTIONAL_STACK_AGGREGATE_IS_FRACTIONAL "$render_dir/fractional_aggregate.sql"

clone_fixture unmeasured_orphan
render_migration unmeasured_orphan "$render_dir/unmeasured_orphan.sql"
pg_exec unmeasured_orphan -c "
  INSERT INTO public.tables(
    id, tournament_id, game_type, status, small_blind, big_blind, ante,
    bomb_pot_enabled, bomb_pot_ante_fixed, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000097', NULL, 'tournament', 'running',
    1, 2, 0, false, NULL, '2026-09-08 17:05:00+00'
  );
  INSERT INTO public.table_seats(
    id, table_id, seat_number, user_id, stack, joined_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000097',
    '10000000-0000-0000-0000-000000000097', 1,
    '30000000-0000-0000-0000-000000000097', 10.50,
    '2026-09-08 17:06:00+00'
  );
" >/dev/null
expect_file_failure unmeasured_orphan FRACTIONAL_STACK_IDENTITY_MISMATCH "$render_dir/unmeasured_orphan.sql"
assert_legacy_preimage unmeasured_orphan

clone_fixture fractional_bomb_source
render_migration fractional_bomb_source "$render_dir/fractional_bomb_source.sql"
pg_exec fractional_bomb_source -c "
  INSERT INTO public.tables(
    id, tournament_id, game_type, status, small_blind, big_blind, ante,
    bomb_pot_enabled, bomb_pot_ante_fixed, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000096', NULL, 'tournament', 'running',
    1, 2, 0, true, 2.5, '2026-09-08 17:07:00+00'
  );
" >/dev/null
expect_file_failure fractional_bomb_source TOURNAMENT_WHOLE_CHIP_SOURCE_INVALID "$render_dir/fractional_bomb_source.sql"
assert_legacy_preimage fractional_bomb_source

clone_fixture null_blind_structure
render_migration null_blind_structure "$render_dir/null_blind_structure.sql"
pg_exec null_blind_structure -c "
  UPDATE public.tournaments SET blind_structure = NULL
   WHERE id = '00000000-0000-0000-0000-000000000002';
" >/dev/null
expect_file_failure null_blind_structure TOURNAMENT_WHOLE_CHIP_SOURCE_INVALID "$render_dir/null_blind_structure.sql"
assert_legacy_preimage null_blind_structure

clone_fixture empty_blind_structure
render_migration empty_blind_structure "$render_dir/empty_blind_structure.sql"
pg_exec empty_blind_structure -c "
  UPDATE public.tournaments SET blind_structure = '[]'
   WHERE id = '00000000-0000-0000-0000-000000000002';
" >/dev/null
expect_file_failure empty_blind_structure TOURNAMENT_WHOLE_CHIP_SOURCE_INVALID "$render_dir/empty_blind_structure.sql"
assert_legacy_preimage empty_blind_structure

clone_fixture all_break_blind_structure
render_migration all_break_blind_structure "$render_dir/all_break_blind_structure.sql"
pg_exec all_break_blind_structure -c "
  UPDATE public.tournaments
     SET blind_structure = '[{\"isBreak\":true,\"smallBlind\":0.5,\"bigBlind\":0.5}]'
   WHERE id = '00000000-0000-0000-0000-000000000002';
" >/dev/null
expect_file_failure all_break_blind_structure TOURNAMENT_WHOLE_CHIP_SOURCE_INVALID "$render_dir/all_break_blind_structure.sql"
assert_legacy_preimage all_break_blind_structure

# A skipped target row is detected and the enclosing transaction rolls back
# every earlier seat update as well as all later mirror work.
clone_fixture partial_write
render_migration partial_write "$render_dir/partial_write.sql"
pg_exec partial_write -c "
  CREATE FUNCTION public.probe_skip_one_stack() RETURNS trigger
  LANGUAGE plpgsql AS \$body\$
  BEGIN
    IF NEW.id = '20000000-0000-0000-0000-000000000003'::uuid THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END;
  \$body\$;
  CREATE TRIGGER aa_skip_one_stack
    BEFORE UPDATE OF stack ON public.table_seats
    FOR EACH ROW EXECUTE FUNCTION public.probe_skip_one_stack();
" >/dev/null
expect_file_failure partial_write FRACTIONAL_STACK_PARTIAL_SEAT_WRITE "$render_dir/partial_write.sql"
assert_legacy_preimage partial_write

# A pre-existing reader of one lifecycle table makes the NOWAIT relation lock
# fail. It is never waited out into a moving-cohort rewrite.
clone_fixture concurrent_lock
render_migration concurrent_lock "$render_dir/concurrent_lock.sql"
pg_exec concurrent_lock -c "BEGIN; LOCK TABLE public.tables IN ACCESS SHARE MODE; SELECT pg_sleep(6); COMMIT;" \
  >"$probe_root/concurrent-holder.log" 2>&1 &
holder_pid=$!
for _ in {1..40}; do
  if [[ "$(pg_exec concurrent_lock -Atc "
    SELECT count(*) FROM pg_locks
     WHERE relation = 'public.tables'::regclass
       AND mode = 'AccessShareLock' AND granted;")" != '0' ]]; then
    break
  fi
  sleep 0.05
done
expect_file_failure concurrent_lock 'could not obtain lock on relation' "$render_dir/concurrent_lock.sql"
wait "$holder_pid"
assert_legacy_preimage concurrent_lock

echo "PostgreSQL 17 tournament fractional-stack cutover, rollback, replay, and ingress-guard probes passed (successful rendered apply: ${apply_ms} ms)."
