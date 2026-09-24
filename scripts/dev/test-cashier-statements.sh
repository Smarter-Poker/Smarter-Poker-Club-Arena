#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/cstmt.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55571 -h ''" start >/dev/null
started=1
# The migration is applied twice: every object it creates must be re-runnable.
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55571 -d postgres \
  -f "$root/tests/fixtures/cashier-statements/bootstrap.sql" \
  -f "$root/tests/fixtures/cashier-statements/baseline.sql" \
  -f "$root/supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql" \
  -f "$root/supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql" \
  -f "$root/tests/fixtures/cashier-statements/regression.sql"

# Plan proof, parsed from auto_explain NOTICEs (tests/fixtures/cashier-statements/plan.sql).
plan_out="$fixture/plan.out"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55571 -d postgres \
  -f "$root/tests/fixtures/cashier-statements/plan.sql" >"$plan_out" 2>&1
plan_fail() {
  echo "FAIL: $1"
  cat "$plan_out" >&2
  exit 1
}
# The plans between 'MARK <name>' and the next MARK.
scenario() {
  awk -v m="MARK $1" 'index($0, m) { on = 1; next } on && /MARK / { exit } on' "$plan_out"
}
# "<good> <total>": scans whose node matches $2 and whose nearest ancestor
# other than Result / Sort / Incremental Sort / a join is a Limit.
limit_over_scan() {
  scenario "$1" | awk -v target="$2" '
    /^[ ]*->  / || /^[A-Z][A-Za-z ]*  \(cost=/ {
      match($0, /^[ ]*/); ind = RLENGTH
      name = $0; sub(/^[ ]*(->)?[ ]*/, "", name); sub(/  \(cost=.*/, "", name)
      while (n > 0 && sind[n] >= ind) n--
      if (name ~ target) {
        total++
        for (i = n; i > 0; i--) {
          if (snam[i] ~ /^Limit/) { good++; break }
          if (snam[i] ~ /^(Result|Sort|Incremental Sort|Nested Loop( Left| Anti)? Join|Hash (Left|Anti) Join)$/) continue
          break
        }
      }
      n++; sind[n] = ind; snam[n] = name
    }
    END { printf "%d %d\n", good, total }'
}
shape_check() { # scenario, branches per source, index access pattern
  local r m plans
  plans=$(scenario "$1")
  r=$(limit_over_scan "$1" "^($3) on chip_transactions ct(_[0-9]+)?$")
  m=$(limit_over_scan "$1" "^($3) on chip_ledger cl(_[0-9]+)?$")
  if [ "$r" = "$2 $2" ] && [ "$m" = "$2 $2" ] && ! grep -q 'Seq Scan on chip_transactions' <<<"$plans"; then
    echo "PASS: plan ($1): each of $2 receipt and $2 movement branches is a Limit over its index scan; no Seq Scan on chip_transactions"
  else
    plan_fail "plan ($1): receipts $r, movements $m (want $2 $2), or a Seq Scan on chip_transactions"
  fi
}
index_scan='Index Scan( Backward)? using [a-z_]+'
shape_check all-first 1 "$index_scan"
shape_check all-cursor 1 "$index_scan"
shape_check self 2 "$index_scan"
# = ANY(downline) returns rows out of index order, so a downline branch sorts
# its index rows under the Limit; on the fixture's small ledger the planner
# may fetch them through a bitmap over the same (club_id, entity, created_at)
# index. Either way the rows come from that index, never a Seq Scan.
shape_check downline 2 "$index_scan|Bitmap Heap Scan"
all_plans=$(scenario all-first)
grep -qF "(category <> 'refund'::text) OR (to_type <> 'player_wallet'::text) OR (NOT EXISTS(SubPlan" <<<"$all_plans" \
  && grep -q 'Index Scan using chip_transactions_club_to_created_idx on chip_transactions restored ' <<<"$all_plans" \
  && echo "PASS: plan (all-first): the restore mirror probe runs only for refunds to a player_wallet, on the player wallet (club_id, to_user_id, created_at) index" \
  || plan_fail "plan (all-first): restore mirror probe shape"
self_plans=$(scenario self)
grep -q 'using chip_transactions_club_from_created_idx on chip_transactions ct ' <<<"$self_plans" \
  && grep -q 'using chip_transactions_club_to_created_idx on chip_transactions ct_1 ' <<<"$self_plans" \
  && echo "PASS: plan (self): the from-side and to-side receipt branches use their (club_id, user, created_at) indexes" \
  || plan_fail "plan (self): side indexes"
cursor_plan=$(scenario all-cursor)
plan_check() {
  local context
  context=$(grep -A1 -E -- "$1" <<<"$cursor_plan" || true)
  if grep -qF -- "$2" <<<"$context"; then
    echo "PASS: $3"
  else
    plan_fail "$3"
  fi
}
plan_check 'Scan( Backward)? using [a-z_]+ on chip_transactions ct ' \
  "(created_at <= '2026-09-05 15:00:00+00'" \
  'plan: a cursor page bounds the receipt index scan by the cursor instant'
plan_check 'Scan( Backward)? using [a-z_]+ on chip_ledger cl ' \
  "(created_at <= '2026-09-05 15:00:00+00'" \
  'plan: a cursor page bounds the movement index scan by the cursor instant'
plan_check 'Scan( Backward)? using [a-z_]+ on chip_transactions terminal ' \
  "(created_at <= ('2026-09-30 00:00:00+00'::timestamp with time zone + '1 day'::interval))" \
  'plan: the escrow terminal lookup is an index range ending at p_to + 1 day'
plan_check 'Scan using ux_chip_transactions_idempotency_key on chip_transactions represented' \
  "represented" \
  'plan: the idempotency anti-join uses the partial unique index'
