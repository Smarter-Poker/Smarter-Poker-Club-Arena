-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260818235115 "20260819_retire_shark_club_orphan_bbj_pool"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cf61703188b7fee84664314a8f1e5eba of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Retire SHARK CLUB's club-level BBJ pool. The club is in Midway Union and
-- must not carry its own jackpot.
--
-- THE BUG THIS FIXES: the club lobby rendered TWO different jackpots with no
-- label - the banner showed the union pool (10,500.67) while the wallet panel
-- showed this club row (350.40). Both were "correct" for their own source.
--
-- WHICH ONE IS REAL, from the data:
--   union pool f9806a7f  261,946 contributions all-time, 56,010 in 7 days
--   club  pool 6077bff0        0 contributions all-time, 0 payouts ever
-- Every chip raked at this club's tables funds the UNION pool. The club row
-- has never received a single contribution.
--
-- WHY THE BALANCE IS SAFE TO CLEAR: main_balance 350.40 + backup_balance
-- 262.80 exist with total_contributed = 0, hands_contributed = 6201 and
-- total_paid_out = 0 - seed/test artifacts from before the union existed,
-- never funded by a contribution and never paid to a player. No chips owed to
-- anyone are destroyed. bbj_payouts has a FK ON DELETE RESTRICT to this table
-- and holds ZERO rows for this pool.
--
-- RETIRE, NOT DELETE: every client query filters `.eq('status','active')`, so
-- flipping status removes it from every display while preserving the audit
-- trail and staying trivially reversible. Deleting would discard the evidence
-- for why it was removed.
--
-- Verified this is the ONLY union-member club carrying its own active pool.
-- ============================================================================

DO $$
DECLARE
  v_contribs bigint;
  v_payouts  bigint;
  v_union    uuid;
BEGIN
  SELECT count(*) INTO v_contribs FROM bbj_contributions
   WHERE pool_id = '6077bff0-68a6-4323-96f0-75adf012340e';
  SELECT count(*) INTO v_payouts  FROM bbj_winners
   WHERE pool_id = '6077bff0-68a6-4323-96f0-75adf012340e';
  SELECT union_id INTO v_union FROM clubs
   WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

  -- Refuse to retire a pool that ever held real activity.
  IF v_contribs <> 0 THEN
    RAISE EXCEPTION 'Pre-flight: club pool has % contributions - it is NOT an orphan, do not retire it.', v_contribs;
  END IF;
  IF v_payouts <> 0 THEN
    RAISE EXCEPTION 'Pre-flight: club pool has % payouts - real player money, do not retire it.', v_payouts;
  END IF;
  -- Retiring only makes sense because a union pool exists to take over.
  IF v_union IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: SHARK CLUB has no union_id - retiring its pool would leave it with NO jackpot.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bbj_pools WHERE union_id = v_union AND status = 'active') THEN
    RAISE EXCEPTION 'Pre-flight: no active union pool for % - retiring the club pool would leave no jackpot.', v_union;
  END IF;
END $$;

UPDATE bbj_pools
   SET status         = 'retired',
       main_balance   = 0,
       backup_balance = 0,
       promo_balance  = 0,
       updated_at     = now()
 WHERE id = '6077bff0-68a6-4323-96f0-75adf012340e';

DO $$
DECLARE
  v_active_club_pools int;
  v_union_balance     numeric;
BEGIN
  SELECT count(*) INTO v_active_club_pools
    FROM bbj_pools p JOIN clubs c ON c.id = p.club_id
   WHERE p.status = 'active' AND c.union_id IS NOT NULL;

  SELECT main_balance INTO v_union_balance
    FROM bbj_pools WHERE union_id = 'fade0000-0000-0000-0000-000000000001' AND status = 'active';

  IF v_active_club_pools <> 0 THEN
    RAISE EXCEPTION 'Post-apply: % union-member club(s) still carry an active club pool.', v_active_club_pools;
  END IF;
  IF v_union_balance IS NULL OR v_union_balance <= 0 THEN
    RAISE EXCEPTION 'Post-apply: union pool is missing or empty (%) - the lobby would show no jackpot.', v_union_balance;
  END IF;

  RAISE NOTICE 'Post-apply OK: club pool retired; union pool is the sole jackpot at %.', v_union_balance;
END $$;

-- ============================================================================
-- ROLLBACK:
--   UPDATE bbj_pools
--      SET status='active', main_balance=350.40, backup_balance=262.80,
--          updated_at=now()
--    WHERE id = '6077bff0-68a6-4323-96f0-75adf012340e';
-- ============================================================================
