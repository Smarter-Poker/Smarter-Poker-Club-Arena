#!/usr/bin/env bash
# Rebuy, re-entry and add-on money on every bounty format and on satellites.
#
# Runs the byte-exact production body of
# fn_ca_process_tournament_chip_purchase_money_v1 (captured in
# fixtures/rebuy-format-money/installed.sql) against freezeout, bounty,
# progressive_bounty, mystery_bounty and satellite events, for each of rebuy,
# re-entry and add-on, and proves conservation, the bounty head, the stack and
# the fee booking per combination. Prints REBUY_FORMAT_MONEY_PG17_OK.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bootstrap="${repo_dir}/scripts/dev/fixtures/rebuy-format-money/bootstrap.sql"
installed="${repo_dir}/scripts/dev/fixtures/rebuy-format-money/installed.sql"
probe="${repo_dir}/scripts/dev/probe-rebuy-format-money-pg17.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" && -x /usr/lib/postgresql/17/bin/initdb ]]; then
  pg17_bin=/usr/lib/postgresql/17/bin
fi
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | grep -q ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

for required in "$bootstrap" "$installed" "$probe"; do
  if [[ ! -f "$required" ]]; then
    echo "Required probe input is missing: $required" >&2
    exit 1
  fi
done

# A short socket directory: a Unix socket path is limited to ~100 bytes.
probe_root="$(mktemp -d /tmp/ca-rebuy-format.XXXXXX)"
cluster_dir="${probe_root}/cluster"
port="$((38432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  case "$probe_root" in
    /tmp/ca-rebuy-format.*) find "$probe_root" -depth -delete ;;
  esac
}
trap cleanup EXIT

# The postmaster refuses to start multithreaded without a valid locale.
export LC_ALL=C LANG=C
"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "${probe_root}/postgres.log" \
  -o "-h '' -k '${probe_root}' -p ${port}" -w start >/dev/null

"${pg17_bin}/psql" -X -q -v ON_ERROR_STOP=1 -h "$probe_root" -p "$port" -d postgres \
  -f "$bootstrap" -f "$installed" -f "$probe"
