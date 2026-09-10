# I - the settlement writes each seat row once per hand

Workstream I, 2026-09-10 04:00-05:20 UTC, production, read-only. Every probe
below ended in `RAISE EXCEPTION 'PROBE_ROLLED_BACK ...'` (none returned
success). No DDL was run; the two proposed bodies were compiled on a throwaway
local Postgres 16 only.

Verdict: **safe to apply; behaviour-identical on every row it touches.**
Deliverable: `I-one-seat-write-per-hand.sql` (two `CREATE OR REPLACE`, a
rolled-back self-test, originals in a commented ROLLBACK section).

## 1. What actually writes table_seats per hand, in order

Production hand commits go through PostgREST to the 12-argument door
(`pg_stat_statements`: 44,391 calls of `fn_ca_commit_hand_settlement` since
02:34 UTC, ~300/min, 300 ms mean; 100% of the last 10 minutes' commits are
exact seat generation, 3.96 seats per hand, 81% tournament hands, 3.8% with a
zero-stack vacate, 0 with a departed seat, 0 diamond-asset hands).

```
fn_ca_commit_hand_settlement (door, 12 args)             one PostgREST transaction
  validates p_post_commit_obligations.time_banks (uuid, digits, <= 2^31-1,
    seat_id/seat_joined_at bound to the stack roster)              lines 79-116, 152-163
  -> fn_ca_commit_hand_settlement_exact_before_obligations (lease + table lock)
     -> fn_ca_commit_hand_settlement_before_lease_generation
          hashes p_stacks VERBATIM into hand_atomic_commits.payload_hash (replay identity)
          BEGIN ... EXCEPTION -> returns {success:false, reason:'atomic_hand_rolled_back'}
          -> fn_ca_settle_hand_stacks_absolute (core, 7 args)
               BEGIN ... EXCEPTION -> returns {success:false, reason:'rolled_back'}
               WRITE 1  UPDATE table_seats SET stack = v_target
                        WHERE id = seat_id AND joined_at = seat_joined_at
                          AND table_id = p_table_id AND user_id = uid AND left_at IS NULL
                        (ROW_COUNT <> 1 -> EXISTS(stack = v_target) or refuse whole)
               tournament only: UPDATE tournament_players.chips; zero-stack seats get
               WRITE 1b (left_at/status vacate, out of scope); tables.current_players
  door, after the core returned success (first commit only, v_existing_request_hash IS NULL):
  WRITE 2  UPDATE table_seats SET time_bank_uses_remaining = X, time_bank_remaining = Y
           WHERE table_id = p_table_id AND user_id = uid
             AND id = seat_id AND joined_at = seat_joined_at        -- exact mode: NO left_at guard
           (ROW_COUNT 0 -> EXISTS(row already holds X,Y) counts as 1; count mismatch -> refuse)
```

So the order is stack (core) then time-bank (door) - B's note had it the other
way round; the RI re-check finding is unaffected (it is the second write of the
row that pays it, whichever column set that is). Between the two writes, in the
same transaction: the zero-stack vacate and the `tables.current_players` sync
(tournament), `hand_history`/`hand_atomic_commits` inserts, the door's envelope
checks. Nothing between them reads or depends on the time-bank columns, and no
trigger fired by WRITE 2 depends on seeing the stack already updated (section 2).

Two things that constrain the fix:

- `p_stacks` is hashed verbatim into the atomic-commit receipt, so the time-bank
  values cannot be smuggled into the stack elements (a response-loss retry
  across the deploy would hit `atomic_hand_payload_conflict`). The core also
  has an owner-only ACL (`{postgres=X/postgres}`) and is called by three
  nested SECURITY DEFINER functions, so adding a parameter would mean three new
  overloads, three DROPs and three REVOKEs on money functions.
- The core's stack write is inside its own `BEGIN ... EXCEPTION` and the door's
  time-bank write is not, so an error raised only by WRITE 2 aborts the whole
  transaction today while an error raised by WRITE 1 is reported as
  `success:false`. Section 2 shows no trigger can raise on WRITE 2 without
  also raising on WRITE 1, so folding does not move any reachable error
  between those two paths.

## 2. Trigger inventory on table_seats (43 triggers, `pg_get_triggerdef`)

Fire on BOTH a stack-only and a time-bank-only UPDATE (no column list; these
are the 13 that ran in every probe below, plus 3 RI + 1 deferred-unique AFTER
triggers on the second write):

| trigger                                                                  | reads                                                    | stamps/raises                                                                               | time-bank visible?  |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| aa_tournament_live_seat_proof_lock                                       | table_id,user_id,seat_number,stack,left_at               | early-exit unless one of those changed; locks/roster raise                                  | no                  |
| zz_freeze_guard = fn_refuse_while_frozen('stack','left_at','sit_out_at') | TG_ARGV columns via to_jsonb(NEW)->col                   | early-exit unless stack/left_at/sit_out_at changed; PLATFORM_FROZEN raise                   | no (not in TG_ARGV) |
| terminal_tournament_seat_is_immutable                                    | table_id, terminal_closed_at, tournament status/receipts | raise                                                                                       | no                  |
| cancelled_tournament_seat_is_immutable                                   | table_id -> tournament, cancellation receipts            | raise                                                                                       | no                  |
| trg_guard_retired_club_mutation                                          | table_id -> tables.club_id -> clubs.lifecycle_status     | raise                                                                                       | no                  |
| trg_no_live_seat_on_finished_game                                        | left_at, table_id -> tournaments.status                  | stamps left_at/is_sitting_out on COMPLETED/CANCELLED                                        | no                  |
| trg_stamp_sit_out_at                                                     | is_sitting_out, sit_out_at                               | stamps sit_out_at (explicitly documents "a time-bank decrement must NOT restart the clock") | no                  |
| trg_table_seats_stamp_club                                               | user_id, table_id, club_id                               | early-exit when unchanged                                                                   | no                  |
| zzz_stamp_seat_occupancy                                                 | user_id, table_id, seat_number, left_at, occupancy_id    | stamps/raises                                                                               | no                  |
| zzzz_stamp_active_seat_game_scope                                        | left_at, table_id -> tables.seat_game_scope              | stamps active_game_scope                                                                    | no                  |
| zzzzz_require_live_seat_parent                                           | left_at, table_id -> tables.seat_admission_key           | stamps active_parent_key / raises                                                           | no                  |
| zzzzz_seat_parent_keys_match                                             | table_id, active_game_scope, active_parent_key           | early-exit when unchanged                                                                   | no                  |
| trg_clear_sitout_on_turnover                                             | left_at, is_sitting_out                                  | stamps on left_at transitions                                                               | no                  |
| RI*ConstraintTrigger_c*\* x3 (profiles, tables, clubs)                   | FK columns                                               | fire only on a row already modified in this transaction                                     | no                  |
| Unique_ConstraintTrigger (one_committed_seat_per_game_player, deferred)  | user_id, active_game_scope                               | re-check at commit                                                                          | no                  |

Every other trigger carries an `UPDATE OF` list (`table_id, user_id,
seat_number, left_at, is_sitting_out, is_away`) or a WHEN clause on
`left_at`/`user_id`/`table_id`; none lists `stack`, `time_bank_uses_remaining`
or `time_bank_remaining`, so none fires on either write today and none fires
on the combined write. `prosrc ~* 'time_bank'` is false for all 33 trigger
functions on the table. The only whole-row inspection
(`fn_ca_terminal_marker_transition_is_exact(to_jsonb(OLD), to_jsonb(NEW))`)
runs only when `terminal_closed_at` changes, which neither write does. No
CHECK constraint mentions the time-bank columns (they are nullable integers,
defaults 4/30). `idx_unique_active_user_per_table` (table_id, user_id) WHERE
left_at IS NULL guarantees at most one live seat per user per table.

## 3. Why the combined write is behaviour-identical

Let S be the stack write (WRITE 1) and T the time-bank write (WRITE 2), and C
the proposed combined write, issued at S's position with S's guards.

1. **Same rows.** C uses S's WHERE (`id, joined_at, table_id, user_id, left_at
IS NULL`). T's exact-mode WHERE is the same minus `left_at IS NULL`. Any
   row S matches, T matches. Rows T matches but S does not: a seat with
   `left_at` set - (a) the zero-stack seat the core vacates _after_ S: C wrote
   it while it was still live, the vacate does not touch the time-bank
   columns, final values identical; (b) a cash seat that left during the hand
   (core settles it against the wallet, never writes the row): the door still
   writes it, unchanged code path (its proof finds no match and it takes the
   original UPDATE). Legacy (non-exact) mode: S and C use `table_id, user_id,
left_at IS NULL`; T's "vacated this hand" branch is case (a) again.
2. **Same final values.** C sets stack to the same `v_target` and the two
   time-bank columns to the same `(v_item->>'uses_remaining')::integer` /
   `(v_item->>'seconds_remaining')::integer` from the same envelope
   (`p_post_commit_obligations->'time_banks'`, untouched by
   `v_payload := jsonb_set(...)`). Items are matched to the seat by
   `lower(user_id)` and, in exact mode, `seat_id` + `seat_joined_at`
   (compared as uuid/timestamptz, exactly the pairing the door already
   enforces before calling down, `time_bank_seat_generation_mismatch`).
   Every trigger stamp is a pure function of columns the time-bank write does
   not touch plus table/tournament state that is locked (FOR SHARE on
   tournaments, FOR UPDATE on tables) for the whole transaction, so the second
   pass today recomputes the same stamp it computed on the first pass; one
   pass gives the same row. Proven on live rows: section 5.
3. **Same trigger outcomes.** For each BEFORE trigger, its inputs on C equal
   its inputs on S (the time-bank columns are invisible to all of them), so it
   returns/stamps/raises exactly as on S. On T today every one of them either
   exits early (stack unchanged, freeze guard by TG_ARGV, proof lock by its
   first IF) or re-derives the same stamp, so removing T removes no distinct
   outcome. `fn_refuse_while_frozen`: refuses iff stack (or left_at,
   sit_out_at) changed - true on S iff true on C; T never changes them. The
   three RI re-checks and the deferred unique re-check are pure checks on
   unchanged FK/unique columns whose referenced rows cannot vanish inside the
   transaction; skipping them changes nothing.
4. **Same error paths and codes.** C raises exactly where S raises, caught by
   the same `EXCEPTION WHEN OTHERS` in the core -> `success:false,
reason:'rolled_back'`, idempotency key `failed`, door returns the result -
   unchanged. T-only failures do not exist (item 3), so nothing moves from
   "transaction abort" to "reported failure". The door's own refusals
   (`invalid_time_bank_obligation`, `time_bank_seat_mismatch`,
   `post_commit_duplicate_or_missing_recipient`, `post_commit_receipt_raced`)
   still raise from the same places with the same text; a raise from the door
   aborts the PostgREST transaction, so everything the core wrote (including
   C's time-bank columns) rolls back, as today.
5. **`time_bank_seat_mismatch` counts identically.** Today `v_row_count` =
   T's ROW_COUNT (0 or 1 - at most one row can match, PK in exact mode, the
   partial unique index in legacy mode), else 1 if the row already holds the
   state. Proposed: `count(*)` of rows holding the exact state (0 or 1, same
   predicate as the existing lawful-noop EXISTS); if 0, the original UPDATE
   and the original EXISTS fallback run verbatim. Any case that counted 1
   before counts 1 now and vice versa.
6. **Replay / rolling engine.** The core writes only on a fresh settlement; a
   replay returns before any write and the door then either refuses
   (`legacy_receipt_has_no_post_commit_envelope`) or skips the time-bank
   block (`v_existing_request_hash IS NOT NULL`) - both unchanged. A hand whose
   first attempt committed before the deploy and is retried after it replays
   the stored receipt: no write on either side.
7. **Nothing hashed or returned changes.** `v_request`/`v_canonical` (replay
   identity), `hand_atomic_commits.payload_hash`, `stack_result`, the
   returned jsonb and `post_commit_payload_hash` are untouched.
8. **Any other caller of the core** (legacy `fn_ca_settle_hand_stacks`, a
   manual re-drive, the diamond delegation which returns before the fold)
   sees `current_setting('app.ca_hand_time_banks', true)` NULL/'' and runs the
   byte-identical stack-only UPDATE.
9. **Deploy order independent.** New door + old core: core ignores the
   setting, the door's proof fails, the original UPDATE runs (today's two
   writes). Old door + new core: the setting is never published, stack-only
   write, door writes time bank (today's two writes). Only new+new folds.
10. **The transaction-local setting cannot leak.** `set_config(..., true)`
    dies with the transaction, the door clears it right after the core
    returns, the core accepts it only when `table_id` and `hand_number` match
    its own arguments and `exact` matches its own roster shape, and applies
    an item only to the stack element whose `user_id`/`seat_id`/`joined_at`
    it names. A stale value could only name a hand that the core refuses as a
    replay before any write. Same mechanism the codebase already uses for
    `app.atomic_hand_commit`, `app.money_path`, `app.ledger_*`.

Non-deterministic race, unchanged in kind: `trg_guard_retired_club_mutation`
reads `clubs.lifecycle_status` without a lock, so a club retirement committing
between S and T could today refuse T and abort the hand; with one write the
same retirement lands either before it (refused) or after it (accepted). Both
outcomes were already possible ms apart; the guard's coverage is the same.

## 4. Measurements (rolled back, one live tournament seat and one live cash seat)

`EXPLAIN (ANALYZE, FORMAT JSON)` of the three statements in one DO block, six
rounds, per-trigger times from the plan. A = today's stack write, B = today's
time-bank write, C = the combined write. Rounds 1-2 are the custom-plan phase,
rounds 4-6 the steady state a pooled engine backend lives in. Times in ms.

Tournament seat b54d992f (RUNNING, receipt completed, stack 18000), order A,B,C:

| round      | A exec    | B exec    | C exec    | notes                                              |
| ---------- | --------- | --------- | --------- | -------------------------------------------------- |
| 1 (cold)   | 19.24     | 5.04      | 3.91      | A: proof_lock 7.0, freeze 3.8; B: profiles RI 1.84 |
| 2          | 3.74      | 2.27      | 3.79      |                                                    |
| 3          | 2.21      | 0.61      | 2.01      |                                                    |
| 4-6 steady | 0.71-0.74 | 0.55-0.56 | 0.68-0.73 | C == A within noise                                |

Cash seat fff827aa (stack 453.56), order A,B,C:

| round      | A exec    | B exec    | C exec    |
| ---------- | --------- | --------- | --------- |
| 1 (cold)   | 15.86     | 3.76      | 2.28      |
| 2          | 2.24      | 1.67      | 2.20      |
| 3          | 1.14      | 0.57      | 0.76      |
| 4-6 steady | 0.58-0.64 | 0.48-0.51 | 0.60-0.70 |

Order C,A,B (tournament seat, C as the first write of the transaction): C
fires 13 triggers, the later writes 16 (the three RI re-checks appear only
from the second write on) - identical to A-first. Steady state C 0.72-0.81.

Read: the combined write costs what the stack write costs today; the whole
time-bank write disappears: **0.48-0.66 ms per seat steady state, 1.7-5 ms
per seat in a backend's first executions / cold**, plus the RI re-checks
(0.25-0.3 ms warm, up to 1.8 ms cold on the profiles FK) that only the second
write pays. The proof `SELECT count(*)` that replaces it is one PK lookup
(~0.02-0.05 ms).

Per hand at 3.96 seats: **about -2.0 to -2.6 ms of executor+trigger time
steady state (-7 to -20 ms cold)**, one fewer heap tuple version and WAL
record per seat per hand (~1,200 fewer table_seats row versions per minute at
~300 hands/min; table_seats is not in a Realtime publication, so no decode
effect). Against the 300 ms mean of the door this is ~1%; against the
table_seats write path it halves the settlement's row writes.

## 5. Equivalence probes (rolled back)

Row identity, both seats: inside one transaction, (i) S then T with changed
values (stack +7, uses -1, seconds -5) in a sub-block, `to_jsonb(row)`
captured, sub-block rolled back and the row verified back to its original
image; (ii) C with the same values, captured, rolled back. Result for both
seats: `two-step == combined: t`, `diff: none`; the only columns that differ
from the pre-write image are `stack`, `time_bank_remaining`,
`time_bank_uses_remaining` (no trigger stamp moved).

Fragment probe on a live cash seat (the door's publish, the core's parse and
combined UPDATE, the door's proof, verbatim from the proposed bodies): map
built for the seat's user, item matched the exact generation, combined write
1 row, `pg_stat_xact_user_tables.n_tup_upd` delta on table_seats = 1, door
proof count = 1 (no second UPDATE), setting cleared to ''.

Self-test baseline (the DO block in the .sql, run BEFORE apply against the
current core, rolled back): `(1) folded: success=true seat_writes=1 uses 1->1
(expect 2) ... VERDICT: FAIL` - i.e. the harness drives the real core
successfully and the current core ignores the envelope, as expected. After
apply it must print `VERDICT: PASS` (uses/seconds equal the requested values,
1 seat write with the envelope, 1 stack-only write without it, proof = 1).

Both proposed bodies and the uncommented rollback section compile on a local
Postgres 16 (`CREATE OR REPLACE` accepted; PL/pgSQL parses every statement).

## 6. Risks

- The bases are the bodies as of 05:15 UTC, which already carry tonight's
  diamonds-asset delegation (`fn_poker_diamond_settle_cash_hand` in the core,
  `v_diamond` checks in the door). The .sql header lists the expected md5 of
  `pg_get_functiondef` for both; re-check before applying. A diamond cash
  hand (0 in the last 30 min) keeps today's two writes: the core returns
  before the fold and the door's proof falls back to its original UPDATE.
- The door's pre-call validation of the time-bank items is what makes the
  core's fold safe; the core re-validates (uuid, digits, <= 2^31-1, one item
  per player, exact seat match) and simply does not fold otherwise. No new
  RAISE anywhere.
- Legacy (non-exact) roster: still supported by both sides with the same
  guards (`table_id, user_id, left_at IS NULL`); 0% of current traffic.
- A seat whose time-bank item names a different seat generation than its
  stack element cannot reach the core (door refuses first); if it did, the
  core writes stack-only and the door's original path handles it.
- Each CREATE OR REPLACE costs the ~28 s PostgREST schema reload; batch both.

## 7. Rollback

Run the two commented originals at the end of the .sql (strip `-- `). Mixed
states are safe in both directions (section 3, item 9). No data migration, no
state to undo: a hand committed under the new bodies looks identical to one
committed under the old ones.

## 8. What the orchestrator must run

1. Confirm the md5s in the .sql header still match `pg_get_functiondef`.
2. Apply `I-one-seat-write-per-hand.sql` statements 1 and 2 (no BEGIN/COMMIT).
3. Run the self-test DO block from the same file: it must fail with
   `P0001 PROBE_ROLLED_BACK ... VERDICT: PASS`. If it returns success it
   committed a probe hand on a live cash seat - report immediately.
4. Optional check after a few minutes: `n_tup_upd` on table_seats
   (`pg_stat_user_tables`) should grow at roughly half the previous per-hand
   rate relative to `hand_atomic_commits` inserts.
