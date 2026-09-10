#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration_dir="$repo_dir/supabase/migrations"
archive_dir="$repo_dir/supabase/retired-unapplied"
manifest="$archive_dir/MANIFEST.sha256"
resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/dev/probe-stage-b-forward-chain-pg17.sh [MODE]

MODE is one of:
  --resolve-only          resolve and byte-check sources without a database
  --keyshare-replay       apply #1-#6, then prove #6 is an exact no-op replay
  --keyshare-mixed-state  apply #1-#5, inject one ownership key, and prove #6
                          refuses and rolls back the mixed preimage

Without MODE, this clones the acknowledged baseline twice, proves the terminal-
break repair success and late-failure rollback cases, then applies the six
current Stage-B migrations once to the acknowledged clone. Database modes use
one already-prepared, disposable local PostgreSQL 17 clone. Set:
  STAGE_B_FORWARD_REHEARSAL_ACK=DISPOSABLE_LOCAL_PG17_CLONE
  STAGE_B_FORWARD_REHEARSAL_DATABASE=<exact current_database() name>
and connect with normal libpq variables or PGSERVICE. DATABASE_URL is rejected.
USAGE
  exit 64
}

probe_mode='apply'
case "${1:-}" in
  '') ;;
  --resolve-only) probe_mode='resolve' ;;
  --keyshare-replay) probe_mode='replay' ;;
  --keyshare-mixed-state) probe_mode='mixed' ;;
  *) usage ;;
esac
[[ "$#" -le 1 ]] || usage

[[ -r "$resolver" ]] || {
  echo 'The staged-or-promoted migration resolver is unreadable.' >&2
  exit 66
}
# shellcheck source=../ops/lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$resolver"

chain_names=(
  stage_b_forward_authority_expansion
  stage_b_exact_precondition_repairs
  stage_b_terminal_break_invariant
  stage_b_atomic_finish_precertification
  stage_b_current_postimage_contraction
  stage_b_lease_keyshare_once
)
chain_files=()
for migration_name in "${chain_names[@]}"; do
  chain_files+=("$(resolve_staged_or_promoted_migration "$migration_dir" "$migration_name")")
done

baseline_names=(
  seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in
  spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row
  the_settlement_lane_is_per_tournament_not_platform_wide
)
baseline_files=()
baseline_versions=()
for migration_name in "${baseline_names[@]}"; do
  baseline_file="$(resolve_staged_or_promoted_migration "$migration_dir" "$migration_name")"
  baseline_basename="$(basename "$baseline_file")"
  baseline_version="${baseline_basename%%_*}"
  [[ "$baseline_version" =~ ^[0-9]{14}$ ]] || {
    echo "Baseline migration has no ledger-shaped version: ${baseline_basename}." >&2
    exit 65
  }
  baseline_files+=("$baseline_file")
  baseline_versions+=("$baseline_version")
done

for ((index = 1; index < ${#baseline_versions[@]}; index += 1)); do
  if [[ ! "${baseline_versions[$((index - 1))]}" < "${baseline_versions[$index]}" ]]; then
    echo 'Current pre-Stage-B baseline migrations do not have strict version order.' >&2
    exit 65
  fi
done

newest_baseline="$(basename "${baseline_files[2]}")"
first_stage_b="$(basename "${chain_files[0]}")"
first_stage_b_version="${first_stage_b%%_*}"
if [[ ! "${baseline_versions[2]}" < "$first_stage_b_version" ]]; then
  echo "Stage-B starts at or before the current ledger head: ${first_stage_b} does not follow ${newest_baseline}." >&2
  exit 65
fi

for ((index = 1; index < ${#chain_files[@]}; index += 1)); do
  previous="$(basename "${chain_files[$((index - 1))]}")"
  current="$(basename "${chain_files[$index]}")"
  previous_version="${previous%%_*}"
  current_version="${current%%_*}"
  if [[ ! "$previous_version" =~ ^[0-9]{14}$ \
     || ! "$current_version" =~ ^[0-9]{14}$ ]]; then
    echo "Stage-B migration has no ledger-shaped version: ${previous} or ${current}." >&2
    exit 65
  fi
  if [[ ! "$previous_version" < "$current_version" ]]; then
    echo "Stage-B migration versions are not strictly increasing: ${previous} then ${current}." >&2
    exit 65
  fi
done

[[ -r "$manifest" ]] || {
  echo 'The retired Stage-B SHA-256 manifest is unreadable.' >&2
  exit 66
}
(
  cd "$archive_dir"
  shasum -a 256 -c "$(basename "$manifest")" >/dev/null
)

retired_count=0
while IFS= read -r manifest_row; do
  [[ "$manifest_row" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]([^/]+\.sql)$ ]] || continue
  retired_file="${BASH_REMATCH[1]}"
  retired_count=$((retired_count + 1))
  if [[ -e "$migration_dir/$retired_file" ]]; then
    echo "Retired Stage-B migration is active again: ${retired_file}." >&2
    exit 65
  fi
done < "$manifest"
if [[ "$retired_count" -ne 13 ]]; then
  echo "Expected thirteen retired Stage-B migrations; found ${retired_count}." >&2
  exit 65
fi

for ((index = 0; index < ${#chain_files[@]}; index += 1)); do
  printf '%d %s\n' "$((index + 1))" "${chain_files[$index]}"
done
if [[ "$probe_mode" == 'resolve' ]]; then
  echo 'STAGE_B_FORWARD_CHAIN_RESOLVED'
  exit 0
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo 'DATABASE_URL is not accepted; use PGSERVICE or ordinary libpq variables.' >&2
  exit 64
fi
if [[ "${STAGE_B_FORWARD_REHEARSAL_ACK:-}" != 'DISPOSABLE_LOCAL_PG17_CLONE' ]]; then
  echo 'Refusing to mutate a database without the disposable-local-clone acknowledgement.' >&2
  exit 64
fi
expected_database="${STAGE_B_FORWARD_REHEARSAL_DATABASE:-}"
if [[ -z "$expected_database" ]]; then
  echo 'STAGE_B_FORWARD_REHEARSAL_DATABASE must name the exact disposable database.' >&2
  exit 64
fi

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/psql" ]] \
   || [[ ! -x "${pg17_bin}/createdb" ]] \
   || [[ ! -x "${pg17_bin}/dropdb" ]] \
   || ! "${pg17_bin}/psql" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 psql, createdb and dropdb are required. Set PG17_BINDIR to its bin directory.' >&2
  exit 2
fi

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  --dbname="$expected_database"
  -v "baseline_version_1=${baseline_versions[0]}"
  -v "baseline_name_1=${baseline_names[0]}"
  -v "baseline_version_2=${baseline_versions[1]}"
  -v "baseline_name_2=${baseline_names[1]}"
  -v "baseline_version_3=${baseline_versions[2]}"
  -v "baseline_name_3=${baseline_names[2]}"
)
preflight="$({
  "${psql_cmd[@]}" -Atq -F '|' <<'SQL'
SELECT current_database(),
       current_setting('server_version_num')::integer / 10000,
       COALESCE(inet_server_addr()::text, 'local-socket'),
       CASE
         WHEN inet_server_addr() IS NULL
           OR inet_server_addr() <<= inet '127.0.0.0/8'
           OR inet_server_addr() = inet '::1'
         THEN 'local'
         ELSE 'remote'
       END,
       CASE
         WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN -1
         ELSE (
           SELECT count(*)
             FROM supabase_migrations.schema_migrations
            WHERE (version, name) IN (
              (:'baseline_version_1', :'baseline_name_1'),
              (:'baseline_version_2', :'baseline_name_2'),
              (:'baseline_version_3', :'baseline_name_3')
            )
         )
       END,
       CASE
         WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN -1
         ELSE (
           SELECT count(*)
             FROM supabase_migrations.schema_migrations
            WHERE name IN (
              'stage_b_forward_authority_expansion',
              'stage_b_exact_precondition_repairs',
              'stage_b_terminal_break_invariant',
              'stage_b_atomic_finish_precertification',
              'stage_b_current_postimage_contraction',
              'stage_b_lease_keyshare_once'
            )
         )
       END,
       CASE
         WHEN to_regclass('public.engine_maintenance_break') IS NULL
           OR to_regprocedure('public.fn_platform_frozen()') IS NULL THEN -1
         ELSE (
           SELECT count(*)
             FROM public.engine_maintenance_break b
            WHERE b.id
              AND b.enforce_freeze
              AND b.phase = 'counting_down'
              AND public.fn_platform_frozen()
         )
       END,
       CASE
         WHEN to_regclass('public.engine_leader') IS NULL
           OR to_regclass('public.engine_table_leases') IS NULL
           OR to_regclass('public.engine_tournament_leases') IS NULL THEN -1
         ELSE
           (SELECT count(*) FROM public.engine_leader
             WHERE heartbeat_at >= clock_timestamp() - interval '30 seconds')
           + (SELECT count(*) FROM public.engine_table_leases
               WHERE heartbeat_at >= clock_timestamp() - interval '30 seconds')
           + (SELECT count(*) FROM public.engine_tournament_leases
               WHERE heartbeat_at >= clock_timestamp() - interval '30 seconds')
       END,
       (SELECT count(*)
          FROM pg_proc p
         WHERE p.oid=to_regprocedure(
                 'public.fn_receipted_tournament_is_immutable()'
               )
           AND p.proacl::text='{postgres=X/postgres}'),
       (SELECT count(*)
          FROM pg_proc p
          JOIN pg_language l ON l.oid=p.prolang
         WHERE p.oid=to_regprocedure(
                 'public.fn_managed_game_contract_document(text,jsonb)'
               )
           AND md5(pg_get_functiondef(p.oid))=
                 '6a8019cb24b5a8a42645b9de3aaf48ef'
           AND p.proowner='postgres'::regrole
           AND NOT p.prosecdef
           AND p.provolatile='i'
           AND p.proparallel='u'
           AND NOT p.proleakproof
           AND p.prokind='f'
           AND NOT p.proisstrict
           AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=2
           AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
                 '{postgres=X/postgres,service_role=X/postgres}'
           AND l.lanname='sql');
SQL
})"
IFS='|' read -r actual_database major_version server_address locality \
  baseline_receipts staged_receipts frozen_rows fresh_authorities \
  immutable_guard_acl contract_document_shape <<<"$preflight"

if [[ "$actual_database" != "$expected_database" ]]; then
  echo "Connected database ${actual_database:-<unknown>} does not match the acknowledged disposable database." >&2
  exit 65
fi
if [[ "$major_version" != '17' || "$locality" != 'local' ]]; then
  echo "Rehearsal requires local PostgreSQL 17; observed ${server_address:-unknown}." >&2
  exit 65
fi
if [[ "$baseline_receipts" != '3' ]]; then
  echo 'The disposable clone is not based on all three current pre-Stage-B ledger boundaries.' >&2
  exit 65
fi
if [[ "$staged_receipts" != '0' ]]; then
  echo 'At least one Stage-B boundary is already ledgered; use a fresh disposable clone.' >&2
  exit 65
fi
if [[ "$frozen_rows" != '1' || "$fresh_authorities" != '0' ]]; then
  echo 'The disposable clone is not frozen with every engine authority stale.' >&2
  exit 65
fi
if [[ "$immutable_guard_acl" != '1' ]]; then
  echo 'The disposable clone does not preserve the explicit production ACL on the receipted tournament immutability guard.' >&2
  exit 65
fi
if [[ "$contract_document_shape" != '1' ]]; then
  echo 'The disposable clone is missing the exact production managed-game contract document helper and ACL.' >&2
  exit 65
fi

emit_keyshare_fingerprint_function() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.stage_b_keyshare_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fingerprint$
WITH target_functions(identity) AS (
  VALUES
    ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'),
    ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'),
    ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)'),
    ('smarter_private.fn_smarter_data_api_pre_request()')
), function_rows AS (
  SELECT target.identity,
         p.oid,
         CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_functiondef(p.oid) END
           AS definition,
         CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_userbyid(p.proowner) END
           AS owner_name,
         p.prosecdef,
         p.proconfig,
         p.proacl,
         p.provolatile,
         p.proparallel,
         p.proisstrict,
         p.proleakproof,
         p.prokind,
         CASE WHEN p.oid IS NULL THEN NULL ELSE p.prorettype::regtype::text END
           AS return_type
    FROM target_functions target
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(target.identity)
), target_constraints(relation_name,constraint_name) AS (
  VALUES
    ('public.engine_table_leases',
     'engine_table_leases_owner_generation_key'),
    ('public.engine_tournament_leases',
     'engine_tournament_leases_owner_generation_key')
), constraint_rows AS (
  SELECT target.relation_name,
         target.constraint_name,
         con.oid,
         CASE WHEN con.oid IS NULL THEN NULL
              ELSE pg_get_constraintdef(con.oid,true) END AS definition,
         CASE WHEN con.oid IS NULL THEN NULL
              ELSE obj_description(con.oid,'pg_constraint') END AS comment,
         con.contype,
         con.convalidated,
         con.condeferrable,
         con.condeferred,
         con.connoinherit,
         con.conkey,
         NULLIF(con.conindid,0) AS index_oid,
         CASE WHEN con.conindid=0 THEN NULL
              ELSE pg_get_indexdef(con.conindid) END AS index_definition,
         CASE WHEN idx.oid IS NULL THEN NULL
              ELSE pg_get_userbyid(idx.relowner) END AS index_owner,
         ind.indisunique,
         ind.indisprimary,
         ind.indisvalid,
         ind.indisready,
         ind.indisclustered,
         ind.indisreplident,
         ind.indimmediate,
         ind.indcheckxmin,
         ind.indislive,
         ind.indnullsnotdistinct,
         ind.indnkeyatts,
         ind.indnatts,
         ind.indkey,
         CASE WHEN idx.oid IS NULL THEN NULL
              ELSE pg_get_expr(ind.indpred,ind.indrelid) END AS predicate,
         CASE WHEN idx.oid IS NULL THEN NULL
              ELSE pg_get_expr(ind.indexprs,ind.indrelid) END AS expressions
    FROM target_constraints target
    LEFT JOIN pg_constraint con
      ON con.conrelid=to_regclass(target.relation_name)
     AND con.conname=target.constraint_name
    LEFT JOIN pg_index ind ON ind.indexrelid=con.conindid
    LEFT JOIN pg_class idx ON idx.oid=con.conindid
)
SELECT CASE
         WHEN (SELECT count(*) FROM function_rows WHERE oid IS NOT NULL)<>4
           THEN 'missing'
         ELSE md5(jsonb_build_object(
           'functions',(
             SELECT jsonb_agg(
               jsonb_build_object(
                 'identity',identity,
                 'present',oid IS NOT NULL,
                 'function_oid',oid,
                 'definition',definition,
                 'owner',owner_name,
                 'security_definer',prosecdef,
                 'configuration',proconfig,
                 'acl',proacl,
                 'volatility',provolatile,
                 'parallel',proparallel,
                 'strict',proisstrict,
                 'leakproof',proleakproof,
                 'kind',prokind,
                 'return_type',return_type)
               ORDER BY identity)
               FROM function_rows),
           'constraints',(
             SELECT jsonb_agg(
               jsonb_build_object(
                 'relation',relation_name,
                 'name',constraint_name,
                 'present',oid IS NOT NULL,
                 'constraint_oid',oid,
                 'definition',definition,
                 'comment',comment,
                 'type',contype,
                 'validated',convalidated,
                 'deferrable',condeferrable,
                 'deferred',condeferred,
                 'no_inherit',connoinherit,
                 'keys',conkey,
                 'index_oid',index_oid,
                 'index_definition',index_definition,
                 'index_owner',index_owner,
                 'index_unique',indisunique,
                 'index_primary',indisprimary,
                 'index_valid',indisvalid,
                 'index_ready',indisready,
                 'index_clustered',indisclustered,
                 'index_replica_identity',indisreplident,
                 'index_immediate',indimmediate,
                 'index_check_xmin',indcheckxmin,
                 'index_live',indislive,
                 'index_nulls_not_distinct',indnullsnotdistinct,
                 'index_key_attributes',indnkeyatts,
                 'index_attributes',indnatts,
                 'index_keys',indkey,
                 'index_predicate',predicate,
                 'index_expressions',expressions)
               ORDER BY relation_name,constraint_name)
               FROM constraint_rows)
         )::text)
       END
  FROM (SELECT 1) singleton;
$fingerprint$;
SQL
}

emit_terminal_guard_fingerprint_function() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.stage_b_terminal_guard_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fingerprint$
SELECT COALESCE((
  SELECT md5(to_jsonb(guard_row)::text)
    FROM (
      SELECT p.oid AS function_oid,
             pg_get_functiondef(p.oid) AS definition,
             pg_get_userbyid(p.proowner) AS owner_name,
             l.lanname AS language_name,
             p.prosecdef,
             p.provolatile,
             p.proparallel,
             p.proleakproof,
             p.prokind,
             p.proisstrict,
             p.proretset,
             p.prorettype::regtype::text AS return_type,
             p.pronargs,
             p.pronargdefaults,
             p.proconfig,
             p.proacl,
             obj_description(p.oid,'pg_proc') AS function_comment,
             tg.oid AS trigger_oid,
             pg_get_triggerdef(tg.oid,true) AS trigger_definition,
             tg.tgenabled,
             tg.tgtype,
             tg.tgattr,
             CASE WHEN tg.tgqual IS NULL THEN NULL
                  ELSE pg_get_expr(tg.tgqual,tg.tgrelid) END AS trigger_when,
             tg.tgnargs,
             encode(tg.tgargs,'hex') AS trigger_arguments,
             tg.tgisinternal,
             obj_description(tg.oid,'pg_trigger') AS trigger_comment
        FROM pg_proc p
        JOIN pg_language l ON l.oid=p.prolang
        JOIN pg_trigger tg ON tg.tgfoid=p.oid
       WHERE p.oid=
             'public.fn_receipted_tournament_is_immutable()'::regprocedure
         AND tg.tgrelid='public.tournaments'::regclass
         AND tg.tgname='receipted_tournament_is_immutable'
         AND NOT tg.tgisinternal
    ) guard_row
), 'missing');
$fingerprint$;
SQL
}

run_chain_prefix() {
  local migration_count="$1"
  local replay_keyshare="$2"
  local target_database="${3:-$expected_database}"
  {
    printf '%s\n' '\set ON_ERROR_STOP on'
    printf '%s\n' '\set VERBOSITY verbose'
    printf '%s\n' 'SELECT pg_advisory_lock_shared(530090, 1);'
    for ((index = 0; index < migration_count; index += 1)); do
      migration_file="${chain_files[$index]}"
      printf '%s\n' "\\echo APPLYING $(basename "$migration_file")"
      printf '%s\n' "\\ir '$migration_file'"
    done
    if [[ "$replay_keyshare" == true ]]; then
      emit_keyshare_fingerprint_function
      cat <<'SQL'
CREATE TEMP TABLE stage_b_keyshare_replay_snapshot
ON COMMIT PRESERVE ROWS
AS SELECT pg_temp.stage_b_keyshare_fingerprint() AS fingerprint;
DO $verify_stage_b_keyshare_initial_postimage$
BEGIN
  IF (SELECT fingerprint
        FROM pg_temp.stage_b_keyshare_replay_snapshot)='missing' THEN
    RAISE EXCEPTION 'STAGE_B_LEASE_KEYSHARE_INITIAL_POSTIMAGE_MISSING';
  END IF;
END;
$verify_stage_b_keyshare_initial_postimage$;
SQL
      printf '%s\n' "\\echo REPLAYING $(basename "${chain_files[5]}")"
      printf '%s\n' "\\ir '${chain_files[5]}'"
      cat <<'SQL'
DO $verify_stage_b_keyshare_replay$
DECLARE
  v_before text;
  v_after text:=pg_temp.stage_b_keyshare_fingerprint();
BEGIN
  SELECT fingerprint INTO STRICT v_before
    FROM pg_temp.stage_b_keyshare_replay_snapshot;
  IF v_after='missing' OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'STAGE_B_LEASE_KEYSHARE_REPLAY_CHANGED_POSTIMAGE';
  END IF;
END;
$verify_stage_b_keyshare_replay$;
SELECT 'STAGE_B_LEASE_KEYSHARE_REPLAY_POSTIMAGE_EXACT';
SQL
    fi
    if [[ "$migration_count" -eq 6 ]]; then
      printf '%s\n' "DO \$verify_stage_b_forward_chain\$ BEGIN IF (SELECT count(*) FROM pg_constraint WHERE (conrelid='public.engine_table_leases'::regclass AND conname='engine_table_leases_owner_generation_key') OR (conrelid='public.engine_tournament_leases'::regclass AND conname='engine_tournament_leases_owner_generation_key')) <> 2 THEN RAISE EXCEPTION 'STAGE_B_FORWARD_CHAIN_POSTCONDITIONS_FAILED'; END IF; END \$verify_stage_b_forward_chain\$;"
      printf '%s\n' "SELECT 'STAGE_B_FORWARD_CHAIN_POSTCONDITIONS_OK';"
    fi
    printf '%s\n' 'SELECT pg_advisory_unlock_shared(530090, 1);'
  } | "${psql_cmd[@]}" --dbname="$target_database"
}

keyshare_postimage_fingerprint() {
  {
    emit_keyshare_fingerprint_function
    printf '%s\n' 'SELECT pg_temp.stage_b_keyshare_fingerprint();'
  } | "${psql_cmd[@]}" -Atq
}

terminal_guard_fingerprint() {
  local database="$1"
  {
    emit_terminal_guard_fingerprint_function
    printf '%s\n' 'SELECT pg_temp.stage_b_terminal_guard_fingerprint();'
  } | "${psql_cmd[@]}" --dbname="$database" -Atq
}

scenario_databases=()
created_scenario_database=''

cleanup_scenario_databases() {
  local cleanup_database
  for cleanup_database in "${scenario_databases[@]}"; do
    if ! "${pg17_bin}/dropdb" \
      --maintenance-db="$expected_database" \
      --if-exists "$cleanup_database" >/dev/null; then
      printf 'Could not remove disposable scenario database %s.\n' \
        "$cleanup_database" >&2
    fi
  done
}

create_scenario_database() {
  local scenario_kind="$1"
  created_scenario_database="stageb_${scenario_kind}_$$_${RANDOM}"
  if [[ ! "$created_scenario_database" =~ ^[a-z0-9_]+$ ]] \
     || [[ "${#created_scenario_database}" -gt 63 ]]; then
    echo 'Generated an unsafe PostgreSQL scenario database name.' >&2
    exit 65
  fi
  "${pg17_bin}/createdb" \
    --maintenance-db="$expected_database" \
    --template="$expected_database" \
    "$created_scenario_database"
  scenario_databases+=("$created_scenario_database")
  printf 'STAGE_B_SCENARIO_DATABASE_CREATED %s\n' "$created_scenario_database"
}

seed_terminal_tournament() {
  local database="$1"
  local tournament_id="$2"
  local fixture_name="$3"
  local fixture_description="$4"
  "${psql_cmd[@]}" --dbname="$database" -q \
    -v "fixture_tournament_id=$tournament_id" \
    -v "fixture_name=$fixture_name" \
    -v "fixture_description=$fixture_description" <<'SQL'
SET session_replication_role=replica;
INSERT INTO public.tournaments(
  id,name,description,game_type,buy_in_amount,buy_in_fee,start_time,status,
  max_players,created_at,updated_at,ended_at,on_break,
  break_started_at,break_ends_at
) VALUES (
  :'fixture_tournament_id'::uuid,
  :'fixture_name',
  :'fixture_description',
  'NLH',0,0,'2026-09-09 13:00:00-05','COMPLETED',9,
  '2026-09-09 12:00:00-05','2026-09-09 15:00:00-05',
  '2026-09-09 15:00:00-05',true,
  '2026-09-09 14:50:00-05','2026-09-09 15:05:00-05'
);
SET session_replication_role=origin;
SQL
}

run_terminal_residue_success() {
  local database="$1"
  local tournament_id='70000000-0000-0000-0000-000000000011'
  local guard_before

  seed_terminal_tournament \
    "$database" \
    "$tournament_id" \
    'Stage-B terminal normalization success' \
    'Disposable PG17 nonempty terminal residue fixture'
  guard_before="$(terminal_guard_fingerprint "$database")"
  if [[ "$guard_before" == 'missing' || -z "$guard_before" ]]; then
    echo 'The terminal-residue fixture is missing its original guard or trigger.' >&2
    exit 65
  fi

  run_chain_prefix 3 false "$database"

  {
    emit_terminal_guard_fingerprint_function
    cat <<'SQL'
CREATE TEMP TABLE stage_b_expected_terminal_guard(fingerprint text PRIMARY KEY);
INSERT INTO stage_b_expected_terminal_guard VALUES (:'expected_guard');
DO $verify_terminal_residue_success$
DECLARE
  v_expected_guard text;
  v_current_guard text:=pg_temp.stage_b_terminal_guard_fingerprint();
BEGIN
  SELECT fingerprint INTO STRICT v_expected_guard
    FROM pg_temp.stage_b_expected_terminal_guard;
  IF v_current_guard='missing'
     OR v_current_guard IS DISTINCT FROM v_expected_guard THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_GUARD_NOT_RESTORED_EXACTLY';
  END IF;

  IF (SELECT count(*) FROM public.tournaments
       WHERE id='70000000-0000-0000-0000-000000000011'
         AND upper(status::text)='COMPLETED'
         AND on_break=false
         AND break_started_at IS NULL
         AND break_ends_at IS NULL)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_RESIDUE_NOT_NORMALIZED';
  END IF;

  IF (SELECT count(*)
        FROM public.tournament_terminal_break_normalization_receipts
       WHERE tournament_id='70000000-0000-0000-0000-000000000011'
         AND terminal_status='COMPLETED'
         AND on_break_before
         AND break_started_at_before=
               '2026-09-09 14:50:00-05'::timestamptz
         AND break_ends_at_before=
               '2026-09-09 15:05:00-05'::timestamptz
         AND normalization_version=
               '20260910042020_stage_b_exact_precondition_repairs')<>1
     OR (SELECT count(*)
           FROM public.tournament_terminal_break_normalization_receipts)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_RESIDUE_RECEIPT_INEXACT';
  END IF;

  IF (SELECT count(*)
        FROM pg_proc p
       WHERE p.oid=
             'public.fn_guard_terminal_tournament_break_state()'::regprocedure
         AND md5(p.prosrc)='0b9721aee2fc723fed88a78761c34132'
         AND p.proowner='postgres'::regrole
         AND p.prosecdef
         AND p.provolatile='v'
         AND p.proparallel='u'
         AND NOT p.proisstrict
         AND NOT p.proleakproof
         AND p.proacl::text='{postgres=X/postgres}')<>1
     OR (SELECT count(*)
           FROM pg_trigger tg
          WHERE tg.tgrelid='public.tournaments'::regclass
            AND tg.tgname='aaa_guard_terminal_tournament_break_state'
            AND tg.tgfoid=
                  'public.fn_guard_terminal_tournament_break_state()'::regprocedure
            AND tg.tgenabled='O'
            AND tg.tgtype=23
            AND md5(pg_get_triggerdef(tg.oid,true))=
                  'bf5ea83967f7957259aa5dc894705512')<>1
     OR (SELECT count(*)
           FROM pg_constraint c
          WHERE c.conrelid='public.tournaments'::regclass
            AND c.conname='tournaments_terminal_break_state_is_clear'
            AND c.contype='c'
            AND c.convalidated
            AND NOT c.condeferrable
            AND NOT c.condeferred
            AND NOT c.connoinherit
            AND md5(pg_get_constraintdef(c.oid,true))=
                  '37b2bc74f3d9ab88967864e55202238b')<>1 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_PERMANENT_INVARIANT_INEXACT';
  END IF;
END;
$verify_terminal_residue_success$;
SELECT pg_temp.stage_b_terminal_guard_fingerprint() AS restored_guard,
       (SELECT count(*)
          FROM public.tournament_terminal_break_normalization_receipts)
         AS normalization_receipts,
       (SELECT count(*) FROM public.tournaments
         WHERE upper(status::text) IN ('COMPLETED','CANCELLED')
           AND (on_break OR break_started_at IS NOT NULL
                OR break_ends_at IS NOT NULL)) AS terminal_residue;
SQL
  } | "${psql_cmd[@]}" --dbname="$database" \
        -v "expected_guard=$guard_before"
  echo 'STAGE_B_TERMINAL_RESIDUE_SUCCESS_OK'
}

seed_noncanonical_missing_finish_claim() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
SET session_replication_role=replica;
INSERT INTO public.tournament_place_settlement_batches(
  tournament_id,mode,plan_fingerprint,place_count,amount_owed,
  escrow_required,escrow_available,source,prepared_at,settled_at
) VALUES (
  '70000000-0000-0000-0000-000000000021','structure',
  '00000000000000000000000000000000',0,0,0,0,
  'stage_b_pg17_deliberate_noncanonical_missing_claim',
  '2026-09-09 14:59:59-05','2026-09-09 15:00:00-05'
);
SET session_replication_role=origin;
SQL
}

run_late_missing_finish_claim_rollback() {
  local database="$1"
  local tournament_id='70000000-0000-0000-0000-000000000021'
  local guard_before
  local missing_claim_log=''
  local expected_error='23514: expected one exact missing atomic finish claim, found 1 total / 0 exact'

  seed_terminal_tournament \
    "$database" \
    "$tournament_id" \
    'Stage-B deliberate late rollback' \
    'Disposable PG17 dirty terminal plus noncanonical settled batch'
  seed_noncanonical_missing_finish_claim "$database"
  guard_before="$(terminal_guard_fingerprint "$database")"
  if [[ "$guard_before" == 'missing' || -z "$guard_before" ]]; then
    echo 'The late-failure fixture is missing its original guard or trigger.' >&2
    exit 65
  fi

  if missing_claim_log="$(run_chain_prefix 2 false "$database" 2>&1)"; then
    echo 'Stage-B #2 accepted an unmeasured missing finish claim.' >&2
    exit 1
  fi
  if ! grep -Fq "$expected_error" <<<"$missing_claim_log"; then
    printf '%s\n' "$missing_claim_log" >&2
    echo 'Stage-B #2 did not fail at the late missing-finish-claim classifier.' >&2
    exit 1
  fi
  printf '%s\n' "$missing_claim_log" | grep -F "$expected_error"

  {
    emit_terminal_guard_fingerprint_function
    cat <<'SQL'
CREATE TEMP TABLE stage_b_expected_terminal_guard(fingerprint text PRIMARY KEY);
INSERT INTO stage_b_expected_terminal_guard VALUES (:'expected_guard');
DO $verify_late_missing_finish_claim_rollback$
DECLARE
  v_expected_guard text;
  v_current_guard text:=pg_temp.stage_b_terminal_guard_fingerprint();
BEGIN
  SELECT fingerprint INTO STRICT v_expected_guard
    FROM pg_temp.stage_b_expected_terminal_guard;
  IF v_current_guard='missing'
     OR v_current_guard IS DISTINCT FROM v_expected_guard THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_CHANGED_TERMINAL_GUARD';
  END IF;

  IF (SELECT count(*) FROM public.tournaments
       WHERE id='70000000-0000-0000-0000-000000000021'
         AND upper(status::text)='COMPLETED'
         AND on_break
         AND break_started_at='2026-09-09 14:50:00-05'::timestamptz
         AND break_ends_at='2026-09-09 15:05:00-05'::timestamptz
         AND updated_at='2026-09-09 15:00:00-05'::timestamptz)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_CHANGED_DIRTY_TOURNAMENT';
  END IF;

  IF (SELECT count(*)
        FROM public.tournament_place_settlement_batches
       WHERE tournament_id='70000000-0000-0000-0000-000000000021'
         AND plan_fingerprint='00000000000000000000000000000000'
         AND settled_at='2026-09-09 15:00:00-05'::timestamptz)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_CHANGED_SETTLEMENT_BATCH';
  END IF;

  IF (SELECT count(*)
        FROM public.tournament_terminal_break_normalization_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_seat_exit_authority_cutover)<>0
     OR (SELECT count(*) FROM public.tournament_finish_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_pending_zero_seat_cutover_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_paid_candidate_cutover_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_positive_orphan_cutover_receipts)<>0 THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_LEAKED_REPAIR_STATE';
  END IF;
END;
$verify_late_missing_finish_claim_rollback$;
SELECT pg_temp.stage_b_terminal_guard_fingerprint() AS restored_guard,
       (SELECT count(*)
          FROM public.tournament_terminal_break_normalization_receipts)
         AS normalization_receipts,
       (SELECT count(*)
          FROM public.tournament_seat_exit_authority_cutover)
         AS authority_markers,
       (SELECT count(*) FROM public.tournament_finish_receipts)
         AS finish_receipts;
SQL
  } | "${psql_cmd[@]}" --dbname="$database" \
        -v "expected_guard=$guard_before"
  echo 'STAGE_B_LATE_MISSING_FINISH_CLAIM_ROLLBACK_OK'
}

if [[ "$probe_mode" == 'mixed' ]]; then
  run_chain_prefix 5 false
  "${psql_cmd[@]}" -q <<'SQL'
ALTER TABLE public.engine_table_leases
  ADD CONSTRAINT engine_table_leases_owner_generation_key
  UNIQUE (table_id,instance_id,lease_generation);
SQL
  mixed_fingerprint_before="$(keyshare_postimage_fingerprint)"
  if [[ "$mixed_fingerprint_before" == 'missing' ]]; then
    echo 'The #1-#5 mixed-state fixture is missing a key-share target function.' >&2
    exit 65
  fi
  mixed_log=''
  if mixed_log="$("${psql_cmd[@]}" -f "${chain_files[5]}" 2>&1)"; then
    echo 'Stage-B #6 accepted a mixed ownership-key preimage.' >&2
    exit 1
  fi
  if ! grep -Fq 'LEASE_KEYSHARE_MIXED_PREIMAGE: table key 1, tournament key 0' \
    <<<"$mixed_log"; then
    printf '%s\n' "$mixed_log" >&2
    echo 'Stage-B #6 did not fail at the mixed-preimage classifier.' >&2
    exit 1
  fi
  mixed_post="$({
    "${psql_cmd[@]}" -Atq -F '|' <<'SQL'
SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.engine_table_leases'::regclass
      AND conname='engine_table_leases_owner_generation_key'),
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.engine_tournament_leases'::regclass
      AND conname='engine_tournament_leases_owner_generation_key');
SQL
  })"
  mixed_fingerprint_after="$(keyshare_postimage_fingerprint)"
  if [[ "$mixed_post" != '1|0' \
     || "$mixed_fingerprint_after" != "$mixed_fingerprint_before" ]]; then
    echo 'Stage-B #6 mixed-state refusal left a partial schema or function write.' >&2
    exit 1
  fi
  echo 'STAGE_B_LEASE_KEYSHARE_MIXED_STATE_ROLLBACK_OK'
  exit 0
fi

if [[ "$probe_mode" == 'apply' ]]; then
  trap cleanup_scenario_databases EXIT

  create_scenario_database 'terminal_residue'
  terminal_residue_database="$created_scenario_database"
  run_terminal_residue_success "$terminal_residue_database"

  create_scenario_database 'late_finish_claim'
  late_finish_claim_database="$created_scenario_database"
  run_late_missing_finish_claim_rollback "$late_finish_claim_database"

  echo 'STAGE_B_DEFECT_REPRODUCTIONS_PG17_OK'
fi

if [[ "$probe_mode" == 'replay' ]]; then
  run_chain_prefix 6 true
  echo 'STAGE_B_LEASE_KEYSHARE_REPLAY_OK'
else
  run_chain_prefix 6 false
fi
echo 'STAGE_B_FORWARD_CHAIN_PG17_OK'
