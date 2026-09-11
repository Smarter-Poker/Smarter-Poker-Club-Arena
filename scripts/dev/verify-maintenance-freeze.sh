#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  VERIFY THE MAINTENANCE FREEZE — one command, run it at any minute
#
#  Dan 2026-09-01: the hourly :55 break carries the engine restart and the
#  whole platform freezes for it. This is the watch-glass for the first armed
#  hour and any hour after: it reads every surface the break touches and says
#  PLAINLY which state the platform is in and whether the surfaces agree.
#
#  Usage:   bash scripts/dev/verify-maintenance-freeze.sh
#  Reads:   ENGINE_URL (default https://engine.smarter.poker);
#           SUPABASE_URL + SUPABASE_ANON_KEY from server/.env if present -
#           the database half is skipped without them.
#
#  READ-ONLY BY CONSTRUCTION. Nothing here writes anything anywhere; it is
#  safe to run in a loop during a live break.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ENGINE_URL="${ENGINE_URL:-https://engine.smarter.poker}"
ENV_FILE="$(dirname "$0")/../../server/.env"
say()  { printf '%s\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES+1)); }
FAILURES=0

MINUTE=$(date -u +%M)
say "── Maintenance freeze verification — minute :$MINUTE ─────────────────────"

# ── 1. The engine's own account ─────────────────────────────────────────────
HEALTH=$(curl -fsSL --max-time 10 -H 'Cache-Control: no-cache' "$ENGINE_URL/health" 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  # During ~:55-:58 the engine is legitimately dead. Say which case this is.
  if [ "$MINUTE" -ge 55 ] || [ "$MINUTE" -lt 1 ]; then
    warn "/health unreachable — expected if the restart is in progress right now"
  else
    fail "/health unreachable OUTSIDE the restart window"
  fi
else
  # The payload travels by environment variable, NOT a pipe: `python3 -`
  # reads its SCRIPT from stdin, so piping data in as well hands python the
  # heredoc and leaves json.load an empty stream. Caught on this script's own
  # first live run.
  VERDICTS=$(HEALTH_JSON="$HEALTH" python3 - <<'PYEOF'
import datetime, json, os

d = json.loads(os.environ["HEALTH_JSON"])
m = d.get("maintenance") or {}
print(f'INFO  engine {d.get("version")} up {int(d.get("uptime", 0))}s')
print(
    f'INFO  break: active={m.get("active")} phase={m.get("phase")} '
    f'remainingMs={m.get("remainingMs")} unparked={m.get("unparkedTables")} '
    f'durable={m.get("durableConfirmed")} ready={m.get("readyForRestart")}'
)

skew = m.get("dbClockSkewMs")
if skew is None:
    print("WARN  dbClockSkewMs not yet measured (engine younger than the first probe, or a pre-feature build)")
elif abs(skew) > 5000:
    print(f"FAIL  clock skew {skew}ms exceeds 5s")
else:
    print(f"PASS  clock skew {skew}ms within bounds")

minute = datetime.datetime.utcnow().minute
if 53 <= minute:
    if m.get("active"):
        print("PASS  break state plausible for this minute")
    else:
        print(f"WARN  minute :{minute:02d} but no break active — check [MaintenanceBreak] in the engine log")
else:
    if m.get("active"):
        print("WARN  break active outside :53-:00 — investigate")
    else:
        print("PASS  no break expected at this minute")
PYEOF
) || fail "could not parse /health"
  printf '%s\n' "$VERDICTS" | sed 's/^/  /'
  printf '%s\n' "$VERDICTS" | grep -q '^FAIL' && FAILURES=$((FAILURES+1))
fi

# ── 2. The database's account ───────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  SUPABASE_URL=$(grep -m1 '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  ANON=$(grep -m1 '^SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
fi
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${ANON:-}" ]; then
  STATE=$(curl -fsS --max-time 10 "$SUPABASE_URL/rest/v1/rpc/fn_maintenance_break_state" \
    -X POST -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo '[]')
  say "  INFO  fn_maintenance_break_state -> $STATE"
  FROZEN=$(curl -fsS --max-time 10 "$SUPABASE_URL/rest/v1/rpc/fn_platform_frozen" \
    -X POST -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo '?')
  say "  INFO  fn_platform_frozen -> $FROZEN"
  # The two database surfaces must not contradict each other.
  case "$FROZEN" in
    true)
      if printf '%s' "$STATE" | grep -q counting_down; then
        pass "DB freeze and break state agree (frozen)"
      else
        fail "fn_platform_frozen=true but break state shows no countdown"
      fi ;;
    false)
      if printf '%s' "$STATE" | grep -q counting_down; then
        warn "break counting down but freeze not armed — a pre-freeze engine build is still the one declaring breaks (enforce_freeze=false)"
      else
        pass "DB freeze and break state agree (not frozen)"
      fi ;;
    *) warn "fn_platform_frozen unreadable" ;;
  esac
else
  warn "server/.env not found or missing SUPABASE_URL/SUPABASE_ANON_KEY — database half skipped"
fi

# ── 3. Verdict ──────────────────────────────────────────────────────────────
say "──────────────────────────────────────────────────────────────────────────"
if [ "$FAILURES" -eq 0 ]; then
  say "VERDICT: no failures. (WARNs are context, not defects — read them.)"
else
  say "VERDICT: $FAILURES failure(s) above."
  exit 1
fi
