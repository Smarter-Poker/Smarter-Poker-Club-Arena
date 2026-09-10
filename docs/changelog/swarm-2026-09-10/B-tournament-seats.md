# B - tournament seat stack writes (table_seats triggers)

Workstream B, 2026-09-10 03:00-03:25 UTC, production, all probes rolled back
(every DO block ended in RAISE EXCEPTION; none returned success). No DDL run.

## What the settlement actually writes

`fn_ca_commit_hand_settlement -> _exact_before_obligations -> _before_lease_generation -> fn_ca_settle_hand_stacks_absolute`:

```
UPDATE public.table_seats ts SET stack = v_target
 WHERE ts.id = (e->>'seat_id')::uuid AND ts.joined_at = ... AND ts.table_id = p_table_id
   AND ts.user_id = v_uid AND ts.left_at IS NULL;
```

Stack only. There is no `updated_at` column on table_seats. Two other seat
writes happen in the same transaction: `fn_ca_commit_hand_settlement` sets
`time_bank_uses_remaining, time_bank_remaining` per player in `time_banks`
(one UPDATE per seat, before the stack write), and busted seats get the
left_at/status vacate UPDATE (out of scope: that is a seat exit). So per hand
each seat row is typically written TWICE (time bank, then stack).

Probe seat: 950e0a2d-6053-4627-b20c-28592411c6ce (RUNNING tournament
3e19d91c, receipt completed, stack 1031, club a0000000-...-0001). Earlier
probes on 4fab4d0e (tournament 254fd205) gave the same numbers; that tournament
completed mid-run and `terminal_tournament_seat_is_immutable` refused the
probe write, as designed.

## Before: `UPDATE table_seats SET stack = stack + 1` on a live RUNNING tournament seat

13 of the 35 triggers fire on a stack-only UPDATE (the rest are INSERT/DELETE
only or carry `UPDATE OF` lists that exclude stack). Ten executions in one
session:

| run | exec ms | trigger ms | aa_proof_lock | zz_freeze_guard | terminal_immutable | retired_club | cancelled_immutable | no_live_seat_finished | RI x3 |
|---|---|---|---|---|---|---|---|---|---|
| 1 cold | 19.39 | 18.66 | 6.99 | 3.92 | 2.22 | 2.14 | 1.29 | 0.76 | - |
| 2 | 6.03 | 5.85 | 1.19 | 0.94 | 0.58 | 0.30 | 0.27 | 0.33 | 1.96 |
| 3-5 | 4.18-4.30 | 4.06-4.17 | 1.09-1.16 | 0.89-0.91 | 0.55-0.60 | 0.30-0.33 | 0.26 | 0.36-0.40 | 0.26-0.29 |
| 6 (plans flip) | 5.93 | 5.78 | 1.90 | 0.50 | 1.67 | 0.31 | 0.44 | 0.38 | 0.27 |
| 7-10 steady | 1.78-2.18 | 1.67-2.06 | 0.93-1.01 | 0.38-0.39 | 0.08-0.11 | 0.06-0.07 | 0.06-0.07 | <0.05 | 0-0.29 |

Remaining triggers (stamp_sit_out_at, stamp_seat_occupancy, clear_sitout,
seat_parent_keys_match, stamp_club, stamp_active_seat_game_scope 0.11,
require_live_seat_parent 0.10) total ~0.3 ms in runs 3-5 and <0.1 ms steady.

Two things the table shows:

1. Runs 2-5 are the PL/pgSQL "custom plan" phase (first five executions of
   each statement per backend). At run 6 every statement except one adopts
   its generic plan and the write drops from ~4.2 ms to ~1.8 ms. The engine's
   pooled connections live in the steady state, so 1.7-2.1 ms is the
   representative tournament-seat write today, not 4.2 ms; a fresh backend
   pays the 4-6 ms phase for its first five seat writes.
2. `aa_tournament_live_seat_proof_lock` does NOT drop: 0.93-1.19 ms in every
   warm run. It is 55-60% of steady-state trigger time on a tournament seat.
   `zz_freeze_guard` is the next 20-23%. Those two are 78-82%; adding the
   three 0.06-0.08 ms guards covers 92%.

The `time_bank` two-column write (same seat, 5 runs): 16.65 ms cold, then
7.85 / 2.54 / 2.17 / 2.11 ms. `aa_proof_lock` exits on its first IF there
(0.02 ms); `zz_freeze_guard` exits on its column list (0.09 ms).

The `RI_ConstraintTrigger_c_*` rows (FKs on user_id->profiles,
table_id->tables, club_id->clubs) fire only from the SECOND write of the same
row inside one transaction (Postgres re-checks FKs on a row its own
transaction already modified). That is exactly the settlement shape: time-bank
UPDATE then stack UPDATE. Cost: 0.25-0.3 ms warm, 1.6-5.2 ms when the profiles
FK check is cold.

## Why aa_tournament_live_seat_proof_lock stays at ~1 ms: it re-plans every call

Inside the function the proof-open test is

```
WHERE t.id = ANY(v_ids)   -- v_ids uuid[] = {old_tid,new_tid}
```

The query itself is 0.03 ms (index scan on tournaments_pkey, nested loop to
tournament_launch_receipts_pkey; generic plan verified with
`plan_cache_mode = force_generic_plan`). But PL/pgSQL never chooses that
generic plan: with an array parameter the generic estimate is 10 rows /
cost 26.4 against a ~8-cost custom plan, so it keeps planning a custom plan
on every execution. Measured in a DO block (same SPI plan-cache logic as a
function), 12 executions each, ms per execution:

```
t.id = ANY(v_ids)                 5.88  0.99 0.92 0.92 0.92 1.76 0.90 0.87 0.86 0.83 0.85 0.86
(t.id = v_old OR t.id = v_new)    0.98  0.80 0.77 0.75 0.75 0.89 0.034 0.028 0.026 0.025 0.026 0.026
t.id = v_single                   0.99  0.78 0.76 0.79 0.78 0.74 0.023 0.055 0.035 0.026 0.019 0.040
tables PK lookup (reference)      2.26  0.016 0.011 0.010 0.010 ...
```

The OR form is re-planned five times like everything else, then runs at
0.026 ms forever. The array form is re-planned forever at 0.83-0.99 ms.

## Proposed change (one CREATE OR REPLACE, in B-tournament-seats.sql)

**trg_lock_and_validate_tournament_live_seat**: replace `t.id = ANY(v_ids)` in
the proof-open EXISTS with `(t.id = v_old_tournament_id OR t.id = v_new_tournament_id)`.
Nothing else changes; `v_ids` is still built and still passed to
`fn_lock_tournament_launch_proof_parents`.

Equivalence, every TG_OP:
- INSERT: v_ids = {new}; v_old is never assigned (NULL). `t.id = NULL` is NULL,
  `NULL OR (t.id = new)` is true exactly when t.id = new, otherwise NULL, which
  WHERE discards. Same rows as `= ANY({new})`.
- DELETE: symmetric with v_new NULL.
- UPDATE: v_ids = {old,new}; `t.id = ANY(ARRAY[old,new])` is by definition
  `t.id = old OR t.id = new`. NULL elements behave identically in both forms.
- The both-NULL case never reaches this statement (cash early exit above it).
- Locking (`fn_lock_tournament_launch_proof_parents`), the roster check, and
  the live-acquisition branch are untouched: the same v_proof_open value is
  computed, so the same branch is taken on every row.

Expected: aa_proof_lock 0.93-1.19 ms -> ~0.1-0.15 ms on every tournament seat
stack write (the tables PK lookup, the EXISTS at 0.026 ms, and PL/pgSQL
overhead remain). Per seat write: -0.85 ms warm. Per tournament hand at the
current 5.71 live seats per RUNNING table: about -4.9 ms of the ~10 ms
steady-state seat-trigger cost (-50%). At ~230 tournament hands/min that is
~1.1 s of backend CPU per minute. The same statement also runs on every
tournament seat INSERT, DELETE, seat move and left_at change, all of which get
the same saving. Cold first call is unchanged (one planning pass either way).

Trigger-level alternative: none. The trigger is `BEFORE INSERT OR DELETE OR
UPDATE` with no column list and stack changes are intentionally in scope (its
first IF returns only when stack is unchanged). An `UPDATE OF` list would have
to include stack and would not help.

## On the proof-open check itself (task 3)

Is it needed for a stack change on a RUNNING tournament with a completed
receipt? The check is the only thing that establishes "receipt completed":
nothing structural forces RUNNING => receipt completed (no trigger on
tournaments or tournament_launch_receipts ties status to completed_at;
`zz_freeze_launch_guard` and `tournament_launch_receipt_is_immutable` do not).

Counts now: 82 RUNNING tournaments, 82 with a completed receipt, 0 with no
receipt, **0 with an incomplete receipt** (proof open). 127 incomplete receipts
exist in total: 109 on REGISTERING tournaments, 17 on CANCELLED, none on
RUNNING. 155 of 341 REGISTERING tournaments have live seats, so a seat write
while the proof is open is a real path (pre-launch seating), and on that path
the trigger does real work (NOWAIT lock on the receipt, FOR UPDATE on the
tournament, roster refusal). I cannot prove a stack change never happens on
that path, so I do not propose skipping the check. The re-plan fix above
makes the check cost 0.03 ms, which removes the reason to want to skip it.

## Triggers read and deliberately left alone

- **zz_freeze_guard (fn_refuse_while_frozen('stack','left_at','sit_out_at'))**,
  0.38-0.39 ms steady, 0.9 in custom-plan phase, 3.9 cold. Stack is on its
  column list on purpose: this is the maintenance-break freeze. The whole cost
  is `fn_platform_frozen()` (0.83-1.0 ms as a standalone call, EXISTS over an
  empty `engine_maintenance_break` plus `fn_active_maintenance_release_boundary()`
  which does auth.role(), a pg_roles join and a scan of engine_maintenance_thaws,
  0.27-0.66 ms). Not a table_seats early-exit candidate; it runs on every cash
  and tournament stack write (~2,500 calls/min at 420 hands/min x ~6 seats).
  Flagging for whoever owns the freeze machinery: making `fn_platform_frozen`
  cheap (e.g. a single-row flag) is worth ~0.35 ms per seat write platform-wide.
- **terminal_tournament_seat_is_immutable**, 0.08-0.11 ms steady. On a
  stack change it must look up tournament status: it refuses stack writes on a
  COMPLETED/CANCELLED receipted tournament (it did exactly that to my first
  probe seat when its tournament finished). Reordering the three receipt
  EXISTS behind the status test would be equivalent but saves <0.05 ms now.
- **trg_guard_retired_club_mutation**, 0.06-0.07 ms steady. Real guard on any
  write (retired club => read-only). Two identical `tables` lookups (OLD and
  NEW table_id are equal) could be one, saving ~0.01 ms. Not worth a replace.
- **cancelled_tournament_seat_is_immutable**, 0.06 ms steady. Same shape and
  same verdict.
- **trg_no_live_seat_on_finished_game**, <0.05 ms steady. Forces left_at on
  a seat of a COMPLETED/CANCELLED tournament on any write; needs its lookup.
- **zzzz_stamp_active_seat_game_scope / zzzzz_require_live_seat_parent**,
  0.10-0.13 ms in the custom phase, <0.05 steady. They re-derive
  active_game_scope / active_parent_key from `tables` on every write; a skip
  would change when a table's scope change reaches its seats. Left alone.
- stamp_sit_out_at, stamp_seat_occupancy, clear_sitout_on_turnover,
  seat_parent_keys_match, stamp_club (already exits): 0.006-0.04 ms each.

## Structural finding for the orchestrator (not a trigger change)

Each tournament seat is written twice per hand (time-bank UPDATE, then stack
UPDATE) in the same transaction. The second write pays the full BEFORE chain
again plus the three FK re-checks (0.25-0.3 ms warm, 1.6-5.2 ms cold). Folding
the time-bank columns into the stack UPDATE in `fn_ca_settle_hand_stacks_absolute`
(or vice versa) would remove one full trigger pass per seat per hand
(~1.8 ms warm today, ~0.9 ms after this change) - larger than anything a
trigger body can give. That is a settlement-function change and outside this
workstream.

## Risks

- The replaced function is the one 20260910020459 already replaced tonight;
  the SQL file's rollback section is the exact production body as of 03:18 UTC.
- Generic-plan adoption needs five executions per backend; a backend that
  handles fewer than six tournament seat writes sees no gain and no loss.
- If `plan_cache_mode` were ever set to `force_custom_plan` globally the gain
  disappears (behaviour unchanged). It is `auto` today.
- No lock, no exception path, no returned row changes. Verified after apply
  with the same rolled-back 10-run probe: aa_proof_lock should read ~0.1 ms
  from run 7 on.
