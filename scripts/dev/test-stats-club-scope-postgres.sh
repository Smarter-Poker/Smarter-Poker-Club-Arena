#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${STATS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"
migration="$repo/supabase/migrations/20261003132118_stats_preserve_authorized_club_scope.sql"
fixture="$repo/tests/fixtures/stats-club-scope"

[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" ]] || {
  echo 'PostgreSQL 17 tools unavailable; set PG17_BINDIR.' >&2; exit 2;
}
[[ -d "$scratch_parent" ]] || { echo "Stats PostgreSQL scratch parent is unavailable: $scratch_parent" >&2; exit 2; }
"$pgbin/postgres" --version | grep -Eq ' 17\.' || {
  echo 'PostgreSQL 17 is required.' >&2; exit 2;
}

work="$(mktemp -d "$scratch_parent/sc.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((56000 + ($$ % 7000)))"
mkdir -p "$socket"
cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  [[ "$work" == "$scratch_parent"/sc.* ]] && find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U fixture_admin -d postgres)
"${psql[@]}" -f "$fixture/bootstrap.sql" -f "$migration" -f "$fixture/assertions.sql"
"${psql[@]}" -f "$fixture/funded-bootstrap.sql"
# Use the actual maintained resolver dependency, not a mock attribution rule.
python3 - "$repo" "$work/funded-resolver.sql" <<'PY'
from pathlib import Path
import sys
source=(Path(sys.argv[1])/'supabase/migrations/20261018135655_member_records_follow_funded_hand_clubs_and_live_source_chan.sql').read_text()
start=source.index('CREATE FUNCTION public.fn_member_record_fact_club(')
end=source.index('CREATE FUNCTION public.fn_member_record_daily_insert()',start)
Path(sys.argv[2]).write_text(source[start:end])
PY
"${psql[@]}" -f "$work/funded-resolver.sql" -f "$fixture/funded-before.sql" \
 -f "$repo/supabase/migrations/20261018163053_player_stats_follow_the_funded_club.sql" \
 -f "$fixture/funded-after.sql"
# Qualify the recorded-opportunity reader on the actual funded-club predecessor.
"${psql[@]}" -f "$fixture/recorded-opportunities-before.sql" \
 -f "$repo/supabase/migrations/20261027173840_player_stat_rates_use_recorded_opportunities.sql" \
 -f "$fixture/recorded-opportunities-after.sql"
"${psql[@]}" -f "$fixture/cohort-bootstrap.sql" \
 -f "$repo/supabase/migrations/20261027174948_stat_comparisons_use_exact_asset_scoped_cohorts.sql" \
 -f "$fixture/cohort-assertions.sql"
python3 - "$repo/server/src/engine/presentation/publicHandStats.bookkeeping-fixture.json" "$work/recorded-bookkeeping.sql" <<'PY'
import json,sys
from pathlib import Path
checks=[]
for case in json.loads(Path(sys.argv[1]).read_text()):
 actions=json.dumps(case['actions'],separators=(',',':')).replace("'","''")
 checks.append("DO $$ BEGIN IF public.ca_fact_aggression_counts('"+actions+"'::jsonb,'"+case['hero']+"',"+str(case['bigBlind'])+") IS DISTINCT FROM jsonb_build_object('bets_raises',"+str(case['aggressive'])+",'calls',"+str(case['calls'])+") THEN RAISE EXCEPTION 'Recorded public bookkeeping regression'; END IF; END $$;")
Path(sys.argv[2]).write_text('\n'.join(checks)+'\n')
PY
"${psql[@]}" -f "$fixture/aggression-bootstrap.sql" \
 -f "$repo/supabase/migrations/20261027175924_record_call_only_aggression_at_fact_insertion.sql" \
 -f "$repo/supabase/migrations/20261029044604_uncalled_returns_preserve_recorded_aggression_counts.sql" \
 -f "$repo/supabase/migrations/20261029064252_valid_public_bookkeeping_preserves_aggression_coverage.sql" \
 -f "$work/recorded-bookkeeping.sql" \
 -f "$fixture/aggression-assertions.sql"
"${psql[@]}" -f "$fixture/cache-raises-bootstrap.sql" \
 -f "$repo/supabase/migrations/20261027182146_action_cache_distinguishes_all_in_calls_from_raises.sql" \
 -f "$fixture/cache-raises-assertions.sql"
"${psql[@]}" -f "$fixture/coverage-bootstrap.sql" \
 -f "$repo/supabase/migrations/20261029065040_recorded_hand_coverage_supplies_aggression_and_elapsed_hours.sql" \
 -f "$fixture/coverage-assertions.sql"
if [[ -n "${STATS_FUNDED_EXPORT:-}" ]]; then
 "${psql[@]}" -Atc "SELECT pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure)" >"$STATS_FUNDED_EXPORT"
fi
if "${psql[@]}" -f "$repo/supabase/migrations/20261018163053_player_stats_follow_the_funded_club.sql" >"$work/replay.log" 2>&1; then
 echo 'Funded Stats migration replay unexpectedly succeeded' >&2; exit 1
fi
grep -q 'Funded Stats patch already present' "$work/replay.log"
echo 'PASS: funded Stats migration replay refused'
