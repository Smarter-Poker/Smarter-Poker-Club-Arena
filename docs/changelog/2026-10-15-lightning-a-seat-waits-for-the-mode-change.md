# Lightning: A Seat Waits For The Mode Change In Flight

**Migration:** `supabase/migrations/20261015121542_lightning_phase_12_load_chaos_a_seat_waits_for_the_mode_chan.sql`
**Regression:** `scripts/dev/fixtures/lightning-mode-change-race.sql`, run by `scripts/dev/test-lightning-phase12-load-chaos.sh` (section MR)
**Status:** branch `fix/lightning-conversion-seat-race`, not applied to production. Lightning is off on every production Cluster, so nothing here is reachable there until a Cluster is enabled.

## The Defect

The load and chaos harness, scenario C4, failed `no_ghost_and_nobody_left_behind`:
"5 eligible seated players a LIGHTNING Cluster never entered into its current epoch's pool".

Two writers decide whether a seated player is in the pool, and nothing ordered them:

- The deferred seat trigger `fn_table_seats_lightning_pool_follows_seat` runs at the arrival's COMMIT and enters the seat only if it reads `cash_games.cluster_mode = 'lightning'`.
- The conversion `fn_cash_cluster_commit_lightning` (and `fn_cash_cluster_abort_pending_off`) sets the mode to `lightning` and enters every seat its own snapshot can see.

An arrival whose trigger ran while a conversion was in flight read the committed `pending_on` (or `pending_off`) and entered nothing. The conversion, whose pool INSERT had already run, could not see the uncommitted seat. Both committed: a LIGHTNING Cluster with an eligible seated player, a halted table, and no pool session at the current epoch, permanently.

The mirror is `fn_cash_cluster_commit_must_move` when the reversion runs in the same transaction that opened PENDING_OFF (the Phase 13 drain): an arrival reads the committed `lightning`, opens a pool session at the old epoch the reversion cannot see, and commits it after the reversion closed every session it could see. That leaves an open pool session in a MUST MOVE Cluster.

The Phase 12 seat `FOR SHARE` (20261009151825) closed the departure half of this race. A row lock cannot stop an INSERT, so the arrival half stayed open.

## The Fix

One transaction-scoped advisory lock per Cluster, key `hashtextextended('lightning_cluster_mode:' || cluster_id, 0)`, following the estate's `lightning_<what>:` convention (the prefix is new, so it collides with no existing key).

| Function | Lock | Where |
| --- | --- | --- |
| `fn_table_seats_lightning_pool_follows_seat` | SHARED, per Cluster of the seat's table (and its old table on an UPDATE), sorted | First thing, before the departure branch and the mode check; `v_now` is re-read after it |
| `fn_cash_cluster_commit_lightning` | EXCLUSIVE | After the live-seat `FOR SHARE`, before the chip total, the mode/epoch UPDATE and the pool INSERT |
| `fn_cash_cluster_abort_pending_off` | EXCLUSIVE | After the live-seat `FOR SHARE`, before the loop that enters whoever sat down |
| `fn_cash_cluster_commit_must_move` | EXCLUSIVE | After the seat, cash-session and blind-ledger `FOR SHARE`, before the digests and the pool close |

Each statement after the lock takes a fresh READ COMMITTED snapshot, so an arrival whose trigger got in first has committed and is entered (or closed, in the reversion), and an arrival after waits for the commit and reads the new mode itself.

The trigger takes the lock before its departure branch too: a seat that arrived while a conversion waited is not under that conversion's `FOR SHARE`, and its departure must see the pool session the conversion committed on it.

### Why The Lock Comes After The Seat FOR SHARE

A seat writer holds its row from its own statement to its commit, and its deferred trigger asks for the shared lock at that commit. A conversion holding the exclusive lock while waiting on a seat row would deadlock with exactly that writer. So each conversion takes every row lock it will ever wait for first, then the advisory lock, and takes no seat, cash-session or blind-ledger row lock after it.

A trigger holding the shared lock needs nothing a waiting conversion holds: no foreign key from `lightning_pool_session`, `lightning_pool_slot` or `cash_cluster_events` references `cash_games` or `table_seats` (read from production), pool entry reads the Cluster row without locking it, and a waiting conversion has not yet touched a pool session, slot or epoch row. Formation does not take this lock; it serialises on the Cluster row, which every conversion already holds `FOR UPDATE`.

### Money

Nothing moves a chip. The money guards are unchanged: the chip total and the reversion digests still cover exactly the rows each function locked, and an arrival admitted during the wait is outside both halves of each comparison. `v_pool = v_seated` and the stranded check now see one population, because no eligibility change can commit between them once the lock is held.

### Method

Each body is an asserted substitution into the installed body. The installed `md5(prosrc)` must be a known preimage, each anchor must occur exactly once, the result must have the measured postimage md5, and owner, SECURITY DEFINER, search_path, comment and ACL must read back unchanged. A body already carrying its marker is accepted only as a known postimage, so the file is re-appliable (the harness applies it twice).

| Function | Preimage md5(prosrc) | Postimage md5(prosrc) |
| --- | --- | --- |
| seat trigger | `a506c61b41dccf416800a20957344b36` | `b6c664923a5407e83a1f41de840fa9a7` |
| `fn_cash_cluster_commit_lightning` | `4aafd940b0809cd1fa7c56be91fcb285` | `4d0f4e028c7a0411ac19ca598167a0cb` |
| `fn_cash_cluster_abort_pending_off` | `03eca9fc45f23e982acdda1bd9b97316` | `4ed812c85c1e419f1d6e868463409629` |
| `fn_cash_cluster_commit_must_move` (production, chain through Phase 13) | `85079fdc6fead3e1b1a8ac6e802ee20d` | `0fa9c8d280bcbfd48a72375869b5cf87` |
| `fn_cash_cluster_commit_must_move` (harness default chain, before Phase 13) | `8358cfa5a405fdaa284af28a31b5c548` | `d188ace1b98b2c1e9a784e7286a35545` |

## The Regression

`scripts/dev/fixtures/lightning-mode-change-race.sql` forces the six interleavings through two dblink backends:

- **M1 and M2:** MUST MOVE to LIGHTNING, conversion first and arrival first.
- **M3 and M4:** PENDING_OFF to LIGHTNING through the abort, both orders.
- **M5 and M6:** the one-transaction reversion to MUST MOVE, both orders.

Each case requires that the second backend is still waiting when the first is released, that nobody eligible is left out of a LIGHTNING pool, and that no pool session survives at a dead epoch or into MUST MOVE.

Measured locally on PostgreSQL 16 over the harness chain:

- **Before the migration:** all six fail. M1 to M4 leave the arrival out of the pool, and M5 and M6 leave one open pool session in MUST MOVE.
- **After the migration:** all six pass, on the default chain and on the CI chain through Phase 13.

The full `ci` profile run (11 scenarios, 169 invariant checks, S3 conversion storm and C4 included) passes with the fix.

## Not Changed

- `fn_cash_cluster_unfreeze` and the freeze: unfreeze moves FROZEN to MUST MOVE, and the trigger never enters a seat outside LIGHTNING, so it has no arrival race.
- **An orphan arrival:** a seat with no open cash session that commits after `commit_lightning`'s orphan check. That window existed before this change, and the lock wait can widen it. It makes the pool INSERT fail on NOT NULL, the conversion rolls back whole, and the next drive's orphan check aborts PENDING_ON cleanly. A second orphan check after the lock would have falsified 20260925204249's proof that the conversion has exactly two refusal answers, so it was left out. The live buy-in writes the seat and its cash session in one transaction.
