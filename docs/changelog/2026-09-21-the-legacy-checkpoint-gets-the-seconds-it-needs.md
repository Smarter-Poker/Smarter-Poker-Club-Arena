# The Legacy Checkpoint Gets The Seconds It Needs

Date: 2026-09-21. Release-control scripts and their tests only. No migration,
no client change, no engine change, no workflow change. Nothing was deployed
by this commit; the installed control generation picks it up on its next
ordinary install.

## What was wrong

The exact 8825 legacy checkpoint could never finish. The arithmetic says so,
and run 35615604946 says so.

The engine's break countdown is always `BREAK_DURATION_MS`, 300,000 ms,
hourly windows and recovery windows alike. `engine-release-transaction.sh`
requires `MIN_BREAK_REMAINING_MS` of that countdown before it will mutate
anything:

```
BREAK_CUTOVER_PROOF_SECONDS     150
BREAK_ROLLBACK_RESERVE_SECONDS  135
BREAK_DEADLINE_SLACK_SECONDS      0
MIN_BREAK_REMAINING_MS      285,000
```

That leaves 15 seconds of entry slack, and the whole legacy sequence had to
fit inside it: `legacy_checkpoint_countdown` (>= 285,000 ms), the seal
predecessor read, `prove_rollback_readiness`, the helper's own entry
pre-check (`legacy-engine-checkpoint.sh`, >= 285,000 ms), the mixed-custody
contract prerequisite, the intent write, and then the publisher's bounded
work inside the container, where `legacy-engine-checkpoint-guard.mjs` pinned
`reserveMs = 285000` and re-checked it at every `checkMaintenance()` through
the checkpoint and readback stages. The publisher's own budget is explicit:
`legacy-engine-checkpoint.mjs` allows `workBudgetMs` up to 20,000 and
`cleanupBudgetMs` up to 5,000. Twenty-five seconds of bounded work cannot be
performed inside fifteen seconds of slack while every step of it demands
that the full fifteen seconds still remain.

### Run 35615604946

- The countdown was detected with the full 285,000 ms present, so entry was
  admitted.
- Countdown detection, the rollback-readiness proof and the helper preamble
  consumed 15.2 seconds before the guard's first `checkMaintenance()`.
- The guard's first check saw fewer than 285,000 ms remaining and refused
  with `insufficient_reserve`, before a single table was checkpointed.
- The transaction died at `legacy checkpoint or cleanup refused; release
cannot continue`, as it must once the checkpoint refuses, and the window
  was lost.

No amount of tuning the preamble changes this: even a zero-cost preamble
leaves 15 seconds for 25 seconds of budgeted work, and the guard's reserve
was checked again after each write.

## What changed

The publisher's 25 seconds are now written down and taken out of the
candidate-proof budget. They are not taken out of the rollback reserve.

`server/scripts/engine-release-transaction.sh`:

```
LEGACY_CHECKPOINT_BUDGET_SECONDS=25
LEGACY_MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS
  + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS
  - LEGACY_CHECKPOINT_BUDGET_SECONDS) * 1000))            # 260,000
```

`maintenance_certificate` now takes its minimum as an explicit first
argument, defaulting to the strict `MIN_BREAK_REMAINING_MS`. Exactly one call
site passes anything else: the read straight after the legacy checkpoint,
and only when `LEGACY_CHECKPOINT_ATTEMPTED=1`. Every other read, locked or
unlocked, ordinary or legacy-entry, still demands 285,000 ms. The refusal
after a checkpoint names the legacy reserve and the observed remaining time.

`server/scripts/legacy-engine-checkpoint-guard.mjs`: `reserveMs` is 260,000,
with the derivation in its header comment.

`server/scripts/legacy-engine-checkpoint.sh`: the entry pre-check keeps
285,000; the hand-off comment now says which figure the caller reads next.

### The arithmetic

```
entry minimum                      285,000 ms   (unchanged; must start here)
publisher work + cleanup budget   - 25,000 ms   (20,000 + 5,000, from .mjs)
post-checkpoint minimum            260,000 ms   (LEGACY_MIN_BREAK_REMAINING_MS)
rollback reserve inside it       - 135,000 ms   (unchanged)
candidate proof left               125,000 ms   vs 51-112 s measured in sealed runs
```

`break_proof_seconds` subtracts the fixed `BREAK_ROLLBACK_RESERVE_SECONDS`
from whatever certificate was accepted, so a 260,000 ms certificate gives
the candidate 125 seconds of proof and the rollback its full 135 seconds.
The smaller minimum shortens proof time and nothing else.

### What is NOT reduced

- `BREAK_ROLLBACK_RESERVE_SECONDS` stays 135. Recovery from a failed
  candidate keeps every second it had.
- `MIN_BREAK_REMAINING_MS` stays 285,000 for every ordinary release and for
  every legacy ENTRY check (`legacy_checkpoint_countdown`, the helper's
  pre-check). The sequence must still begin inside the entry slack; a late
  start is still refused before anything is written.
- The certificate's other predicates: `readyForRestart`, `unparkedTables`,
  durability, the in-flight-hands helper. The legacy minimum relaxes time
  only, and `tests/operations/engine-release-recovery-window.py` asserts a
  refusing certificate still refuses at 260,000.
- The one-shot rule: a checkpoint is still attempted at most once per run.

## Tests

- `tests/engine-release-break-recovery.law.test.ts` and
  `tests/engine-release-seal.law.test.ts` pin the two constants, the formula,
  260,000 and 125 > 112, and that the countdown never reads the legacy figure.
- `tests/unit/engineReleaseMaintenanceCertificate.test.ts` and
  `tests/operations/engine-release-recovery-window.py` run the real function:
  no argument refuses 284,999; `260000` accepts 260,000 and refuses 259,999.
- `tests/operations/engine-release-window-queue.py` runs the real pre-prepare
  queue through the legacy path with the helper stubbed and asserts the
  post-checkpoint read receives 260,000, the ordinary reads receive 285,000,
  and a 259,999 ms certificate after the checkpoint dies before prepare.
- `tests/legacyEngineCheckpointAdmission.test.ts` pins the branch that hands
  the legacy reserve over only after `LEGACY_CHECKPOINT_ATTEMPTED=1`.
- `tests/legacyEngineCheckpointGuard.test.ts` runs the real guard at 260,000
  (admitted, including the mixed 8825 profile) and 259,999 (refused).

## Still to settle, separately

The database side of the 8825 mixed-custody transfer
(`fn_f06_prepare_mixed_manager_custody`, last defined in migration
`20260919033536_...`) checks `break_ends_at - clock_timestamp() >= interval
'285 seconds'` at the instant of each RPC, and the guard calls that RPC in
its `mixed_custody` stage, after its first `checkMaintenance()`. For the
8825 profile that database predicate carries the same impossibility this
commit removes from the scripts, and `scripts/ci/probes/f06-mixed-custody.sql`
pins it at 284 seconds. It is a migration, it is outside this change, and it
is not touched here. Until it moves to the same 260-second figure, the 8825
checkpoint's custody RPC will still be refused by the database on the same
timeline; the 2f4/758/a0 profiles have no such RPC and are fully served by
this commit.
