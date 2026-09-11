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
shape_migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  all_in_equity_coverage_is_witnessed_at_runout)"
index_script="$repo_dir/scripts/ops/build-stats-equity-witness-index-concurrently.sql"
cutover_script="$repo_dir/scripts/ops/set-stats-equity-witness-fleet-cutover.sql"
index_gate_migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  stats_equity_witness_covering_index_is_ready)"
audit_migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  stats_witness_audit_uses_durable_runout_evidence)"
old_audit_migration="$repo_dir/supabase/migrations/20260908204006_stats_witness_checks_showdown_without_money_reconstruction.sql"
old_health_migration="$repo_dir/supabase/migrations/20260904222705_stats_phase_3_pulse_timezone_and_ev_coverage.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17[.]'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "/tmp/ca-equity-witness-pg17.XXXXXX")"
cluster_dir="$probe_root/cluster"
socket_dir="$probe_root/socket"
postgres_log="$probe_root/postgres.log"
old_function="$probe_root/old-audit-function.sql"
old_health_function="$probe_root/old-health-function.sql"
mkdir -p "$socket_dir"
port="$((49432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-equity-witness-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale \
  --username=postgres >/dev/null
if ! "${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "$postgres_log" \
  -o "-k ${socket_dir} -p ${port}" -w start >/dev/null; then
  sed -n '1,240p' "$postgres_log" >&2
  exit 1
fi

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -U postgres -d postgres
)

"${psql_cmd[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  button_seat integer,
  players jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  showdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_human boolean NOT NULL DEFAULT false
);
CREATE TABLE public.ca_hand_player_stat (hand_id uuid NOT NULL);
CREATE TABLE public.ca_hand_player_idx (hand_id uuid NOT NULL, user_id uuid NOT NULL);
CREATE TABLE public.ca_hand_facts (
  hand_id uuid NOT NULL,
  user_id uuid NOT NULL,
  played_at timestamptz NOT NULL,
  was_all_in boolean NOT NULL DEFAULT false,
  went_to_showdown boolean NOT NULL DEFAULT false,
  all_in_street text,
  all_in_equity numeric,
  PRIMARY KEY (hand_id, user_id)
);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  is_horse boolean NOT NULL DEFAULT false
);
CREATE TABLE public.ca_hand_player_idx_state (
  id boolean PRIMARY KEY,
  idx_ceil timestamptz NOT NULL,
  backfill_complete boolean NOT NULL DEFAULT false,
  rows_indexed bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_hand_player_stat_repair_state (
  id boolean PRIMARY KEY,
  done boolean NOT NULL,
  cursor_at timestamptz,
  ceiling_at timestamptz,
  hands_seen bigint NOT NULL DEFAULT 0,
  rows_changed bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_idx_every_seat_state (
  id boolean PRIMARY KEY,
  done boolean NOT NULL DEFAULT false,
  cursor_at timestamptz,
  rows_added bigint NOT NULL DEFAULT 0
);
CREATE TABLE public.ca_stats_witness_audit_log (
  id bigserial PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  hands integer NOT NULL,
  player_hands integer NOT NULL,
  hands_with_posts integer NOT NULL,
  button_disagree integer NOT NULL,
  showdown_disagree integer NOT NULL,
  hands_without_stat integer NOT NULL,
  player_hands_without_idx integer NOT NULL DEFAULT 0,
  human_player_hands integer NOT NULL,
  human_without_facts integer NOT NULL,
  allin_showdown_7d integer NOT NULL DEFAULT 0,
  allin_showdown_without_equity_7d integer NOT NULL DEFAULT 0,
  idx_lag_seconds numeric,
  repair_done boolean,
  duration_ms integer NOT NULL
);
INSERT INTO public.ca_hand_player_idx_state (id, idx_ceil) VALUES (true, now());
INSERT INTO public.ca_hand_player_stat_repair_state (id, done) VALUES (true, true);
INSERT INTO public.ca_idx_every_seat_state (id, done) VALUES (true, true);
SQL

# Install the exact checked-in production predecessor, not a hand-written
# facsimile. Its canonical PG17 hash must equal the live preimage accepted by
# the cutover migration.
awk '
  /^CREATE OR REPLACE FUNCTION public[.]ca_stats_witness_audit[(]/ { copy = 1 }
  copy { print }
  copy && /^\$function\$;$/ { exit }
' "$old_audit_migration" > "$old_function"
"${psql_cmd[@]}" -f "$old_function" >/dev/null

awk '
  /^CREATE OR REPLACE FUNCTION public[.]ca_stats_health[(][)]/ { copy = 1 }
  copy { print }
  copy && /^\$function\$;$/ { exit }
' "$old_health_migration" > "$old_health_function"
"${psql_cmd[@]}" -f "$old_health_function" >/dev/null

old_hash="$("${psql_cmd[@]}" -qAtc \
  "SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure));")"
if [[ "$old_hash" != '3b3b9610697ea648ee94808ff7ca91b7' ]]; then
  echo "The checked-in predecessor does not match the live PG17 preimage: ${old_hash}." >&2
  exit 1
fi
old_health_hash="$("${psql_cmd[@]}" -qAtc \
  "SELECT md5(pg_get_functiondef('public.ca_stats_health()'::regprocedure));")"
if [[ "$old_health_hash" != 'd04a19c66ebd132a89fa305cc8b5ed52' ]]; then
  echo "The checked-in health predecessor is not its exact PG17 preimage: ${old_health_hash}." >&2
  exit 1
fi

# Exercise the real operational boundaries: transactional shape, nonblocking
# concurrent index, then exact audit source cutover after the index is ready.
"${psql_cmd[@]}" -f "$shape_migration" >/dev/null
"${psql_cmd[@]}" -f "$index_script" >/dev/null
"${psql_cmd[@]}" -f "$index_gate_migration" >/dev/null
"${psql_cmd[@]}" -f "$audit_migration" >/dev/null

new_hash="$("${psql_cmd[@]}" -qAtc \
  "SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure));")"
if [[ "$new_hash" != '59205e735fe109b70a23381ca3dac3d5' ]]; then
  echo "The durable-fact audit does not match its exact PG17 postimage: ${new_hash}." >&2
  exit 1
fi
new_health_hash="$("${psql_cmd[@]}" -qAtc \
  "SELECT md5(pg_get_functiondef('public.ca_stats_health()'::regprocedure));")"
if [[ "$new_health_hash" != 'f1c929eb7f4ca6f74642b47ff79ee9ac' ]]; then
  echo "The readiness-aware health RPC does not match its exact PG17 postimage: ${new_health_hash}." >&2
  exit 1
fi

"${psql_cmd[@]}" >/dev/null <<'SQL'
INSERT INTO public.ca_hand_facts (
  hand_id, user_id, played_at, was_all_in, went_to_showdown,
  all_in_street, all_in_equity, all_in_equity_owed
) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', now(), true, true, 'turn', NULL, true),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', now(), true, true, 'flop', 0.5, true),
  ('10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', now(), false, false, NULL, NULL, false);
SQL

unconfigured_counts="$("${psql_cmd[@]}" -qAtc "
  SELECT (result->>'allin_showdown_7d') || ':'
      || (result->>'allin_showdown_without_equity_7d')
  FROM (SELECT public.ca_stats_witness_audit(10, 90) AS result) q;
")"
if [[ "$unconfigured_counts" != '0:0' ]]; then
  echo "The audit trusted witness rows before the fleet boundary was configured: ${unconfigured_counts}." >&2
  exit 1
fi

unconfigured_readiness="$("${psql_cmd[@]}" -qAtc "
  SELECT (r->>'configured') || ':' || (r->>'windowLabel') || ':' || (r->>'windowReady')
  FROM (SELECT public.ca_stats_equity_witness_readiness() r) s;
")"
if [[ "$unconfigured_readiness" != 'false:not_configured:false' ]]; then
  echo "An unstamped fleet boundary was not labelled fail-closed: ${unconfigured_readiness}." >&2
  exit 1
fi
unconfigured_health="$("${psql_cmd[@]}" -qAtc "
  SELECT coalesce(h->>'evCoverage7d', 'NULL') || ':'
      || (h->'equityWitnessReadiness'->>'configured')
  FROM (SELECT public.ca_stats_health() h) s;
")"
if [[ "$unconfigured_health" != 'NULL:false' ]]; then
  echo "ca_stats_health exposed partial counts as evCoverage7d before the stamp: ${unconfigured_health}." >&2
  exit 1
fi

# A current boundary is collecting even though TRUE facts already exist. Keep
# this probe rolled back so the durable receipt can later exercise an aged
# boundary and the post-stamp-audit fence in the same database.
collecting_readiness="$("${psql_cmd[@]}" -qAtc "
  BEGIN;
  INSERT INTO public.ca_stats_equity_witness_cutover (
    id, writer_cutover_at, writer_sha
  ) VALUES (
    true, statement_timestamp(), '0123456789abcdef0123456789abcdef01234567'
  );
  SELECT (r->>'configured') || ':' || (r->>'windowLabel') || ':' || (r->>'windowReady')
  FROM (SELECT public.ca_stats_equity_witness_readiness() r) s;
  ROLLBACK;
")"
if [[ "$collecting_readiness" != 'true:collecting:false' ]]; then
  echo "A partial durable witness window was not labelled collecting: ${collecting_readiness}." >&2
  exit 1
fi

writer_sha='0123456789abcdef0123456789abcdef01234567'
cutover_at="$("${psql_cmd[@]}" -qAtc \
  "SELECT to_char(clock_timestamp() - interval '8 days', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")"
"${psql_cmd[@]}" -v writer_sha="$writer_sha" -v cutover_at="$cutover_at" \
  -f "$cutover_script" >/dev/null

# Exact replay is harmless; a different SHA is an idempotency conflict.
"${psql_cmd[@]}" -v writer_sha="$writer_sha" -v cutover_at="$cutover_at" \
  -f "$cutover_script" >/dev/null
if "${psql_cmd[@]}" \
  -v writer_sha='ffffffffffffffffffffffffffffffffffffffff' \
  -v cutover_at="$cutover_at" -f "$cutover_script" \
  >"$probe_root/cutover-conflict.log" 2>&1; then
  echo 'A conflicting fleet SHA rewrote the immutable cutover receipt.' >&2
  exit 1
fi
if ! grep -Fq 'ALL_IN_EQUITY_WITNESS_CUTOVER_CONFLICT' "$probe_root/cutover-conflict.log"; then
  echo 'The conflicting cutover receipt failed for an unexpected reason.' >&2
  sed -n '1,120p' "$probe_root/cutover-conflict.log" >&2
  exit 1
fi

if "${psql_cmd[@]}" -c \
  "UPDATE public.ca_stats_equity_witness_cutover SET writer_sha = '$writer_sha';" \
  >"$probe_root/cutover-update.log" 2>&1; then
  echo 'The fleet cutover receipt was mutable after it was stamped.' >&2
  exit 1
fi
if ! grep -Fq 'CA_STATS_EQUITY_WITNESS_CUTOVER_IMMUTABLE' "$probe_root/cutover-update.log"; then
  echo 'The immutable cutover update failed for an unexpected reason.' >&2
  sed -n '1,120p' "$probe_root/cutover-update.log" >&2
  exit 1
fi

# The boundary is eight days old, but the last audit ran before the operator
# stamped it and therefore counted zero. It must remain unready until a later
# audit proves that its counts observed the immutable receipt.
pre_audit_ready="$("${psql_cmd[@]}" -qAtc \
  "SELECT public.ca_stats_equity_witness_readiness()->>'windowReady';")"
if [[ "$pre_audit_ready" != 'false' ]]; then
  echo "A pre-stamp audit falsely satisfied the full-window boundary: ${pre_audit_ready}." >&2
  exit 1
fi

audit_counts="$("${psql_cmd[@]}" -qAtc "
  SELECT (result->>'allin_showdown_7d') || ':'
      || (result->>'allin_showdown_without_equity_7d')
  FROM (SELECT public.ca_stats_witness_audit(10, 90) AS result) q;
")"
if [[ "$audit_counts" != '2:1' ]]; then
  echo "The stamped audit did not count exact durable obligations: ${audit_counts}." >&2
  exit 1
fi

ready="$("${psql_cmd[@]}" -qAtc "
  SELECT (r->>'configured') || ':' || (r->>'windowLabel') || ':' || (r->>'windowReady')
  FROM (SELECT public.ca_stats_equity_witness_readiness() r) s;
")"
if [[ "$ready" != 'true:7d:true' ]]; then
  echo "An aged boundary with a post-stamp audit was not ready: ${ready}." >&2
  exit 1
fi

health="$("${psql_cmd[@]}" -qAtc "
  SELECT (h->'equityWitnessReadiness'->>'windowReady') || ':'
      || (h->'equityWitnessReadiness'->>'windowLabel') || ':'
      || (h->'evCoverage7d'->>'allInShowdowns') || ':'
      || (h->'evCoverage7d'->>'withoutEquity')
  FROM (SELECT public.ca_stats_health() h) s;
")"
if [[ "$health" != 'true:7d:2:1' ]]; then
  echo "ca_stats_health did not carry one coherent readiness/count snapshot: ${health}." >&2
  exit 1
fi

acl="$("${psql_cmd[@]}" -qAtc "
  SELECT has_table_privilege('anon', 'public.ca_stats_equity_witness_cutover', 'SELECT')::int
      || ':' || has_table_privilege('authenticated', 'public.ca_stats_equity_witness_cutover', 'SELECT')::int
      || ':' || has_table_privilege('service_role', 'public.ca_stats_equity_witness_cutover', 'SELECT')::int
      || ':' || c.relrowsecurity::int
  FROM pg_class c
  WHERE c.oid = 'public.ca_stats_equity_witness_cutover'::regclass;
")"
if [[ "$acl" != '0:0:0:1' ]]; then
  echo "The cutover receipt is readable directly or lacks RLS: ${acl}." >&2
  exit 1
fi

plan="$("${psql_cmd[@]}" -qAtc "
  SET enable_seqscan=off;
  EXPLAIN (COSTS OFF)
  SELECT count(*), count(*) FILTER (WHERE all_in_equity IS NULL)
  FROM public.ca_hand_facts f
  JOIN public.ca_stats_equity_witness_cutover c ON c.id
  WHERE f.all_in_equity_owed IS TRUE
    AND f.played_at >= greatest(now() - interval '7 days', c.writer_cutover_at);
")"
if ! grep -Fq 'idx_ca_hand_facts_equity_owed_played_at' <<<"$plan"; then
  echo 'The durable witness count did not use its played-at-leading partial index.' >&2
  printf '%s\n' "$plan" >&2
  exit 1
fi

if "${psql_cmd[@]}" -c "
  INSERT INTO public.ca_hand_facts (
    hand_id,user_id,played_at,was_all_in,went_to_showdown,
    all_in_street,all_in_equity_owed
  ) VALUES (
    '10000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000004',
    now(),true,true,'river',true
  );
" >"$probe_root/invalid.log" 2>&1; then
  echo 'A river-only row was allowed to claim cards-to-come equity was owed.' >&2
  exit 1
fi
if ! grep -Fq 'ca_hand_facts_equity_owed_shape' "$probe_root/invalid.log"; then
  echo 'The invalid obligation failed for an unexpected reason.' >&2
  sed -n '1,120p' "$probe_root/invalid.log" >&2
  exit 1
fi

# Reproduce PostgreSQL's failed-CONCURRENTLY debris: a duplicate-key unique
# build leaves an invalid same-name index. The operator path must remove it
# concurrently and install the canonical valid definition in one replay.
"${psql_cmd[@]}" -c 'DROP INDEX public.idx_ca_hand_facts_equity_owed_played_at;' >/dev/null
if "${psql_cmd[@]}" -c \
  'CREATE UNIQUE INDEX CONCURRENTLY idx_ca_hand_facts_equity_owed_played_at ON public.ca_hand_facts ((1));' \
  >"$probe_root/failed-index.log" 2>&1; then
  echo 'The fixture meant to leave a failed concurrent index unexpectedly succeeded.' >&2
  exit 1
fi
invalid_index="$("${psql_cmd[@]}" -qAtc "
  SELECT (NOT i.indisvalid)::int || ':' || (NOT i.indisready)::int
  FROM pg_index i
  WHERE i.indexrelid = 'public.idx_ca_hand_facts_equity_owed_played_at'::regclass;
")"
if [[ "$invalid_index" != '1:1' ]]; then
  echo "The failed concurrent build did not leave the expected invalid index: ${invalid_index}." >&2
  exit 1
fi
"${psql_cmd[@]}" -f "$index_script" >/dev/null
rebuilt_index="$("${psql_cmd[@]}" -qAtc "
  SELECT i.indisvalid::int || ':' || i.indisready::int || ':'
      || (i.indnkeyatts = 1 AND i.indnatts = 2)::int || ':'
      || (pg_get_expr(i.indpred, i.indrelid, false) =
          '(all_in_equity_owed IS TRUE)')::int
  FROM pg_index i
  WHERE i.indexrelid = 'public.idx_ca_hand_facts_equity_owed_played_at'::regclass;
")"
if [[ "$rebuilt_index" != '1:1:1:1' ]]; then
  echo "invalid concurrent index was not rebuilt: ${rebuilt_index}." >&2
  exit 1
fi

# A valid index can still be unusable for the audit when its predicate narrows
# the owed population. Treat that as drift too; substring checks alone would
# accept it because all three canonical fragments remain present.
"${psql_cmd[@]}" -c 'DROP INDEX public.idx_ca_hand_facts_equity_owed_played_at;' >/dev/null
"${psql_cmd[@]}" -c "
  CREATE INDEX idx_ca_hand_facts_equity_owed_played_at
    ON public.ca_hand_facts (played_at)
    INCLUDE (all_in_equity)
    WHERE all_in_equity_owed IS TRUE
      AND played_at >= '2100-01-01 00:00:00+00'::timestamptz;
" >/dev/null
"${psql_cmd[@]}" -f "$index_script" >/dev/null
repaired_predicate="$("${psql_cmd[@]}" -qAtc "
  SELECT pg_get_expr(i.indpred, i.indrelid, false)
  FROM pg_index i
  WHERE i.indexrelid = 'public.idx_ca_hand_facts_equity_owed_played_at'::regclass;
")"
if [[ "$repaired_predicate" != '(all_in_equity_owed IS TRUE)' ]]; then
  echo "A valid same-name index with a narrowed predicate was not rebuilt: ${repaired_predicate}." >&2
  exit 1
fi

# A same-name index on another table is unrelated state. The repair path must
# fail closed and preserve it rather than broadening its destructive target.
"${psql_cmd[@]}" -c 'DROP INDEX public.idx_ca_hand_facts_equity_owed_played_at;' >/dev/null
"${psql_cmd[@]}" -c \
  'CREATE TABLE public.equity_witness_unrelated (id integer); CREATE INDEX idx_ca_hand_facts_equity_owed_played_at ON public.equity_witness_unrelated (id);' \
  >/dev/null
if "${psql_cmd[@]}" -f "$index_script" >"$probe_root/name-occupied.log" 2>&1; then
  echo 'The concurrent repair accepted a same-name index on an unrelated table.' >&2
  exit 1
fi
if ! grep -Fq 'ALL_IN_EQUITY_WITNESS_INDEX_NAME_OCCUPIED' "$probe_root/name-occupied.log"; then
  echo 'The unrelated same-name index failed for an unexpected reason.' >&2
  sed -n '1,120p' "$probe_root/name-occupied.log" >&2
  exit 1
fi
preserved_unrelated="$("${psql_cmd[@]}" -qAtc "
  SELECT (i.indrelid = 'public.equity_witness_unrelated'::regclass)::int
  FROM pg_index i
  WHERE i.indexrelid = 'public.idx_ca_hand_facts_equity_owed_played_at'::regclass;
")"
if [[ "$preserved_unrelated" != '1' ]]; then
  echo 'The unrelated same-name index was destroyed by the repair path.' >&2
  exit 1
fi
"${psql_cmd[@]}" -c \
  'DROP INDEX public.idx_ca_hand_facts_equity_owed_played_at; DROP TABLE public.equity_witness_unrelated;' \
  >/dev/null

# Prove an ordinary fresh/local migration chain can build a missing index and
# transactionally replace a drifted same-name index because the fixture is
# below the 128 MiB production threshold.
"${psql_cmd[@]}" -c \
  "CREATE INDEX idx_ca_hand_facts_equity_owed_played_at
     ON public.ca_hand_facts (played_at)
     INCLUDE (all_in_equity)
     WHERE all_in_equity_owed IS TRUE
       AND played_at >= '2100-01-01 00:00:00+00'::timestamptz;" \
  >/dev/null
"${psql_cmd[@]}" -f "$index_gate_migration" >/dev/null
small_gate_index="$("${psql_cmd[@]}" -qAtc "
  SELECT (i.indnkeyatts = 1 AND i.indnatts = 2)::int || ':'
      || (pg_get_expr(i.indpred, i.indrelid, false) =
          '(all_in_equity_owed IS TRUE)')::int
  FROM pg_index i
  WHERE i.indexrelid = 'public.idx_ca_hand_facts_equity_owed_played_at'::regclass;
")"
if [[ "$small_gate_index" != '1:1' ]]; then
  echo "The small-table migration gate did not replace its drifted index: ${small_gate_index}." >&2
  exit 1
fi

# Every stage is replay-safe and the audit accepts only its exact postimage.
"${psql_cmd[@]}" -f "$shape_migration" >/dev/null
"${psql_cmd[@]}" -f "$index_script" >/dev/null
"${psql_cmd[@]}" -f "$index_gate_migration" >/dev/null
"${psql_cmd[@]}" -f "$audit_migration" >/dev/null
replay_hash="$("${psql_cmd[@]}" -qAtc \
  "SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure));")"
if [[ "$replay_hash" != "$new_hash" ]]; then
  echo 'A clean three-stage replay changed the installed audit source.' >&2
  exit 1
fi
replay_health_hash="$("${psql_cmd[@]}" -qAtc \
  "SELECT md5(pg_get_functiondef('public.ca_stats_health()'::regprocedure));")"
if [[ "$replay_health_hash" != "$new_health_hash" ]]; then
  echo 'A clean three-stage replay changed the installed health source.' >&2
  exit 1
fi

echo 'PASS: PG17 durable equity witness shape, failed concurrent-index recovery, fresh index gate, exact audit/health cutover, immutable fleet boundary, readiness, constraint, plan, and replay.'
