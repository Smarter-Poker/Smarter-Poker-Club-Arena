-- ═══════════════════════════════════════════════════════════════════════════
--  THE DISCARD PRUNE THAT NOTHING EVER CALLED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260901093000 created public.sp_prune_hand_discards and wrote the retention
-- promise into the table's own comment: "a row survives exactly as long as a
-- hand_history row for its (table_id, hand_number) does".
--
-- Nothing kept that promise. The function was defined, granted to service_role,
-- documented -- and never called from anywhere: not from the engine, not from a
-- cron entry, not from a CI job. Measured 2026-09-01 across the whole repo and
-- the whole cron.job table: zero callers. A retention policy with no caller is
-- not a policy, it is a comment, and the table it describes grows forever.
--
-- Every sibling prune in this database is a pg_cron entry that takes an
-- advisory lock, caps its own statement_timeout and passes a batch limit --
-- sp_prune_hand_history_10m, sp_prune_hand_state_snapshots_2m,
-- sp-prune-rabbit-hunt-offers. This is that shape, unchanged, so the discard
-- prune behaves like the hand prune it inherits its retention from.
--
-- Twice an hour rather than the hand prune's every ten minutes: this only ever
-- deletes rows whose parent hand is ALREADY gone, so it is a follower, and a
-- follower does not need to run more often than the thing it follows.
--
-- The one-day grace window inside the function is what makes the ordering safe:
-- the engine writes the discard mid-hand and the hand_history row at hand
-- completion, so for the length of one hand a live discard legitimately has no
-- parent. Pruning on "no parent" alone would delete the card of the hand
-- currently being played.

SELECT cron.schedule(
  'sp-prune-hand-discards',
  '7,37 * * * *',
  $cron$
select case
         when pg_try_advisory_lock(hashtext('sp-prune-hand-discards'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.sp_prune_hand_discards(5000) >= 0)::text
         else 'skipped: previous run still in progress'
       end;
$cron$
);
