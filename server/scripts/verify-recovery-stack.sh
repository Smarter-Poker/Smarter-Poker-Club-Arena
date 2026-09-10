#!/usr/bin/env bash
#
# verify-recovery-stack.sh - proves deterministic recovery is still wired up.
#
# This read-only audit distinguishes deterministic lifecycle ownership from
# periodic mutation. Docker owns process/daemon/host restarts, autoheal still
# owns unhealthy-process recovery, and the release transaction plus
# ExecStopPost own exact desired restoration. The retired 60-second supervisor
# must stay absent so no timer can fight an intentional stop or a release.
#
# Usage:  verify-recovery-stack.sh          # assert wiring, exit 1 on any failure
#
set -uo pipefail

CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE_REPO="${IMAGE_REPO:-club-arena-engine}"
PORT="${PORT:-8080}"
CONTROL_DIR="${ENGINE_CONTROL_DIR:-/usr/local/lib/club-arena/engine-control}"
RELEASE_SEAL="${ENGINE_RELEASE_SEAL:-$CONTROL_DIR/engine-release-seal.py}"
UP_SCRIPT="${UP_SCRIPT:-$CONTROL_DIR/engine-up.sh}"
ONE_SHOT_RECOVERY="${ONE_SHOT_RECOVERY:-$CONTROL_DIR/engine-supervisor.sh}"
RELEASE_TRANSACTION="${RELEASE_TRANSACTION:-$CONTROL_DIR/engine-release-transaction.sh}"
RELEASE_RECOVER="${RELEASE_RECOVER:-$CONTROL_DIR/engine-release-recover.sh}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-15}"
# Docker reports health timing fields as integer nanoseconds. These floors are
# the production safety contract, not cosmetic preferences: a shorter timeout
# or cold-boot grace can turn load into a platform-wide restart.
MIN_HEALTH_TIMEOUT_NS="${MIN_HEALTH_TIMEOUT_NS:-15000000000}"
MIN_HEALTH_START_PERIOD_NS="${MIN_HEALTH_START_PERIOD_NS:-300000000000}"

PASS=0; FAIL=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '  INFO  %s\n' "$1"; }
head_() { printf '\n%s\n' "$1"; }

echo "Club Arena recovery-stack verification — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

head_ "Layer 1 — the container itself"
STATE=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo absent)
[ "$STATE" = "running" ] && ok "container is running" || bad "container state is '$STATE'"

POLICY=$(docker container inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null || echo none)
# The correct value depends on release authority and is checked below after the
# seal classifies this exact container. A proof candidate must be `no`; the
# durable desired release must be `always`.

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
# A pending candidate is deliberately excluded from autoheal until the seal is
# committed. The authority-aware verdict is emitted below after classification.

head_ "Layer 3 - causal recovery authority, with no periodic mutator"
SUPERVISOR_RETIRED=1
for retired_path in \
  /etc/systemd/system/club-arena-supervisor.timer \
  /etc/systemd/system/club-arena-supervisor.service \
  /etc/systemd/system/timers.target.wants/club-arena-supervisor.timer; do
  [ ! -e "$retired_path" ] || SUPERVISOR_RETIRED=0
done
systemctl is-active --quiet club-arena-supervisor.timer 2>/dev/null \
  && SUPERVISOR_RETIRED=0
systemctl is-enabled --quiet club-arena-supervisor.timer 2>/dev/null \
  && SUPERVISOR_RETIRED=0
[ "$SUPERVISOR_RETIRED" = 1 ] \
  && ok "periodic engine supervisor service, timer, and enablement are absent" \
  || bad "periodic engine supervisor is installed, enabled, or active"

if [ -x "$ONE_SHOT_RECOVERY" ] \
  && grep -Fq 'ENGINE_SUPERVISOR_FORCE_DESIRED' "$ONE_SHOT_RECOVERY" \
  && grep -Fq 'ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH' "$ONE_SHOT_RECOVERY" \
  && grep -Fq 'ENGINE_SUPERVISOR_LOCK_HELD' "$ONE_SHOT_RECOVERY"; then
  ok "exact desired restoration exists and requires explicit causal authority"
else
  bad "one-shot exact desired restoration is missing or accepts autonomous invocation"
fi

CAUSAL_CALLERS_WIRED=1
for caller in "$RELEASE_TRANSACTION" "$RELEASE_RECOVER"; do
  [ -r "$caller" ] \
    && grep -Fq 'ENGINE_SUPERVISOR_FORCE_DESIRED=1' "$caller" \
    && grep -Fq 'ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1' "$caller" \
    && grep -Fq 'ENGINE_SUPERVISOR_LOCK_HELD=1' "$caller" \
    || CAUSAL_CALLERS_WIRED=0
done
[ "$CAUSAL_CALLERS_WIRED" = 1 ] \
  && ok "release transaction and ExecStopPost recovery own exact restoration" \
  || bad "release recovery callers do not pass the complete causal authority"

head_ "Layer 3b - concurrent engine mutations serialize"
if grep -q 'flock' "$UP_SCRIPT" 2>/dev/null; then
  ok "engine-up.sh takes the mutual-exclusion lock"
else
  bad "engine-up.sh has no flock - concurrent release mutations can overlap"
fi

head_ "Layer 4 — release identity is sealed outside mutable tags and checkout"
if [ -x "$RELEASE_SEAL" ]; then
  DESIRED_SHA=$("$RELEASE_SEAL" get desired-sha 2>/dev/null || echo "")
  DESIRED_IMAGE_ID=$("$RELEASE_SEAL" get desired-image-id 2>/dev/null || echo "")
  RELEASE_CLASS=$("$RELEASE_SEAL" classify-running --container "$CONTAINER" 2>/dev/null || echo "invalid")
else
  DESIRED_SHA=""; DESIRED_IMAGE_ID=""; RELEASE_CLASS="invalid"
fi
RUNNING_IMAGE_ID=$(docker container inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || echo "")
CURRENT_IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:current" 2>/dev/null || echo "")
if [ -n "$DESIRED_SHA" ] && [ -n "$DESIRED_IMAGE_ID" ]; then
  ok "durable release seal names $DESIRED_SHA / $DESIRED_IMAGE_ID"
else
  bad "durable release seal is missing or corrupt — recovery has no release authority"
fi
if [ "$RELEASE_CLASS" = "desired" ]; then
  ok "running container image ID matches the durable release seal"
  [ "$POLICY" = "always" ] \
    && ok "desired release restart policy is 'always' (covers crash, daemon restart, reboot)" \
    || bad "desired release restart policy is '$POLICY' instead of 'always'"
  [ "$AH" = "running" ] && ok "sp-autoheal sidecar protects the desired release" \
    || bad "sp-autoheal is '$AH' while the desired release is serving"
elif [ "$RELEASE_CLASS" = "pending" ]; then
  ok "running container is the one-use audited candidate inside its proof window"
  [ "$POLICY" = "no" ] \
    && ok "pending candidate is non-persistent until its compatibility proof commits" \
    || bad "pending candidate restart policy is '$POLICY' — unsealed bytes could survive a reboot"
  [ "$AH" != "running" ] && ok "sp-autoheal is fenced from the pending candidate" \
    || bad "sp-autoheal is running during candidate proof and can restart unsealed bytes"
else
  bad "running container image $RUNNING_IMAGE_ID disagrees with sealed $DESIRED_IMAGE_ID"
fi
if [ "$CURRENT_IMAGE_ID" = "$DESIRED_IMAGE_ID" ] \
   || { [ "$RELEASE_CLASS" = "pending" ] && [ "$CURRENT_IMAGE_ID" = "$RUNNING_IMAGE_ID" ]; }; then
  ok ":current agrees with sealed desired or the active audited candidate"
else
  note ":current is a repairable cache (currently '${CURRENT_IMAGE_ID:-absent}'); the sealed image ID remains recovery authority"
fi

head_ "Layer 4b — the sealed recovery image exists locally"
if docker image inspect "$DESIRED_IMAGE_ID" >/dev/null 2>&1; then
  ok "sealed desired image exists locally and can be recovered by immutable ID"
else
  bad "sealed desired image $DESIRED_IMAGE_ID is missing locally — recovery cannot start it"
fi
# :previous is retained only as an operator breadcrumb. It is never trusted by
# the supervisor or rollback; both resolve the durable desired image ID.
if docker image inspect "$IMAGE_REPO:previous" >/dev/null 2>&1; then
  note "optional :previous cache exists ($(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:previous" | cut -c8-19))"
else
  note "optional :previous cache is absent; rollback still uses the sealed desired image ID"
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
if [ -n "$DESIRED_SHA" ] && [ "$VER" = "${DESIRED_SHA:0:8}" ]; then
  ok "engine reports the exact sealed desired build ($VER)"
else
  bad "engine reports version='$VER' but the sealed desired build is '${DESIRED_SHA:0:8}'"
fi

head_ "Layer 6 - recovery verification reaches a human"
# sp-node-exporter carries this verifier's result into Prometheus through its
# textfile collector. If it dies, an on-disk result would never page anyone.
for c in sp-prometheus sp-alertmanager sp-node-exporter; do
  S=$(docker container inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo absent)
  [ "$S" = "running" ] && ok "$c is running" || bad "$c is '$S'"
done
if docker inspect sp-node-exporter -f '{{.Config.Cmd}}' 2>/dev/null | grep -q 'collector.textfile.directory'; then
  ok "node-exporter has the textfile collector enabled (recovery audit metrics are readable)"
else
  bad "node-exporter is missing --collector.textfile.directory - recovery audit metrics never reach Prometheus"
fi

# Every Prometheus scrape target must be healthy. On 2026-08-16 the rebuilt box
# had node-exporter running, with the textfile collector flag set, writing a
# fresh audit result to disk - and Prometheus was not scraping it at all. UFW
# defaults to DROP on INPUT, and node-exporter uses host networking, so traffic
# from the docker bridge to :9100 was dropped. (Port 8080 worked because Docker
# publishes it through FORWARD, bypassing INPUT.) Every check below passed while
# the recovery audit was completely unobservable. Checking the plumbing is not
# the same as checking the metric arrived.
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
  if echo "$RULES" | grep -q 'club-arena-recovery'; then
    ok "recovery audit alert rules are loaded in Prometheus"
  else
    bad "recovery audit alert rules are NOT loaded - verification failures would be silent"
  fi
  if echo "$RULES" | grep -q '"health":"err"'; then
    bad "at least one Prometheus rule is in an error state"
  else
    ok "no Prometheus rule is erroring"
  fi
fi

# Publish the result so the verification itself cannot rot unnoticed. A check
# that runs on a timer and is never looked at is the same as no check —
# RecoveryStackDegraded in recovery-rules.yml is what turns this into a page.
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
