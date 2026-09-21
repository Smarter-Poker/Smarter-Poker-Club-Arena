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

The checkpoint's whole cost - the ~15 seconds of entry the run measured AND
the publisher's 25 seconds - is now written down and taken out of the
candidate-proof budget. It is not taken out of the rollback reserve.

`server/scripts/engine-release-transaction.sh`:

```
LEGACY_CHECKPOINT_BUDGET_SECONDS=40
LEGACY_CHECKPOINT_WORK_MS=25000                            # 20,000 + 5,000
LEGACY_MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS
  + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS
  - LEGACY_CHECKPOINT_BUDGET_SECONDS) * 1000))            # 245,000
LEGACY_ENTRY_ALLOWANCE_MS=$((LEGACY_CHECKPOINT_BUDGET_SECONDS * 1000
  - LEGACY_CHECKPOINT_WORK_MS))                            # 15,000
```

(The first cut of this commit budgeted 25 seconds and read 260,000 ms. That
left the ~15 s entry to fit inside the 15 s the break has above 285,000 ms,
which is the same impossibility one gate later; see "Reconciled with PR
#5026" below. Nothing carrying 260 was ever installed.)

`maintenance_certificate` now takes its minimum as an explicit first
argument, defaulting to the strict `MIN_BREAK_REMAINING_MS`. Exactly one call
site passes anything else: the read straight after the legacy checkpoint,
and only when `LEGACY_CHECKPOINT_ATTEMPTED=1`. Every other read, locked or
unlocked, ordinary or legacy-entry, still demands 285,000 ms. The refusal
after a checkpoint names the legacy reserve and the observed remaining time.

`server/scripts/legacy-engine-checkpoint-guard.mjs`: `reserveMs` is 245,000,
with the derivation in its header comment.

`server/scripts/legacy-engine-checkpoint.sh`: the entry pre-check keeps
285,000, written as `245000+40000` (the guard's reserve plus the whole budget
that follows the probe); the hand-off comment says which figure the caller
reads next.

### The arithmetic

```
entry minimum                      285,000 ms   (unchanged; must start here)
entry allowance                   - 15,000 ms   (measured: 4.7 + 5.3 + 5.2 s on
                                                 run 35615604946, then the intent
                                                 write and the guard's own boot)
publisher work + cleanup budget   - 25,000 ms   (20,000 + 5,000, from .mjs)
post-checkpoint minimum            245,000 ms   (LEGACY_MIN_BREAK_REMAINING_MS,
                                                 = reserveMs in the guard)
rollback reserve inside it       - 135,000 ms   (unchanged)
candidate proof left               110,000 ms   vs 51-112 s measured in sealed runs
```

`break_proof_seconds` subtracts the fixed `BREAK_ROLLBACK_RESERVE_SECONDS`
from whatever certificate was accepted, so a 245,000 ms certificate gives
the candidate 110 seconds of proof and the rollback its full 135 seconds.
The smaller minimum shortens proof time and nothing else.

**The trade-off, stated plainly.** Sealed runs have measured the candidate
proof at 51-112 seconds. 110 seconds covers most of that range but not the
top of it: a proof that overruns 110 seconds no longer seals in that break;
`assert_break_proof_time` refuses, and the transaction rolls back within the
untouched 135-second reserve and waits for the next break. That is the cost
of a checkpoint that can actually finish, and it is paid by the candidate's
proof, never by the rollback.

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
  refusing certificate still refuses at 245,000.
- The one-shot rule: a checkpoint is still attempted at most once per run.

## Tests

- `tests/engine-release-break-recovery.law.test.ts` and
  `tests/engine-release-seal.law.test.ts` pin the two constants, the formula,
  245,000 and 150 - 40 = 110, and that the countdown never reads the legacy
  figure.
- `tests/unit/engineReleaseMaintenanceCertificate.test.ts` and
  `tests/operations/engine-release-recovery-window.py` run the real function:
  no argument refuses 284,999; `245000` accepts 245,000 and refuses 244,999.
- `tests/operations/engine-release-window-queue.py` runs the real pre-prepare
  queue through the legacy path with the helper stubbed and asserts the
  post-checkpoint read receives 245,000, the ordinary reads receive 285,000,
  a 244,999 ms certificate after the checkpoint dies before prepare, a helper
  exit of 75 releases the lock and enters again on the next countdown, and a
  75 that left an intent behind dies.
- `tests/legacyEngineCheckpointAdmission.test.ts` pins the branch that hands
  the legacy reserve over only after `LEGACY_CHECKPOINT_ATTEMPTED=1`.
- `tests/legacyEngineCheckpointGuard.test.ts` runs the real guard at 247,000
  (admitted, including the mixed 8825 profile) and 244,999 (refused).
- `tests/the-release-enters-the-break-with-time-to-finish.law.test.ts` (PR
  #5026's law, rewritten to this contract) pins the ladder end to end.

## Still to settle, separately

The database side of the 8825 mixed-custody transfer
(`fn_f06_prepare_mixed_manager_custody`, last defined in migration
`20260919033536_...`) checks `break_ends_at - clock_timestamp() >= interval
'285 seconds'` at the instant of each RPC, and the guard calls that RPC in
its `mixed_custody` stage, after its first `checkMaintenance()`. For the
8825 profile that database predicate carries the same impossibility this
commit removes from the scripts, and `scripts/ci/probes/f06-mixed-custody.sql`
pins it at 284 seconds. It is a migration, it is outside this change, and it
is not touched here. Until it moves to the same 245-second figure, the 8825
checkpoint's custody RPC will still be refused by the database on the same
timeline; the 2f4/758/a0 profiles have no such RPC and are fully served by
this commit.

### Settled: migration 20260921155216

`supabase/migrations/20260921155216_the_mixed_custody_prepare_accepts_the_legacy_checkpoint_rese.sql`
replaces `fn_f06_prepare_mixed_manager_custody` with the byte-exact
`20260919033536` text carrying `interval '245 seconds'` in place of `'285
seconds'`, the only literal in the body, in one transaction with a pre-image
guard (body md5 `3f78b42bcc2455701322b172ab7d42ff`, definition md5
`ca0446a62e08d49c2d318072cf465176`, owner, ACL, search_path, SECURITY
DEFINER, VOLATILE) and a post-image guard (body md5
`30ad38da71405fdc960599802310e662`, definition md5
`4f20f5a2f6d7249578931bc877869981`, same identity, and the proof that putting
'285 seconds' back reproduces the pre-image digest; both computed on a scratch
PostgreSQL 17.11 cluster that reproduced the pre-image digests byte for byte
first). No other function in
`supabase/migrations/` pins 285 s: the three earlier occurrences are earlier
versions of this same function, already replaced. The native shared-hand-lane
qualification installs the migration on its clone after `20260921040823`,
asserts the post-image digests, proves 244 s remaining is refused and 245.5 s
admitted, and the publisher's `MIXED_CUSTODY_CONTRACT` and
`tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json` were
regenerated from its catalogue (1517 cases, `publisherCatalogEquality: true`).
`scripts/ci/probes/f06-mixed-custody.sql` now reads the installed reserve from
the function body and proves one second under it refuses and half a second
over it is admitted, so it is exact for the 285 s authority the drained-custody
lane installs and for the 245 s one. Install the migration in production before
the release whose publisher carries the new catalogue runs its contract check.

## Reconciled with PR #5026 ("enter the break with time left to finish, and defer a miss")

PR #5026 merged to main against the same run with a different answer: keep
every reserve at 285,000 ms, add a measured entry budget to the ADMISSION
threshold (`legacy_checkpoint_countdown` demands 285,000 + up to 15,000 after
a miss; the helper's probe demands 285,000 + a 1,500-9,000 ms boot term), and
turn a late arrival into a deferral (helper exit 75, honoured only after the
transaction proves from the filesystem that no intent exists, then
`LEGACY_CHECKPOINT_ATTEMPTED=0` and a later countdown).

The deferral is right and is kept. The ladder's top rung is not satisfiable:
the countdown is 300,000 ms and the entry costs ~15,000 ms of it before the
guard's first read, so a threshold above 285,000 is met only at t=0 and every
break defers for ever. The reconciled contract, now in the scripts:

```
admission   legacy_checkpoint_countdown   >= 285,000 + headroom, ceiling 0
probe       legacy-engine-checkpoint.sh   >= 245,000 + 40,000 = 285,000
guard       reserveMs                     >= 245,000 at every check
after       maintenance_certificate       >= 245,000, only once attempted
```

- The headroom argument, the timing of `prove_rollback_readiness` and the
  doubled feed-forward all survive; the clamp is now
  `BREAK_ENTRY_BUDGET_CEILING_MS = BREAK_WINDOW_MS - MIN_BREAK_REMAINING_MS -
LEGACY_ENTRY_ALLOWANCE_MS = 300,000 - 285,000 - 15,000 = 0`. The
  measurement is logged against the allowance instead of being demanded.
- The helper still measures its node runtime check (the guard-boot proxy)
  and reports it; nothing is added to the probe's threshold.
- Exit 75, the intent-absent proof, the reset of the one-shot flag and
  `EngineReplacementWatchdogBlind` are unchanged from #5026.
- PR #5026's law test and `docs/laws.d` entry are rewritten to this contract
  and its changelog carries the same note.
