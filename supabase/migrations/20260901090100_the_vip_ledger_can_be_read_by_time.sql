-- ═══════════════════════════════════════════════════════════════════════════
-- THE VIP LEDGER CAN BE READ BY TIME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED (read-only session; see the pull request).
--
-- vip_points_ledger carries 3,811,527 rows and three indexes, and not one of
-- them can answer "what was credited in the last six hours":
--
--     vip_points_ledger_pkey                                (id)
--     vip_points_ledger_user_id_source_type_source_id_key    (user_id, source_type, source_id)
--     idx_vip_points_ledger_user                             (user_id, created_at DESC)
--
-- The last one is per-user, so a window query over every user is a sequential
-- scan of the whole table. The basis alarm added in 20260901090200 asks
-- exactly that question every six hours, and an alarm whose cost grows with
-- the ledger is an alarm somebody eventually unschedules.
--
-- WHY IT IS ITS OWN FILE, AND HOW TO APPLY IT. CLAUDE.md's production DDL
-- policy says wrap the DDL for one change in ONE transaction, and this file
-- obeys that. But building a btree over 3.8M rows inside that transaction
-- takes a SHARE lock on vip_points_ledger for the whole build, and
-- vip_points_ledger is written by fn_award_vip_credit inside the rake trigger
-- -- so the lock does not stall a report, it stalls the rake row, which stalls
-- the hand. That is not an acceptable way to add an index to a live table.
--
-- So: run this ONCE, by hand, OUTSIDE any transaction, before applying the
-- file --
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vip_points_ledger_created
--       ON public.vip_points_ledger (created_at);
--
-- -- and the statement below becomes a no-op that records the intent in the
-- migration ledger. CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, which is why it cannot simply be the body of this file. If the table
-- is genuinely quiet (no hands in flight), applying the file directly is also
-- correct and takes a few seconds.

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE INDEX IF NOT EXISTS idx_vip_points_ledger_created
  ON public.vip_points_ledger (created_at);

COMMENT ON INDEX public.idx_vip_points_ledger_created IS
  'Window reads for fn_vip_points_basis_check. Without it the six-hourly basis alarm sequentially scans the whole ledger.';

COMMIT;
