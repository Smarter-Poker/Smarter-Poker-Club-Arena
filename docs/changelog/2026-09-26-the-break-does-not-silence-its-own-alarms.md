# The break does not silence the alarms about itself

2026-09-26, infra/monitoring.

## Measured

From `engine_maintenance_thaws` (announcement -> thaw), 24 hours to
2026-09-26 04:10 UTC: 48 breaks (hourly plus a recovery window almost every
hour), the break flag on for **23.9%** of the day, and the fleet guard
(`unless max_over_time(poker_maintenance_break_active[6m]) == 1`, which adds a
6-minute tail) muting **39.5%**. 30 muted segments; median unmuted gap 29.8
minutes, longest 46.9. In an ordinary hour the unmuted stretch is :06 -> :53,
47 minutes. Three-hour shares over 2026-09-19..26: 0.119 on every ordinary
window; 0.16-0.28 with one extra window; 0.438 / 0.439 / 0.400 in the three
recovery-window storms (09-21, 09-25, 09-26).

## What was blind, and the fix

- `EngineCannotBeReplaced` and `EngineReplacementWatchdogBlind` - alarms
  about the release route - were guarded by the break they measure. Guard
  removed from both. (`PokerEngineCannotBeReplaced` and
  `EngineReleaseGateNeverOpens` were already unguarded.)
- `TournamentRunningWithNoOwnerCritical` (`for: 1h`) and
  `EngineSheddingPrecisionForHours` (`for: 2h`) sat behind the guard, and every
  muted evaluation resets `for`, so they could never fire on any day. Each now
  measures its duration inside the expression: the condition held at every
  unmuted minute of the window (with a floor of 30 / 60 such minutes), with
  `for: 5m`. The guard still applies minute by minute, so a break is still
  never a fault.
- NEW `PlatformFrozenTooOften` (critical, unguarded):
  `max(avg_over_time(poker_maintenance_break_active[3h])) > 0.30` for 15m.
  Fires on all three storms and on none of the ordinary days.
- `MttFleetNotDealing` (`for: 10m`) and the other guarded criticals fit inside
  the gaps and are unchanged.

## Pins

- `tests/theBreakDoesNotSilenceTheAlarmsAboutItself.law.test.ts`: no
  release-route alarm guarded; every guarded `for` <= 40m; the rewritten
  shapes and the new alarm; negative proofs.
- `tests/monitoring/break-does-not-silence-its-own-alarms.test.yml`: promtool
  timing cases under a real hourly break pattern (run by
  `scripts/ci/test-fleet-throughput.sh` in CI).

Live when `deploy-monitoring.yml` runs on the merge and
`/api/v1/rules` on engine-01 lists the new rule (CLAUDE.md 10.84).
