# Tournament table writers wait for their shared lane

Launch-day phase 2B, 2026-10-19. Migration
`20261019151125_tournament_table_writers_wait_for_their_shared_lane.sql`.

## What players saw

In a running tournament, some hands were dealt without their hole cards ever
being saved. The engine sends the cards to the seat first, so a player who
stayed connected saw them, but a player who reloaded mid-hand got
`hole_cards_unavailable` and could not get them back. In the 3 hours before
14:48 UTC there were 53 such hands. The same refusals also stopped hand
snapshots, post-hand obligations and projections, which the engine retried.

## What the database said

About 17,900 `F06_RETRY_CANONICAL_LANE` refusals (SQLSTATE 55P03) in the 24
hours to 15:00 UTC, rising (1,741 in the 14:00 hour). Since 11:00 UTC, 99.9% were
raised by the two F06 hand guards, `f06_cancelled_preparation_writer_guard`
(1,878) and `f06_aborted_hand_guard` (1,709), inside exactly four RPCs:
`fn_ca_process_hand_post_commit_obligations` 1,236, `insert_hole_cards` 1,061,
`save_hand_state_snapshot` 817 and `fn_project_hand_side_effects` 475.

## Why

Both guards check that a hand write is inside the tournament's settlement
lane by TRYING the global lane G and the tournament lane T(id) in shared mode,
and refuse at once if they cannot. Shared does not conflict with shared, so
sibling tables never blocked each other directly. But every tournament-wide
authority - finishing the tournament, moving or eliminating a player, a horse
registering or taking a seat, a table break, a blind level - holds T(id)
exclusively, and Postgres also refuses a shared try while an exclusive request
is merely queued. A 30-second sample of live locks at 15:03 UTC found some
running tournament's T(id) held exclusively in 22% of reads (most often by
`fn_complete_tournament_terminal`, `fn_move_tournament_player`, horse
registration and seating, and eliminations) and an exclusive request queued
in 5%. During each of those moments every table of that tournament had its
writes refused together, so the refusals grow with the number of tables.

The other per-table hand calls - hand-number allocation, begin and finish of
a hand, the hand commit itself - already WAIT for the same shared lane
(2026-10-03, `fn_ca_f06_share_table_lane`, and
`fn_ca_share_settlement_lane_for_table`). These four were the ones left
refusing.

## The fix

`smarter_private.f06_wait_table_lane(table)` takes G shared and T(id) shared
and waits for them, at most 4 seconds (its own `lock_timeout`); on expiry it
raises the same `F06_RETRY_CANONICAL_LANE` / 55P03, so the engine's existing
classification and retries are unchanged. Each of the four writers calls it as
its very first lock. When the guard then tries the same locks inside the
write, the transaction already holds them and the try succeeds immediately.
Cash tables take no lane, as before. Database only: no engine release.

## Why the F06 guarantee still holds

The guarantee is that terminal settlement, finish and every tournament
authority (all of which take T(id) or G exclusively) never interleave with a
hand write they must see or fence. It is enforced exactly as before: every
guarded write holds G and T(id) shared from before its row is written until
its transaction ends, and an exclusive holder cannot overlap that. The holds
now start a little earlier, at the top of the RPC. A writer that used to be
refused now waits until the authority finishes, and its guarded statement then
reads a fresh snapshot, so a cancellation or abort the authority committed
still fences it (`F06_CANCELLED_PREPARATION_FENCED`,
`F06_ABORTED_HAND_FENCED`). Neither guard changed: a direct write that skipped
the lane is still refused, not waited for.

The wait cannot deadlock through the lane: it happens while the transaction
holds nothing except, for T(id), G shared, which is the lane's own first step
in the same order every authority uses. Callers that already hold the lane
(`fn_project_hand_side_effects` for its nested post-commit call,
`fn_ca_resume_hand_submission` and `original_hand_correction_sources_match`,
which hold T(id) exclusively) re-enter it without waiting.

## Proof

- Native PostgreSQL 17, exact live bodies
  (`scripts/dev/test-tournament-table-writers-wait-for-their-lane.py`, 79
  cases, required accounting shard 1). Before: all four writers refused in
  about 12 ms while G or T(id) is held exclusively, and while an exclusive
  request is only queued. After: each waits (holding no row or relation lock)
  and succeeds when the authority ends; the wait is bounded at 4.0 s with the
  same sentinel; two tables of one tournament write concurrently in about 12
  ms; an exclusive authority cannot start while a writer is open; a writer
  that waited obeys the cancellation or abort its authority committed;
  another tournament's lane and cash tables are unaffected; an exclusive
  holder re-enters without waiting; a direct guarded write is still refused;
  drift in any pinned body aborts the migration.
- Rolled-back production probe (one self-aborting DO block, pg_temp copy of
  the helper), 15:2x UTC: all four live pre-images match their pins and give
  the qualified post-images. Over 20 seconds, 14,554 attempts across every
  open table of every running tournament: the old try was refused 16 times,
  the new wait succeeded all 14,554 times, mean wait 0.32 ms, longest 949 ms,
  9 waits over 100 ms, none over 1 s. No lock left behind.
