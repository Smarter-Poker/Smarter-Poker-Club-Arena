# MTT progress is measured per event

On September 13, 84 RUNNING MTTs recorded no hand for 30 minutes while cash
tables dealt and 509 tournament managers retained leases. Manager ownership
and aggregate hand activity did not expose this failure. The engine now reads
an additional service-only aggregate that checks recent hands for each MTT.
It also counts breaks that remain set past their break or add-on deadline.

The existing tournament collector exports `poker_mtt_stalled_running` and
`poker_mtt_overdue_breaks`. All required counts must be nonnegative integers;
missing or malformed evidence retains the last good snapshot and its original
timestamp. A stopped collector cannot publish a late response. Both reads are
drained before another refresh is admitted.

## Interpretation and response

- `MttPlayStopped` means a scheduled MTT or multi-table satellite is at least
  15 minutes old with no hand for that specific event in the last 15 minutes.
  Active breaks and add-ons, plus add-on recovery grace, are excluded. Other
  events' hands cannot clear its count. Inspect scheduler in-flight work and
  deferred responsibility, committed knockout candidates, table adoption and
  one-player tables. Diagnose the failing continuation before changing seats.
- `MttBreakDidNotEnd` means a break remains set more than ten minutes after
  the later break/add-on deadline. A missing countdown end has a bounded
  fallback; it is not an indefinite exemption. Inspect break-clear errors,
  pending add-on finalization and actual maintenance thaw. Preserve the
  outstanding pause owner until its operation has acknowledged completion.
- Both rules require a fresh metrics snapshot and suppress active/recent
  platform maintenance. A stale collector is represented by
  `poker_tournament_metrics_stale_seconds`; missing data is not recovery.
- These signals are diagnostic alerts, not inputs that restart the process
  or forcibly release tables. Existing recovery and monetary authorities keep
  ownership of the repair.

The hand threshold exceeds the measured seven-day maximum of 214.389 seconds
(p99 80.146 seconds over 2,101,203 completed tournament hands) and an ordinary
five-minute break. Alerts require a further five minutes of stalled play or
two minutes of overdue-break evidence. The equivalent read-only production
query took 66.167 ms across 84 MTTs, using the existing tournament status and
per-tournament hand-history indexes. It returns two counts, not user data.

## Validation and publication

The old collector failed 16 of 17 new runtime cases. The repaired collector
passes 37 cases across its new and existing suites, including malformed and
failed reads, retained snapshots and shutdown fencing. The native probe
`python3 scripts/dev/probe-tournament-progress-pg17.py` passes 23 groups for
event isolation, break/add-on timing, missing timestamps, format boundaries,
read-only replay and service-role-only access. It creates and removes its own
PostgreSQL 17 cluster and uses synthetic rows.

All service suites pass: 3,225 tests across 185 files. Server typechecking,
monitoring drift checks and Prometheus's rule parser pass (nine tournament
rules checked through stdin; no running rule configuration was changed).

The database migration was applied at 19:34 UTC outside the protected window.
The installed definition fingerprint is `48fbeb982336d4303a6eb503e999d064`;
only postgres and service_role can execute it. Migration history recorded
`20260913193457` under `tournament_progress_is_measured_per_event`; the reserved
repository filename remains `20260913184615`. At 19:35 UTC the read returned
65 stalled running MTTs and zero overdue breaks. This observation is not a
claim that the remaining tournaments are fully functional.

Migration `20260913184615_tournament_progress_is_measured_per_event.sql`
is installed before the engine caller ships. The engine release and the
monitoring rule publication are separate proofs: after the normal release,
verify the new metrics in the served engine and verify `MttPlayStopped` and
`MttBreakDidNotEnd` in Prometheus's loaded rule inventory. Merging this file
does not prove that the engine or monitoring rules are live.
