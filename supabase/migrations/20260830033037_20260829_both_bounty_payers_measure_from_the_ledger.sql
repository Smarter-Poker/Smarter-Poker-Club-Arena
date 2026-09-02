-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830033037; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  BOTH BOUNTY PAYERS MEASURE FROM THE LEDGER (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Earlier today `fn_finalize_bounty_pool` was changed to compute its residual
-- from the wallet ledger instead of the `bounty_pool_paid` counter, after
-- eight mystery bounty events paid 140.60 more than their pools held.
--
-- THAT FIX WAS INCOMPLETE, and production said so within five hours:
--
--   Saturday Mystery   pool 776.00   paid 783.20   (+7.20)
--   ended 03:07:34, last bounty payment 03:07:41 -- seven seconds AFTER the end
--
-- The reason is that there are TWO payers and I only fixed one.
-- `fn_collect_bounty` decides what is left with the identical stale read:
--
--     v_available := round(COALESCE(v_t.bounty_pool,0)
--                        - COALESCE(v_t.bounty_pool_paid,0), 2);
--
-- `FOR UPDATE` on `tournaments` serialises the two functions against each
-- other, so this is not a lost-update race in the classic sense. It is worse
-- and simpler: the counter is only as good as every writer keeping it current,
-- and any path that pays without incrementing it -- or increments it after
-- another payer has already read -- makes every subsequent cap decision wrong.
-- Fixing one reader while the other still trusts the counter just moves which
-- of them overpays.
--
-- THE RULE, now applied to both: the pool's remaining balance is
--
--     bounty_pool  -  (sum of every 'bounty' wallet_transaction for this
--                      tournament, signed off `type`)
--
-- The ledger cannot be stale relative to the money because it IS the money,
-- and both payers write into it before anybody reads it again. Whatever order
-- collection and finalisation run in, neither can hand out a chip the pool
-- does not hold.
--
-- `bounty_pool_paid` is kept up to date for anything that reads it for
-- reporting, but nothing decides a payment from it any more.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restore `v_available := bounty_pool - bounty_pool_paid`. That re-opens the
-- overpayment on whichever payer runs last.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_src  text;
  v_new  text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_collect_bounty';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_collect_bounty not found';
  END IF;

  -- Replace ONLY the availability computation. Everything else in this
  -- function -- the hybrid tripwire, the mystery-phase handoff, the
  -- already-collected guard, the PKO half-split, the idempotency keys -- is
  -- correct and is left exactly as it is.
  IF position('v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);' in v_src) = 0 THEN
    RAISE EXCEPTION 'the availability line is not where this migration expects it - refusing to patch blind';
  END IF;

  v_new := replace(
    v_src,
    'v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);',
    'SELECT round(COALESCE(v_t.bounty_pool,0) - COALESCE(SUM('
      || 'CASE WHEN lower(wt.type) = ''debit'' THEN -abs(wt.amount) ELSE wt.amount END), 0), 2) '
      || 'INTO v_available FROM wallet_transactions wt '
      || 'WHERE wt.related_entity_id = p_tournament_id AND wt.category = ''bounty'';'
  );

  EXECUTE v_new;
END $$;

REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid, uuid, uuid) TO service_role;

-- ── POST-APPLY ASSERTIONS ────────────────────────────────────────────────
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_collect_bounty';

  IF position('FROM wallet_transactions wt' in v_def) = 0 THEN
    RAISE EXCEPTION 'fn_collect_bounty still does not read the ledger';
  END IF;
  IF position('COALESCE(v_t.bounty_pool_paid,0), 2)' in v_def) > 0 THEN
    RAISE EXCEPTION 'fn_collect_bounty still caps against the stale counter';
  END IF;
  -- The behaviour that must survive the patch.
  IF position('bounty_pool_exhausted' in v_def) = 0
     OR position('undefined_pko_mystery_hybrid' in v_def) = 0
     OR position('mystery_phase_active' in v_def) = 0
     OR position('already_collected' in v_def) = 0 THEN
    RAISE EXCEPTION 'the patch damaged one of the existing guards';
  END IF;

  RAISE NOTICE 'both bounty payers now measure the pool from the ledger';
END $$;
