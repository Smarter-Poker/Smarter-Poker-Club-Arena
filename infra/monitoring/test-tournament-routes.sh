#!/usr/bin/env bash
# Exercise the real Alertmanager route evaluator before accepting a deployment.
set -euo pipefail
config="$1"; shift
for severity in critical warning info; do
  for page in sms none; do
    "$@" config routes test --config.file="$config" --verify.receivers=codex-inbox \
      alertname=TournamentNeverStarted component=tournament severity="$severity" page="$page"
    "$@" config routes test --config.file="$config" --verify.receivers=codex-inbox \
      alertname=MttPlayStopped severity="$severity" page="$page"
  done
done
for name in HorseTournamentsOverdue SpinFleetProducingNothing; do
  "$@" config routes test --config.file="$config" --verify.receivers=codex-inbox \
    alertname="$name" severity=critical
done
"$@" config routes test --config.file="$config" --verify.receivers=null-receiver \
  alertname=MonitoringCanary component=tournament severity=canary
# Preserve the unrelated infrastructure escalation policy.
"$@" config routes test --config.file="$config" --verify.receivers=codex-inbox,email-critical \
  alertname=EngineScrapeDown component=engine severity=critical
