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
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-15}"
# Docker reports health timing fields as integer nanoseconds. These floors are
# the production safety contract, not cosmetic preferences: a shorter timeout
# or cold-boot grace can turn load into a platform-wide restart.
MIN_HEALTH_TIMEOUT_NS="${MIN_HEALTH_TIMEOUT_NS:-15000000000}"
MIN_HEALTH_START_PERIOD_NS="${MIN_HEALTH_START_PERIOD_NS:-300000000000}"

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

# `docker inspect -f '{{.Config.Healthcheck.Timeout}}'` renders `15s`, which is
# not safe shell arithmetic. The json template function serialises the same
# Go duration as its integer nanoseconds value.
HC_TIMEOUT_NS=$(docker container inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Timeout}}{{else}}0{{end}}' "$CONTAINER" 2>/dev/null || echo 0)
case "$HC_TIMEOUT_NS" in ''|*[!0-9]*) HC_TIMEOUT_NS=0 ;; esac
[ "$HC_TIMEOUT_NS" -ge "$MIN_HEALTH_TIMEOUT_NS" ] 2>/dev/null \
  && ok "HEALTHCHECK timeout is at least 15s (event-loop saturation tolerance)" \
  || bad "HEALTHCHECK timeout is ${HC_TIMEOUT_NS}ns - below the 15s safety floor; load can trigger false restarts"

HC_START_NS=$(docker container inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.StartPeriod}}{{else}}0{{end}}' "$CONTAINER" 2>/dev/null || echo 0)
case "$HC_START_NS" in ''|*[!0-9]*) HC_START_NS=0 ;; esac
[ "$HC_START_NS" -ge "$MIN_HEALTH_START_PERIOD_NS" ] 2>/dev/null \
  && ok "HEALTHCHECK start period is at least 300s (cold-boot grace)" \
  || bad "HEALTHCHECK start period is ${HC_START_NS}ns - below the 300s cold-boot safety floor"

# Docker considers the start period complete after the first successful probe.
# The command therefore has to enforce the same grace from PID 1's age, or a
# quick early success followed by load-ramp timeouts can still trigger autoheal.
HC_TEST=$(docker container inspect -f '{{if .Config.Healthcheck}}{{join .Config.Healthcheck.Test " "}}{{end}}' "$CONTAINER" 2>/dev/null || echo "")
if echo "$HC_TEST" | grep -Fq '/proc/1/stat' \
  && echo "$HC_TEST" | grep -Fq 'if(a<300)' \
  && echo "$HC_TEST" | grep -Fq "l==='ok'||l==='standby'"; then
  ok "HEALTHCHECK enforces PID 1 grace and explicit ok/standby liveness"
else
  bad "HEALTHCHECK is missing PID 1 grace or explicit ok/standby liveness"
fi

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

head_ "Layer 3b — the supervisor cannot fight a deploy"
if grep -q 'flock' "${UP_SCRIPT:-/opt/club-arena/server/scripts/engine-up.sh}" 2>/dev/null; then
  ok "engine-up.sh takes the mutual-exclusion lock"
else
  bad "engine-up.sh has no flock — a supervisor tick can recreate the container a deploy just made, failing that deploy's verification"
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
BODY=$(curl -sf --max-time "$HEALTH_TIMEOUT_SEC" "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "")
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
# sp-node-exporter is included deliberately. Everything the supervisor
# publishes reaches Prometheus ONLY through its textfile collector. If it dies,
# the supervisor heartbeat goes stale in Prometheus while this script — which
# reads the metric file straight off disk — keeps reporting Layer 3 green. The
# supervisor becomes unobservable and the verifier says "intact".
for c in sp-prometheus sp-alertmanager sp-node-exporter; do
  S=$(docker container inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo absent)
  [ "$S" = "running" ] && ok "$c is running" || bad "$c is '$S'"
done
if docker inspect sp-node-exporter -f '{{.Config.Cmd}}' 2>/dev/null | grep -q 'collector.textfile.directory'; then
  ok "node-exporter has the textfile collector enabled (supervisor metrics are readable)"
else
  bad "node-exporter is missing --collector.textfile.directory — supervisor metrics never reach Prometheus"
fi

# Every Prometheus scrape target must be healthy. On 2026-08-16 the rebuilt box
# had node-exporter running, with the textfile collector flag set, writing a
# fresh heartbeat to disk — and Prometheus was not scraping it at all. UFW
# defaults to DROP on INPUT, and node-exporter uses host networking, so traffic
# from the docker bridge to :9100 was dropped. (Port 8080 worked because Docker
# publishes it through FORWARD, bypassing INPUT.) Every check below passed while
# the supervisor was completely unobservable, which is the exact failure this
# whole script exists to prevent. Checking the plumbing is not the same as
# checking the metric arrived.
TARGETS=$(curl -sf --max-time 5 localhost:9090/api/v1/targets 2>/dev/null || echo "")
if [ -z "$TARGETS" ]; then
  bad "cannot read Prometheus targets — scrape health unknown"
else
  DOWN=$(echo "$TARGETS" | grep -o '"health":"[a-z]*"' | grep -cv '"health":"up"' || true)
  if [ "${DOWN:-0}" -eq 0 ]; then
    ok "all Prometheus scrape targets are up"
  else
    bad "$DOWN Prometheus scrape target(s) are DOWN — some metrics never arrive"
  fi
fi

# The supervisor heartbeat must exist IN PROMETHEUS, not merely on disk.
HB=$(curl -sf --max-time 5 \
  'localhost:9090/api/v1/query?query=time()-club_arena_supervisor_last_run_timestamp_seconds' 2>/dev/null \
  | grep -o '"value":\[[^]]*\]' | sed 's/.*,"//;s/".*//' | head -1)
case "$HB" in
  ''|*[!0-9.-]*) bad "supervisor heartbeat is ABSENT from Prometheus (on-disk file is not enough)" ;;
  *) if [ "${HB%%.*}" -lt 300 ] 2>/dev/null; then
       ok "supervisor heartbeat reached Prometheus (${HB%%.*}s old)"
     else
       bad "supervisor heartbeat in Prometheus is stale (${HB%%.*}s old)"
     fi ;;
esac

# Grafana ships with admin/admin and GF_SECURITY_ADMIN_PASSWORD only applies on
# FIRST initialisation — setting it later does nothing, because the password is
# already stored in Grafana's database. On 2026-08-16 the rebuilt box ran for 15
# hours on the default credential: the compose file interpolates
# ${GRAFANA_ADMIN_PASSWORD}, and the runtime .env had been written with the
# variable named GF_SECURITY_ADMIN_PASSWORD instead, so it resolved to empty.
# Nothing else in the stack notices, because Grafana is perfectly healthy with a
# default password.
GRAF_PORT="${GRAF_PORT:-3001}"
if curl -sf --max-time 5 "localhost:${GRAF_PORT}/api/health" >/dev/null 2>&1; then
  ok "grafana is reachable on :${GRAF_PORT}"
  GCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -u admin:admin "localhost:${GRAF_PORT}/api/org" 2>/dev/null)
  if [ "$GCODE" = "200" ]; then
    bad "grafana still accepts the DEFAULT admin:admin credential"
  else
    ok "grafana rejects the default admin:admin credential (HTTP $GCODE)"
  fi
else
  bad "grafana is not answering on :${GRAF_PORT}"
fi

RULES=$(curl -sf --max-time 5 localhost:9090/api/v1/rules 2>/dev/null || echo "")
if [ -z "$RULES" ]; then
  # Previously this produced ONE failure (rules not loaded) and one spurious
  # PASS, because `grep -q '"health":"err"'` finds nothing in an empty string
  # and the else-branch reported "no rule is erroring". An unreachable
  # Prometheus is not evidence that its rules are fine.
  bad "Prometheus API unreachable — cannot verify that any alert rule is loaded"
  bad "rule health unknown (Prometheus unreachable)"
else
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
