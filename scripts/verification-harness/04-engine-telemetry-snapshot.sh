#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Phase G-2 Engine Health Snapshot
# ═══════════════════════════════════════════════════════════════════════════════
# Pulls the engine /health endpoint and validates:
#   - hands_dealt > 0
#   - hands_per_hour > 0
#   - broadcast_threshold_violations == 0
#   - Hetzner container reachable
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ENGINE_URL="${ENGINE_URL:-https://engine.smarter.poker}"
HEALTH_JSON=$(curl -fsSL "${ENGINE_URL}/health")

echo "═══ ENGINE HEALTH SNAPSHOT ($(date -u +%FT%TZ)) ═══"
echo "${HEALTH_JSON}" | jq .

HANDS=$(echo "${HEALTH_JSON}" | jq -r '.totalHandsDealt // 0')
HPH=$(echo "${HEALTH_JSON}" | jq -r '.telemetry.avgHandsPerHour // 0')
VIOLATIONS=$(echo "${HEALTH_JSON}" | jq -r '.performance.broadcastThresholdViolations // -1')
PROC_VIOLATIONS=$(echo "${HEALTH_JSON}" | jq -r '.performance.processingThresholdViolations // -1')
RUNNING=$(echo "${HEALTH_JSON}" | jq -r '.running // false')

echo
echo "─── ASSERTIONS ───"

if [[ "${HANDS}" -gt 0 ]]; then
  echo "PASS — hands_dealt=${HANDS} > 0"
else
  echo "FAIL — hands_dealt=${HANDS}"; exit 1
fi

if (( $(echo "${HPH} > 0" | bc -l) )); then
  echo "PASS — hands_per_hour=${HPH} > 0"
else
  echo "FAIL — hands_per_hour=${HPH}"; exit 1
fi

if [[ "${VIOLATIONS}" == "0" ]]; then
  echo "PASS — broadcastThresholdViolations=0"
else
  echo "FAIL — broadcastThresholdViolations=${VIOLATIONS}"; exit 1
fi

if [[ "${PROC_VIOLATIONS}" == "0" ]]; then
  echo "PASS — processingThresholdViolations=0"
else
  echo "FAIL — processingThresholdViolations=${PROC_VIOLATIONS}"; exit 1
fi

if [[ "${RUNNING}" == "true" ]]; then
  echo "PASS — engine running"
else
  echo "FAIL — engine not running"; exit 1
fi

echo
echo "ALL ASSERTIONS PASS."
