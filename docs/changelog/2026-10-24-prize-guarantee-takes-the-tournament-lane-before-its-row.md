# The prize guarantee takes the tournament lane before its row (2026-10-24)

This is the companion to PR #7992
(`20261025030526_entry_close_takes_the_tournament_lane_before_its_row`).
That PR fixed the deadlock (40P01) behind every
`tournament.real_time_payout_refused` alert from 2026-10-22 to 2026-10-24.

## The deadlock #7992 fixed

The two entry-close doors locked the `tournaments` row and finalized the
prize pool. Finalizing the pool starts the deferred payer at COMMIT, and the
payer asks for the tournament lane T(id) EXCLUSIVE. A rebuy, add-on or hand
already held T(id) and was waiting for that same row, so neither side could
move.

## What was still open

An independent review of #7992 found the same inversion behind a third door:
`public.fn_apply_prize_guarantee`.

- It is granted to `service_role`, so it can be called directly over RPC.
- It locks the `tournaments` row first, in
  `fn_ca_return_excess_start_overlay_locked` and then in
  `fn_ca_apply_prize_guarantee_core` / `fn_apply_prize_guarantee_before_atomic_proof`.
- It sets `prize_pool_finalized = true` without taking the lane.

Called directly, it would form the same cycle with `process_tournament_rebuy`,
which takes the lane at line 71 and the row at line 205. No production code
calls it that way today: the engine's `applyPrizeGuarantee` method has no
caller. That is why no alert came from it.

## The fix

Migration `20261025035247_prize_guarantee_takes_the_tournament_lane_before_its_row`
makes `fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)` the first
statement of the function. It runs before the overlay-return and
finalization subtransaction, and only when the id is not NULL.

The edit is one anchored replace. It is guarded by the production pre-image
md5s (`pg_get_functiondef` c1153529..., `prosrc` f9ffce08...). After the
edit, the migration asserts that the post-image md5 matches and that the
owner, ACL, SECURITY DEFINER and search_path are unchanged.

## Why it is safe for every caller

Read from the live catalogue:

- **`fn_settle_tournament_places` and `fn_settle_tournament_final_table_deal`.**
  Both call `fn_ca_lock_settlement_lane_global` before this function.
  - In a non-satellite finish, that call re-enters the finish lane, which
    already holds G shared and T(id). The new request is therefore
    re-entrant.
  - On the true global path they hold G exclusive. Every T(id) taker takes G
    shared first, so no other backend can hold any T(id) key, and the
    request is granted immediately.
- **`fn_finalize_tournament_entry_pool_locked`.** Once #7992 is installed,
  this path already holds T(id), so the request is re-entrant. Before then,
  this is the same request the deferred payer makes at COMMIT whenever the
  pool finalizes; it just happens earlier, so it is no worse.

## Lane doctrine

I checked the lane doctrine with a read-only query on production, using
`fn_ca_settlement_lane_doctrine` rule 4's own regexes:

- The walk from this function reaches 14 functions within four calls, and
  none of them takes the global lane.
- A broader walk, which counts every `public.name(` mention to depth six,
  reaches 20 functions, also with no global-lane caller.

## Local reproduction

I ran a reproduction on a throwaway PostgreSQL 16 cluster. It used the exact
production definitions of this function, the lane helper and the deferred
trigger. The inner overlay and guarantee functions were stubbed to take the
same row lock in the same order as production.

| Run                                 | What the add-on partner waited on | Deadlock            | Payer       |
| ----------------------------------- | --------------------------------- | ------------------- | ----------- |
| Before the migration                | the row (`transactionid`)         | 40P01 alert written | did not run |
| After the unmodified migration file | the lane (`advisory`)             | none                | ran once    |

In the run after the migration, both transactions committed.

## What did not change

The overlay return, the guarantee core and its atomic proof, the payer and
its trigger, the lane helpers and the doctrine are untouched. Overlay
funding is still idempotent: it still uses the overlay row with ON CONFLICT,
the journal key and `already_finalized`. Nothing is owed, and there is no
retry, sweep or cron.

The law for this change is
`tests/a-prize-guarantee-takes-the-tournament-lane-before-its-row.law.test.ts`.
