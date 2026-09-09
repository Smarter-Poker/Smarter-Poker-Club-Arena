#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
predecessor_rel="supabase/migrations/20260909062006_chips_are_two_decimals_on_the_addon_path.sql"
predecessor="${repo_dir}/${predecessor_rel}"
processor="${repo_dir}/supabase/migrations/20260908175113_post_commit_addons_accept_proven_resolution_receipts.sql"
forward="${repo_dir}/supabase/migrations/20260909072626_addon_money_is_finite_and_historical_receipts_balance_to_cents.sql"
bootstrap="${repo_dir}/scripts/dev/fixtures/addon-finite-cent-forward-pg17-bootstrap.sql"
probe="${repo_dir}/scripts/dev/probe-addon-finite-cent-forward-pg17.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | rg -q ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

for required in "$processor" "$forward" "$bootstrap" "$probe"; do
  if [[ ! -f "$required" ]]; then
    echo "Required probe input is missing: $required" >&2
    exit 1
  fi
done

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-addon-cent-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((37432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-addon-cent-pg17."* ]]; then
    find "$probe_root" -depth -delete
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-h '' -k '${socket_dir}' -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -d postgres
)

"${pg17_bin}/postgres" --version
"${psql_cmd[@]}" -f "$bootstrap" >/dev/null

if [[ -f "$predecessor" ]]; then
  "${psql_cmd[@]}" -f "$predecessor" >/dev/null
else
  # This fallback exists only for a review worktree that has not merged the
  # predecessor's origin/main commit yet. Normal CI always reads the file.
  git -C "$repo_dir" show "origin/main:${predecessor_rel}" | "${psql_cmd[@]}" >/dev/null
fi

awk '
  /^CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations\(/ {
    capture = 1
  }
  capture { print }
  capture && /^  TO service_role;$/ { exit }
' "$processor" | "${psql_cmd[@]}" >/dev/null

"${psql_cmd[@]}" -f "$forward" >/dev/null
"${psql_cmd[@]}" -f "$probe"
