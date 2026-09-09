#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolve_migration() {
  local suffix="$1"
  local matches=()
  local match
  while IFS= read -r match; do
    matches+=("$match")
  done < <(
    find "$repo_dir/supabase/migrations" -maxdepth 1 -type f \
      -name "*_${suffix}" -print | sort
  )
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one ${suffix} migration; found ${#matches[@]}." >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

roster_migration="$(resolve_migration hand_settlement_roster_and_replay_identity.sql)"
lease_migration="$(resolve_migration table_leases_and_hand_commits_have_generations.sql)"
zero_delta_migration="$(resolve_migration settling_nothing_needs_no_wallet_and_level_stats_stop_being_a_stub.sql)"
obligations_migration="$(resolve_migration post_commit_obligations_are_atomic_and_resumable.sql)"
exact_generation_migration="$(resolve_migration hand_settlement_targets_exact_seat_generation.sql)"
departed_time_bank_migration="$(resolve_migration a_seat_that_has_left_cannot_hold_a_time_bank.sql)"
terminal_receipt_migration="$(resolve_migration non_satellite_terminal_settlement_commits_one_stored_receipt.sql)"
strict_generation_migration="$(resolve_migration hand_settlement_requires_exact_seat_generation.sql)"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-exact-seat-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((46432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-exact-seat-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" -U postgres \
  --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-k ${socket_dir} -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -U postgres -h "$socket_dir" -p "$port" -d postgres
)

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/post-commit-obligations-pg17-bootstrap.sql" \
  >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/exact-seat-generation-pg17-bootstrap.sql" \
  >/dev/null

# Install the authoritative direct definition without running 20260908042156's
# predecessor-MD5 guard. The subsequent real zero-delta migration turns this
# into the exact live definition inspected by 20260908161534.
if ! grep -q \
  '^CREATE OR REPLACE FUNCTION public\.fn_ca_settle_hand_stacks_absolute' \
  "$roster_migration"; then
  echo 'Authoritative seven-argument stack settlement definition is missing.' >&2
  exit 1
fi
sed -n \
  '/^CREATE OR REPLACE FUNCTION public\.fn_ca_settle_hand_stacks_absolute/,/^;$/p' \
  "$roster_migration" | "${psql_cmd[@]}" >/dev/null

"${psql_cmd[@]}" -f "$zero_delta_migration" >/dev/null
"${psql_cmd[@]}" -c '
  REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
    uuid,bigint,jsonb,numeric,numeric,text,numeric
  ) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
    uuid,bigint,jsonb,numeric,numeric,text,numeric
  ) TO service_role;
' >/dev/null

# Install the rolling nine-argument wrapper whose unchanged MD5 is one of the
# target migration's postconditions. It is never invoked by this probe.
awk '
  /^CREATE OR REPLACE FUNCTION public\.fn_ca_commit_hand_settlement\(/ {
    seen += 1
    if (seen == 1) capture = 1
  }
  capture { print }
  capture && /^\$function\$;$/ { exit }
' "$lease_migration" | "${psql_cmd[@]}" >/dev/null

"${psql_cmd[@]}" -f "$obligations_migration" >/dev/null

assert_md5() {
  local signature="$1"
  local expected="$2"
  local actual
  actual="$("${psql_cmd[@]}" -Atc \
    "SELECT md5(pg_get_functiondef('${signature}'::regprocedure));")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Fixture definition drift for ${signature}: expected ${expected}, got ${actual}." >&2
    exit 1
  fi
}

assert_md5 \
  'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)' \
  '027f6ca632a9aca339efd1c896e7f6a6'
assert_md5 \
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)' \
  '2b5d9b337c653f0430910334d7e21521'
assert_md5 \
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)' \
  '42cd051b5f7014da40a80590deebd4fa'
assert_md5 \
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)' \
  'b0599ac041b35cbf7e340ad2c5ed1265'

"${psql_cmd[@]}" -f "$exact_generation_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-exact-seat-generation-pg17.sql"

# A checked-in migration should also be safe when an operator retries the exact
# file after an ambiguous response. Keep this last so behavioral proofs still
# report before an idempotence defect fails the harness.
"${psql_cmd[@]}" -f "$exact_generation_migration" >/dev/null

# Preserve the actual production chronology. This root-cause protection was
# applied after the rolling exact-seat expansion and before its strict
# contraction; the contraction must retain the departed-seat no-op while
# removing only the generation-blind fallback from it.
"${psql_cmd[@]}" -f "$departed_time_bank_migration" >/dev/null
assert_md5 \
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)' \
  'f3351779acce66a8d6c5350a8e8f2a6b'

# Preserve the actual live chronology. The later atomic terminal-receipt
# migration replaced both hand-settlement bodies from an older source snapshot,
# accidentally removing the rolling exact-seat expansion and its departed-seat
# time-bank safeguard. Install those two complete receipt-aware definitions in
# isolation so the strict cutover is rehearsed against the exact production
# preimage without pulling the unrelated 10k-line terminal surface into this
# focused fixture.
extract_function() {
  local function_name="$1"
  awk -v function_name="$function_name" '
    !capture && index($0, "CREATE OR REPLACE FUNCTION public." function_name "(") == 1 {
      capture = 1
    }
    capture { print }
    capture && /^\$function\$;$/ { exit }
    capture && /^END \$function\$$/ { split_end = 1; next }
    capture && split_end && /^;$/ { exit }
  ' "$terminal_receipt_migration"
}

extract_function fn_ca_settle_hand_stacks_absolute | "${psql_cmd[@]}" >/dev/null
extract_function fn_ca_commit_hand_settlement | "${psql_cmd[@]}" >/dev/null
"${psql_cmd[@]}" -c '
  REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
    uuid,bigint,jsonb,numeric,numeric,text,numeric
  ) FROM PUBLIC, anon, authenticated, service_role;
' >/dev/null

assert_md5 \
  'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)' \
  '2e322bc7dfee3cf5cb6548ed3a587095'
assert_md5 \
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)' \
  '8ddb91f5f7bb5f27b609ec83cb69fa66'

# Model the preceding Stage-B authority contraction without copying its large,
# independently probed tournament surface into this focused fixture. The strict
# exact-seat migration itself verifies that both rolling hand doors are absent.
"${psql_cmd[@]}" -c '
  DROP FUNCTION public.fn_ca_commit_hand_settlement(
    uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb
  );
  DROP FUNCTION public.fn_ca_commit_hand_settlement(
    uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid
  );
' >/dev/null

"${psql_cmd[@]}" -f "$strict_generation_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-exact-seat-generation-strict-pg17.sql"
"${psql_cmd[@]}" -f "$strict_generation_migration" >/dev/null

echo 'PostgreSQL 17 exact seat-generation expansion and strict contraction replay passed.'
