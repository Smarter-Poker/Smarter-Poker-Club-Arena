# The permit ledger outlives the hand (and the 1,139,125 was not a leak)

2026-09-25. `smarter_private.f06_hand_permits` in state `reserved` or
`accepted` was reported at **1,139,125**, against roughly **685** on
2026-09-21 - a 1,600x jump in four days, in a table that gates dealing. This
is the measurement, the verdict, and the one thing that needed writing down.

## Verdict: not a leak. The comparison was between two different things.

| state               | rows      | what it is                                           |
| ------------------- | --------- | ---------------------------------------------------- |
| `accepted`          | 1,138,606 | **terminal success.** One hand, dealt and committed. |
| `aborted_unsettled` | 527       | terminal, by receipt                                 |
| `reserved`          | 524       | **the only open state**                              |
| `never_started`     | 372       | terminal, by receipt                                 |

`accepted` is written by the trigger `zzzz_f06_accepted_hand` on
`public.hand_atomic_commits` the instant a hand's `post_commit_completed_at`
lands, and `public.fn_f06_finish_hand` then refuses to move it ever again
(`F06_CHANGED_HAND_OUTCOME`). It is a permanent receipt, not work in progress.
Counting it as "open" compares a receipt ledger against a work queue, and
99.95% of the 1,139,125 is receipts.

**It is organic, not a backfill.** `pg_stat_user_tables`: `ins=1,140,433`,
`upd=1,140,224`, `del=0`. Decisively, `count(*) = count(DISTINCT xmin)`
_exactly_ in both halves of the population (455,442/455,442 and
683,164/683,164): every row was written by its own transaction, one per hand.
The population runs continuously back to the subsystem's first hand at
**2026-09-18 02:03:22 UTC**, so several hundred thousand `accepted` rows
already existed on 2026-09-21. The ~685 baseline was never the same number.

Creation rate over the 7.45-day life of the table: **1,138,606 accepted /
~6,400 per hour average**, with the first 20 hours the densest (455,442 rows,
~22,400/hour) and the rate tracking tournament volume thereafter.

## Why `del=0` is the design, and the part nobody had written down

`public.fn_f06_begin_hand` refuses to re-use a hand number on a table
(`hand_number_already_used`) if **any of three witnesses** still says it was
used: the permit, `hand_atomic_commits`, or `hand_history`. Two of those three
are pruned - `public.sp_prune_hand_history` deletes **both** at
`hand_history_retention_policy.horse_retention_days`, eight days by Dan's
instruction of 2026-09-17.

So eight days after a hand is dealt, **the permit is the only surviving record
that its hand number was ever used.** Measured today: 0 permits had yet lost a
commit or history row, and the first crossing was **12.4 hours away, at
2026-09-26 02:03:20 UTC**. From that moment the ledger is load bearing.

A retention policy on permits - the obvious answer to 44 MB/day of unbounded
growth - would therefore let a hand number be re-issued on a table that has
already dealt it, on a platform where `(table_id, hand_number)` is the key
every settlement, rake attribution and custody proof is filed under. It would
also wedge player movement: `smarter_private.f06_movement_permits` requires
that "every permit this table ever held must be DECIDED before its players
move" and refuses an `accepted` permit whose commit row is absent.

This is pinned by `tests/the-permit-ledger-outlives-the-hand.law.test.ts`. If
the storage bill ever has to be paid, the answer is an archive that keeps
`(table_id, hand_number, state)` for ever, or Dan's decision to allow hand
number re-use. It is not a `DELETE`.

## Consequences, measured rather than assumed

- **No hot query scans it.** 45,862,493 index scans against 413 sequential.
  `f06_hand_dispatch_guard` looks the permit up on the unique
  `(table_id, hand_number)`; it is O(log n) and unaffected by the row count.
- **Per-table fan-out is small.** `f06_movement_permits` aggregates every
  permit a table ever held, but the widest table in the whole ledger holds
  **443** (p50 35, p95 95, p99 180, zero tables over 1,000) across 27,463
  tables, because a tournament table lives hours.
- **Growth is storage only:** 326 MB / 1.14M rows / 7.45 days, about 44 MB/day.
- **No money exposure from the `accepted` bulk.** It is a record of hands that
  were paid correctly.

## The real defect in the open set (already fixed, awaiting the engine)

The open set is capped at one permit per table by the unique partial index
`f06_one_hand ON (table_id) WHERE state = 'reserved'`, so it cannot be the
source of unbounded growth. But it is not healthy:

- **492 of the 524** reserved permits carry a **dead lease generation**. Zero
  of them are on a live table.
- Age: **523 older than one day**, oldest reserved since **2026-09-18 13:15**.
  Only 8 were genuinely in flight.
- They wedge **492 live tables** holding **2,061 seated players** (2,060
  horses, 1 human - horses are players, 10.5) and **14,210,568 chips**.
  `fn_f06_begin_hand` returns `hand_permit_unresolved` and the table can never
  deal again.
- Root cause: both terminalization paths require the _original_ generation on
  purpose - `fn_f06_cancel_prepared_hand` ("A successor lease cannot certify
  the original process's local non-actuation") and
  `fn_f06_finish_hand(never_started)`. When the engine restarts, the
  generation dies and nothing could certify the non-start.
- Only **1 of 492** overlaps the 162 non-terminal `f06_operations`, so this is
  a separate population from the break incident.

**The root fix is already merged.** `fn_f06_abort_abandoned_generation` (DB
side applied to production 2026-09-22) lets the _adopting_ generation decide a
dead one's hand, and the engine call landed on `main` on 2026-09-24 as
**#5163** (`4e688410a6`, `server/src/tournament/abandonedGenerationDoor.ts`
plus `TournamentManagerBase.ts:5667`). Nothing structurally blocks it: of the
492, none is blocked by pending mixed custody, an already-aborted generation,
or a newer permit.

It is not running because **the live engine is `8825af51`, 276 commits behind
`main`, and `abandonedGenerationDoor.ts` does not exist in that build.** The
engine's own `/health` names the condition: `unparkedReasons
{f06_preparation_unresolved: 1}`. So no new code was written here - a second
fix would duplicate #5163, and a sweep is forbidden outright (10.12). This
drains when the cutover lands.

## One thing for whoever lands that cutover

The 492 wedged tables hold **10,931 `accepted` permits** whose hands are
horse-only and therefore prunable at eight days. `sp_prune_hand_history`'s
guard (`f06_hand_cards_unresolved`, migration 20260920232341) protects only the
_unresolved_ hand's own `(table_id, hand_number)` - and that hand never
started, so it has no history row to protect. The already-dealt `accepted`
hands on those tables are not covered. If a wedged table's hands are pruned
while it is still wedged, `f06_movement_permits` will refuse it for ever and
the wedge becomes unrecoverable.

Measured, so this is a watch item and not an alarm: **0 are past eight days
today, 5 cross within 24 hours**, and the prune cron
(`sp_prune_hand_history_10m`) is currently **failing on every run** (13:13,
13:23, 13:33 UTC), so nothing is progressing. It stops mattering entirely once
the engine deploys and the permits terminalize.

## No new alert

There is already a reader, already derived from the live series, already
corrected: `EngineCannotBeReplaced` in `infra/monitoring/alert-rules.yml`
(threshold `>= 6` consecutive uncertified breaks, from the 30-day run-length
distribution) and its annotation names `f06_preparation_stuck` in
`unparkedReasons` explicitly. Adding a permit-count rule would duplicate
better-reasoned coverage, and a rule against a series the frozen engine does
not publish is quiet because it cannot see, not because things are well
(10.86 rule 2, and the correction already recorded in that file on
2026-09-21).
