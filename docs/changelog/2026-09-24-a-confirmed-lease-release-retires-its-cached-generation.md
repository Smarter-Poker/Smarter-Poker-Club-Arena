# A Confirmed Lease Release Retires Its Cached Generation

Date: 2026-09-24. `server/src/GameServer.ts` (`performDirectTableEngineRecovery`)
and its test only. No migration, no client change, no workflow change.

## What was wrong

Three real-money cash tables were caught in a permanent crash-restart loop:
`3c00d4d0` (PLO4 1/2 Classic, since 2026-09-19, ~5 days), `6c9ee4b6` (NLH 1/2
Madness Feeder) and `71d90586` (NLH 2/5 Classic), both since 2026-09-22. All
three sat fully seated (6/6, 6/6, 9/9; ~$9,819 combined stacks, all intact and
untouched) with `hands_dealt=0` and `avg_pot=0.00` — every seated player had
never once seen a hand dealt — while `engine_recovery_events` recorded
`watchdog_kill_rebuild` / `start_failed:start_load_table` at 30-65 events a
minute per table, continuously, for a combined 200,000+ pointless restart
cycles. This predates this fleet's monitoring; two earlier audits
(`.agent/audits/2026-08-26-closing-the-remaining-items.md` and
`2026-08-26-seat-exit-detector-and-dead-refund-pool.md`) had already flagged
the `start_failed:start_load_table` signature on one of these exact tables
without root-causing it, and
`docs/changelog/2026-09-21-the-drain-guard-pins-custody-not-the-churning-fleet.md`
documented the same table's exact restart cycle in detail on 2026-09-21 while
fixing only the maintenance checkpoint's tolerance of it — the churn itself
was never fixed.

## Root cause

Each table has exactly one `smarter_private.hand_submissions` row retained
(via `fn_ca_retain_hand_submission`) from an original crashed attempt, with no
matching `hand_atomic_commits` row. On every restart, `checkCrashRecovery()`
calls `resumeRetainedHandSubmission(tableId, INSTANCE_ID, authority.generation)`,
which reaches `fn_ca_resume_hand_submission`'s
`IF s.lease_generation = p_lease_generation THEN RETURN ...
'original_failure_or_handoff_unproven'` guard — a deliberate anti-double-settle
protection that refuses to let the SAME engine generation that produced the
stuck submission declare its own attempt dead.

That guard is correct. The bug is that every restart WAS presenting that same
generation, although `engine_table_leases` genuinely rotates
`lease_generation` on each fresh claim. In
`performCashTableEngineAdmission` (`GameServer.ts:10070-10073`):

```ts
const requestedLeaseGeneration =
  this.directTableAdmissionLeaseGenerations.get(tableId) ?? randomUUID();
this.directTableAdmissionLeaseGenerations.set(tableId, requestedLeaseGeneration);
const lease = await claimTableLease(tableId, requestedLeaseGeneration);
```

`directTableAdmissionLeaseGenerations` is a process-lifetime cache, keyed by
table id, that lets a genuinely UNCERTAIN claim (network failure, ambiguous
result) retry with the same candidate UUID instead of risking a double grant.
That is the right behaviour for an uncertain claim. But once a claim is
GRANTED and the table later fails for an unrelated reason — here, the
crash-recovery guard refusing a retained hand — `performDirectTableEngineRecovery`
released the granted lease generation from the database
(`releaseTables([{ tableId, leaseGeneration: leaseAuthority.generation }])`,
confirmed) and then left it sitting in `directTableAdmissionLeaseGenerations`.
The very next admission attempt read that same cached value back out
(`.get(tableId) ?? randomUUID()` only falls through to a fresh UUID when the
map has nothing) and requested — and was granted — the exact same dead
generation again. Every retry therefore matched the stuck submission's own
recorded generation, `fn_ca_resume_hand_submission` refused it every time by
design, and the table could never recover on its own.

The sibling release path, `awaitDirectTableLeaseRelease` (used for the
uncertain-claim case), already clears this same cache once its own release is
confirmed (`GameServer.ts:1766-1768`). `performDirectTableEngineRecovery`'s
confirmed release never had the matching cleanup.

## The fix

`performDirectTableEngineRecovery` now clears
`directTableAdmissionLeaseGenerations` for the table, guarded by identity
(only when the cached value still equals the generation it just confirmed
released), immediately after `releaseTables(...)` reports `confirmed`. The
next admission attempt — immediate or via `scheduleDirectTableRecovery`'s
backoff — then requests a genuinely fresh UUID, which
`fn_ca_resume_hand_submission` will not match against the stuck submission's
original generation, letting the existing handoff path (the mismatched-
generation branch of the same function) resume the table normally.

No SQL change. The database guard was never wrong; the engine was asking it
the same wrong question forever.

## Tests

`server/src/engine/DirectEngineRecovery.guard.test.ts`: new source-window
assertion pins that the confirmed-release branch of
`performDirectTableEngineRecovery` deletes the cached generation, identity-
guarded, before the table is removed from `tableEngines`. Verified failing on
pre-fix `main` (`expected -1 to be greater than <confirmedGateAt>`) and
passing after the fix. Full server suite (`npx vitest run`, 987 files, 16,944
tests) and `npx tsc --noEmit` both pass unchanged otherwise.

## What is expected once this deploys

The three stuck tables resume dealing on their next restart after the release
(each already retries every 1-5 seconds, so within one cycle of the new
engine build going live). No repair job, sweep, backfill or manual SQL patch
against `fn_ca_resume_hand_submission` or the lease tables — the fix is
entirely in what generation the engine asks for, not in the database guard
that correctly refused it.

## Detection

`ClubArenaEngineKillStorm`'s only recorded row in `operational_alert_events`
was a dead 2026-09-19 backfill; the live condition (200,000+ ongoing kills)
never re-fired it. That alert's wiring on the Hetzner Prometheus stack needs a
separate audit against `infra/monitoring/` per CLAUDE.md 10.84 — tracked
separately, not fixed by this change.
