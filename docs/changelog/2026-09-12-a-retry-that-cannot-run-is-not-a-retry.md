# A retry that cannot run is not a retry

2026-09-12

## The cascade, and which way it runs

`engine_recovery_events` carried three details in near-identical counts across
the same tables. They are one cascade, and the order is fixed. Every affected
`(table_id, hand_count)` triple, without exception:

```
authoritative_hand_semantic_refusal    t+0
post_hand_settlement_failed            t+0.3 .. +1.5s   \ two promise chains,
authoritative_hand_commit_not_proved   t+0.3 .. +1.5s   / either order
```

The refusal is the cause. `authoritative_hand_commit_not_proved`
(`ServerTableEngineSettlement.ts:2564`) and `post_hand_settlement_failed`
(`ServerTableEngineSettlement.ts:1458`) are both downstream of the same throw,
racing each other; they never appear without a refusal before them.

## What the refusal actually was

Not a semantic disagreement about the hand. Of 1,023 semantic refusals between
10:00 and 11:35Z, **1,021 carried one error**:

```
atomic hand commit refused (atomic_hand_rolled_back): F06_RETRY_CANONICAL_LANE
```

(971 as `atomic_hand_rolled_back`, 50 as `rolled_back` - two different
`EXCEPTION WHEN OTHERS` handlers catching the same raise.) The remaining two
were one `lease_proof_expired` and one `pldbgapi2 statement call stack is
broken`. **No rounding, denomination, pot-total, seat-set or winner-set reason
appeared at all**, and the function has explicit reasons for every one of them.

`smarter_private.f06_try_lane` raises it with `ERRCODE 40001`
(`serialization_failure`) before doing any work, so the transaction wrote
nothing. Checked against production: of 930 refused `(table_id, hand_number)`
pairs, **zero** had a `hand_atomic_commits` row and **zero** had a
`hand_history` row. No chips moved. What was lost was the hand.

## Both gates were shut, and closing one did not open the path

`aDatabaseThatAsksToBeRetriedIsRetried` (#4447, merged 11:27Z) found the two
gates and opened them: `isTransientDbError` now recognises SQLSTATE 40001, and
`hand_history` was given a budget of 2. Neither could take effect, because of
the ORDER the engine does two things in:

1. the `hand_history` step body catches the refusal and calls
   `killForRestart(...)`, which sets `terminal = true; running = false`
   **synchronously** (`ServerTableEngineBase.ts:3859-3860`), then rethrows;
2. `runStep` catches that throw and only then decides whether to retry. Its
   third condition is `!this.lifecycleCanMutate()`, and `lifecycleCanMutate()`
   returns `this.running && !this.terminal && ...`
   (`ServerTableEngineBase.ts:911`).

Step 1 guaranteed step 2 would refuse. The budget was spent before it could be
used: attempt 1 killed the engine, and attempt 2 was declined because the
engine was dead.

## The change

The commit catch now asks, before anything else, whether the database rolled
the whole hand back **and** gave a reason Postgres defines as "run it again".
If so it leaves untouched - no kill, no critical alert, no terminal loop phase

- and `runStep` re-runs the step. The step body above the call is pure, and
  every write it performs goes through one idempotent RPC keyed on
  `(table_id, hand_number)`.

Both halves are required. A rollback whose cause is a decision - a
conservation violation, a negative stack, a constraint, a fractional stack -
stays terminal on the first throw, and so does every refusal that was never a
rollback.

When the budget really is exhausted nothing has been softened: the throw
reaches `await lanes.record`, `authoritativeCommitSucceeded` is still false,
and `authoritative_hand_commit_not_proved` still kills the generation, with
the step's own `postHandTasks.hand_history_failed` critical alert beside it.
That is right - the loop must not deal from seats the database never accepted.

## What this does not fix

The engine is now doing the best thing available to it with a refusal it
should never have received. The refusal itself is a database defect and it is
still there.

`smarter_private.f06_try_lane(t)` demands **G shared + T(id) exclusive** - the
lock signature of a _rolling per-tournament authority_
(`fn_ca_lock_settlement_lane_for_tournament`). The accepted-hand settlement
path holds **B shared + T(id) shared**
(`fn_ca_share_settlement_lane_for_table`), deliberately, so that sibling tables
of one tournament can settle concurrently, and it takes no G at all. So the
platform's highest-frequency legitimate writer of `table_seats` and
`tournament_players` is classified by that guard as a rogue direct row writer,
and gets through only when a same-transaction lock upgrade happens to be
grantable. It fails in two ways:

- any terminal authority anywhere on the platform holding **G exclusive**
  fails the `pg_try_advisory_xact_lock_shared(G)` for every tournament at
  once. Measured: 18 refusals across **18 unrelated tournaments in one
  second** (11:24:40Z, and again at 11:09:32Z). Per-tournament contention
  cannot produce that;
- a sibling table of the same tournament holding **T(id) shared** blocks the
  exclusive request on T(id).

It reaches the hand only through the seat writes a **bust** performs -
`fn_ca_settle_hand_stacks_absolute` line 634 (`UPDATE table_seats SET
left_at = ...`) and `fn_ca_commit_hand_settlement_before_lease_generation`
lines 211/282 (`UPDATE tournament_players`). Those are the only writes in the
settlement path that touch a column the triggers watch, which is why the rate
tracks busts and concurrency rather than hands.

Fixing that predicate belongs to the F06 / table-break lane; the migration
that installed these triggers (`20260912100322_tournament_break_original_
custody_and_hand_authority`, applied to production at 10:03:22Z) is on commit
`d524e5a03a`, which is on no branch and is not merged to `main`.

## How much this recovers, measured

How long a lane stays contended, measured over 10:04-11:35Z by grouping the
seconds carrying a refusal into consecutive runs: **195 bursts - 135 of 1s, 37
of 2s, 18 of 3s, 2 of 4s, 3 of 5s** (p50 1s, p90 2s, p97 3s, max 5s).

The existing schedule (budget 2, backoff `[250, 1_000]`) puts attempts at
t=0, 0.25s and 1.25s, which outlives **135 of 195 bursts (69%)**. The
remaining ~31% will still exhaust and kill. Raising the budget would close
more of it, but `aDatabaseThatAsksToBeRetriedIsRetried` pins that backoff array
exactly, and CLAUDE.md 10.8 says an agent does not overrule another written law
on its own authority. The measurement is recorded here so the owning law can be
amended deliberately, or - better - so the `f06_try_lane` predicate is fixed
and the retry stops being needed.

## Money

No. Every check, on production:

- 930 refused `(table_id, hand_number)` pairs: 0 `hand_atomic_commits` rows,
  0 `hand_history` rows;
- 51,349 commits in 3 hours: 0 duplicate `(table_id, hand_number)`, 0
  duplicate `hand_id`, 0 duplicate `hand_history`;
- `ca_drift_incidents` on any refusing table in 4 hours: 0;
- `table_seats` on refusing tables with `stack = 0` and `left_at IS NULL`
  (a bust whose vacate was rolled back): 0;
- the platform's own conservation sweep reached the same conclusion at
  10:52:00Z, `discrepancy_amount` 0: "A refusal rolls the hand back whole
  before any money step, so no chips move; what is lost is the hand."

## Players

None. No human profile has been seated at any table in the last 24 hours: 0
humans seated now, 0 seated in 24h, 780 horses seated. Across the 513 affected
tables, 741 distinct horses and **0 distinct humans**. The method finds humans
(199 non-horse profiles exist); there were none to find.
