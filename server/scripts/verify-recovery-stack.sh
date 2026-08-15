#!/usr/bin/env bash
#
# verify-recovery-stack.sh — proves the never-down machinery is still wired up.
#
# The whole recovery stack is passive. Every piece of it sits idle until
# something breaks, which means every piece of it can rot silently for months
# and you find out during the incident it was supposed to prevent. That is not
# hypothetical here: the Docker HEALTHCHECK was believed to be self-healing for
# a full release cycle before anyone checked that plain Docker never restarts an
# unhealthy container.
#
# So this asserts, from the outside, that each layer is present and correctly
# configured. Run it on a schedule. Non-destructive: it changes nothing.
#
# Usage:  verify-recovery-stack.sh          # assert wiring, exit 1 on any failure
#
set -uo pipefail

CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE_REPO="${IMAGE_REPO:-club-arena-engine}"
PORT="${PORT:-8080}"
METRIC_FILE="${METRIC_FILE:-/var/lib/node-exporter-textfile/club_arena_supervisor.prom}"

PASS=0; FAIL=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n%s\n' "$1"; }

echo "Club Arena recovery-stack verification — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

head_ "Layer 1 — the container itself"
STATE=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo absent)
[ "$STATE" = "running" ] && ok "container is running" || bad "container state is '$STATE'"

POLICY=$(docker container inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null || echo none)
[ "$POLICY" = "always" ] && ok "restart policy is 'always' (covers crash, daemon restart, reboot)" \
  || bad "restart policy is '$POLICY' — a crash would not be recovered"

HC=$(docker container inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo none)
[ "$HC" != "none" ] && ok "HEALTHCHECK is defined (status: $HC)" \
  || bad "no HEALTHCHECK — a wedged-but-running process would be invisible"

head_ "Layer 2 — autoheal (the thing that acts on the healthcheck)"
# Docker's HEALTHCHECK only sets a status field. Plain Docker restarts nothing.
# Without this sidecar AND this label, the healthcheck is decorative.
LABEL=$(docker container inspect -f '{{index .Config.Labels "autoheal"}}' "$CONTAINER" 2>/dev/null || echo "")
[ "$LABEL" = "true" ] && ok "engine carries autoheal=true" \
  || bad "engine is MISSING autoheal=true — HEALTHCHECK is wired to nothing"

AH=$(docker container inspect -f '{{.State.Status}}' sp-autoheal 2>/dev/null || echo absent)
[ "$AH" = "running" ] && ok "sp-autoheal sidecar is running" || bad "sp-autoheal is '$AH'"

head_ "Layer 3 — host supervisor (independent of GitHub and of autoheal)"
if systemctl is-active --quiet club-arena-supervisor.timer; then
  ok "club-arena-supervisor.timer is active"
else
  bad "club-arena-supervisor.timer is NOT active — the last-resort recovery path is off"
fi

if [ -f "$METRIC_FILE" ]; then
  TS=$(grep -m1 '^club_arena_supervisor_last_run_timestamp_seconds ' "$METRIC_FILE" 2>/dev/null | awk '{print $2}')
  AGE=$(( $(date +%s) - ${TS:-0} ))
  if [ "${TS:-0}" -gt 0 ] && [ "$AGE" -lt 300 ]; then
    ok "supervisor heartbeat is ${AGE}s old"
  else
    bad "supervisor heartbeat is ${AGE}s old — it is installed but not running"
  fi
else
  bad "no supervisor heartbeat file — the supervisor is unobservable"
fi

head_ "Layer 4 — rollback is actually possible"
# A deploy pipeline with no rollback target is one bad build away from an
# outage it cannot exit.
if docker image inspect "$IMAGE_REPO:previous" >/dev/null 2>&1; then
  ok ":previous image exists ($(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:previous" | cut -c8-19))"
else
  bad "no $IMAGE_REPO:previous image — a bad deploy could NOT be rolled back"
fi
if docker image inspect "$IMAGE_REPO:current" >/dev/null 2>&1; then
  ok ":current image exists"
else
  bad "no $IMAGE_REPO:current image — the supervisor cannot recreate the container"
fi

head_ "Layer 5 — the engine is genuinely serving, and can say what it is"
BODY=$(curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "")
if echo "$BODY" | grep -q '"running":true'; then
  ok "/health reports running:true"
else
  bad "/health did not report running:true"
fi
if echo "$BODY" | grep -q '"liveness":"ok"'; then
  ok "liveness is ok (no table stalled past the freeze threshold)"
else
  bad "liveness is NOT ok — one or more tables are stalled"
fi
VER=$(echo "$BODY" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
if [ -n "$VER" ] && [ "$VER" != "local" ] && [ "$VER" != "unknown" ]; then
  ok "engine reports its build ($VER) — a stale-image deploy would be detectable"
else
  bad "engine reports version='$VER' — it cannot tell you what code it is running"
fi

head_ "Layer 6 — someone is watching, and alerts reach a human"
for c in sp-prometheus sp-alertmanager; do
  S=$(docker container inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo absent)
  [ "$S" = "running" ] && ok "$c is running" || bad "$c is '$S'"
done
RULES=$(curl -sf --max-time 5 localhost:9090/api/v1/rules 2>/dev/null || echo "")
if echo "$RULES" | grep -q 'club-arena-supervisor'; then
  ok "supervisor alert rules are loaded in Prometheus"
else
  bad "supervisor alert rules are NOT loaded — supervisor failure would be silent"
fi
if echo "$RULES" | grep -q '"health":"err"'; then
  bad "at least one Prometheus rule is in an error state"
else
  ok "no Prometheus rule is erroring"
fi

# Publish the result so the verification itself cannot rot unnoticed. A check
# that runs on a timer and is never looked at is the same as no check —
# RecoveryStackDegraded in supervisor-rules.yml is what turns this into a page.
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node-exporter-textfile}"
OUT="$TEXTFILE_DIR/club_arena_recovery_stack.prom"
if mkdir -p "$TEXTFILE_DIR" 2>/dev/null; then
  TMP="$OUT.$$"
  {
    echo "# HELP club_arena_recovery_stack_failures Failed assertions in the last recovery-stack verification."
    echo "# TYPE club_arena_recovery_stack_failures gauge"
    echo "club_arena_recovery_stack_failures $FAIL"
    echo "# HELP club_arena_recovery_stack_checks Total assertions run."
    echo "# TYPE club_arena_recovery_stack_checks gauge"
    echo "club_arena_recovery_stack_checks $((PASS + FAIL))"
    echo "# HELP club_arena_recovery_stack_last_verified_timestamp_seconds Unix time of the last verification."
    echo "# TYPE club_arena_recovery_stack_last_verified_timestamp_seconds gauge"
    echo "club_arena_recovery_stack_last_verified_timestamp_seconds $(date +%s)"
  } > "$TMP" 2>/dev/null && mv -f "$TMP" "$OUT" 2>/dev/null || rm -f "$TMP" 2>/dev/null
fi

echo
echo "──────────────────────────────────────────────"
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "Recovery stack is DEGRADED — a real outage may not self-recover."; exit 1; }
echo "Recovery stack intact."
