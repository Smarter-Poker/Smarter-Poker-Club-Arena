# The hand-number lock is shared above the floor (2026-09-26)

Migration `20260926131732_the_hand_number_lock_is_shared_above_the_floor`.
Law `tests/the-hand-number-lock-is-shared-above-the-floor.law.test.ts`.
Concurrency harness `scripts/ci/probes/hand-number-lock/concurrency.sh`.

## What was wrong

Every hand start in the fleet gets its number from
`smarter_private.f06_allocate_number_above(floor)` (called by
`fn_f06_allocate_hand_number` and `fn_next_hand_number`). It began with an
EXCLUSIVE, transaction-scoped advisory lock on
`hashtextextended('f06:global-hand-number-allocation',0)`. The allocation is
the last statement of its transaction, so the lock was held through the
commit flush: one slow commit held every other hand start in the fleet. The
function has `lock_timeout=2s`, so each waiter past two seconds was a refused
hand start.

PR #5327 named it as the serializer left after the NOTIFY detach (#5318).
Nobody else owned it: `f06-owner-a` is on the bystander/late-commit clock
migration and `f06-owner-d` on voiding two retired mixed-custody events;
neither touches this function.

## Measured before

`postgres_logs`, `log_lock_waits` with `deadlock_timeout` 1 s. The lock's key
in the log is `[5,4157936768,3423481551,1]` (database 5, the two halves of
`hashtextextended('f06:global-hand-number-allocation',0)` =
-588541632890130737). Waits over 1 s on that key, and all lock timeouts, per
five minutes on 2026-09-26:

| bucket (UTC) | waits > 1 s       | lock timeouts                 |
| ------------ | ----------------- | ----------------------------- |
| 07:25        | 496               | 93                            |
| 07:45        | 798               | 75                            |
| 08:00        | 126               | 40                            |
| 09:15        | 546               | 147                           |
| 09:25        | 860               | 408                           |
| 09:35-13:15  | 0 in every bucket | 0-6 (none on this key's path) |

The zero since 09:35 is not a recovery: at 09:33:30 473 tournament managers
were quarantined (the hourly collapse #5317 is fixing) and the fleet fell from
~27k to 8-14k hands an hour. The lock is not what starts a brownout; it is what
turns one slow commit into a platform-wide refusal of hand starts.

## Why the lock exists

`nextval` never returns a value twice and, with `CACHE 1` and `NO CYCLE`,
only moves forward. The only way the sequence moves backward is `setval`: a
caller whose `nextval` came back below its floor sets the sequence to the
floor. If other allocations ran between that caller's `nextval` and its
`setval` and passed the floor, the `setval` would rewind the sequence under
numbers already issued. That interleaving is the whole reason for the lock.

Read on production at 13:14 UTC: the function is the only routine whose source
names `global_hand_number_seq`, no column default names it, and only
`postgres` holds USAGE on it (`service_role`, `anon`, `authenticated`: SELECT
only). The migration's preimage block refuses to install if any of that
changes; run read-only against production it raised its own success marker.

## The change

Read `last_value` first.

- At or above the floor: take the lock SHARED and call `nextval`. Shared
  holders never wait on one another. The result cannot be below the floor
  because nothing can move the sequence backward while a shared holder is
  present; should it be anyway, the function refuses
  `F06_HAND_NUMBER_UNSAFE` rather than return it.
- Below the floor: the original path, unchanged, under the EXCLUSIVE lock
  (`ALTER SEQUENCE ... CACHE 1` barrier, `nextval`, `setval` to the floor).

Owner, ACL, `SECURITY DEFINER`, search_path and `lock_timeout` are unchanged.

## The invariant

1. `setval` runs only under the exclusive lock, only when `n < floor`, and
   sets the sequence to `floor > n`. No other allocation can run between that
   `nextval` and that `setval`, so the sequence only moves forward.
2. So no number is issued twice.
3. A table passes `floor = GREATEST(1000000, used_hand_number_max + 1)`, and
   both paths return `n >= floor`, so a table is never issued a number at or
   below one it dealt.
4. Reading `last_value` before taking the lock is safe because by (1) it only
   grows.

## Proved under real concurrency

`concurrency.sh` builds a throwaway PostgreSQL 17.11 cluster in `/tmp`, installs
the function exactly as a migration file writes it, and runs pgbench with 48
clients x 400 transactions. Each client is a "table" asking for a number above
its own high-water mark. One ask in 25 puts the floor above the global sequence,
which forces the `setval` path while the others allocate. It counts duplicates
and numbers below their floor:

| variant                       | what it is                                                   | allocations      | duplicates | below floor | setval path | per second |
| ----------------------------- | ------------------------------------------------------------ | ---------------- | ---------- | ----------- | ----------- | ---------- |
| preimage + 2 ms commit stall  | the 2026-09-12 definition                                    | 19,200           | 0          | 0           | 0           | 393        |
| installed + 2 ms commit stall | this migration                                               | 19,200           | 0          | 0           | 117         | 3,791      |
| installed                     | this migration                                               | 19,200           | 0          | 0           | 10          | 12,127     |
| widened                       | + 5 ms between `nextval` and `setval`, ALTER barrier removed | 19,200           | 0          | 0           | 14          | 3,366      |
| regression (planted)          | widened, exclusive lock made shared                          | 10,106 (aborted) | **8,085**  | 0           | 3,450       | -          |

- **The stall rows show the fix.** Under the same 2 ms commit stall, the old
  exclusive lock caps allocation near one per stall (393/s). The shared path
  runs at 3,791/s with no duplicate.
- **The widened row is the proof.** It leaves a 5 ms gap between `nextval` and
  `setval` and removes the `ALTER SEQUENCE` barrier, whose ACCESS EXCLUSIVE
  lock would otherwise hide a missing advisory lock. Only the advisory lock
  guards the gap, and it still produced no duplicate.
- **The regression row proves the harness can fail.** It planted the defect by
  putting `setval` under the shared lock, and got 8,085 duplicates. The
  shared branch's own refusal also fired (`F06_HAND_NUMBER_UNSAFE`) on clients
  that read a rewound sequence.

The law pins the same rules statically against the latest migration that
defines the function, and six planted regressions each fail it: the whole
function back on the exclusive lock, `setval` under the shared lock, a
`setval` inside the shared branch, an unrefused below-floor result, `nextval`
before the lock, and a session-level lock.

## What it does not change

The rare `setval` path still takes the exclusive lock, and an exclusive
request that is waiting queues new shared requests behind it. That path runs
only when a table's high-water mark is above the global sequence. Every
F06 hand number comes from this sequence, so it has not fired on the live
fleet; when it does, it costs that one allocation, not the fleet.

## Applied, and what it changed

Recorded after `apply-merged-migration.yml`: see the PR thread.
