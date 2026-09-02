-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211355; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- SATELLITE OVERLAYS BECOME AN ACKNOWLEDGED BASELINE, NOT A LOOSE END
-- 2026-08-30 (Claude/Cowork satellite audit, phase 1)
--
-- Every completed satellite disbursed more value than its pool collected:
-- partly the DELIBERATE meaning of a guaranteed seat count (the house covers
-- the shortfall), partly the pre-#1935 cash-at-face-value bug, partly the
-- audit back-pays that made four zero-paid winners whole. None of it is
-- chaseable: the chips are in player wallets and the promises were the
-- platform's own. Following the precedent of
-- 20260828082815_the_pre_funding_minting_becomes_an_acknowledged_baseline,
-- the forgiveness becomes DATA — one row per event, exact amount, queryable.
--
-- Measured at apply time: 16 events, 4,132.50 chips total (asserted below).
-- Disbursed = prize cash credited against the event
--           + funded target seats x 200 (180 pool + 20 fee per seat).
--
-- Idempotent: ON CONFLICT DO NOTHING; recomputation cannot double-insert.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.tournament_conservation_baseline (tournament_id, amount, reason)
SELECT s.id,
       round(coalesce(c.c,0) + coalesce(se.n,0)*200 - s.pool, 2),
       'satellite overlay acknowledged 2026-08-30 audit: guarantee shortfall + pre-#1935 cash overpayment + double-qualification back-pays. Not chaseable; house-covered.'
FROM (SELECT id, prize_pool::numeric pool FROM public.tournaments
       WHERE satellite_target_id IS NOT NULL AND status='COMPLETED') s
LEFT JOIN (SELECT related_entity_id rid, sum(amount) c FROM public.wallet_transactions
            WHERE related_entity_id IN (SELECT id FROM public.tournaments WHERE satellite_target_id IS NOT NULL AND status='COMPLETED')
              AND category='prize' AND type='credit' GROUP BY 1) c ON c.rid=s.id
LEFT JOIN (SELECT (metadata->>'satellite_id')::uuid rid, count(*) n FROM public.rake_records
            WHERE source='fn_award_satellite_seat' GROUP BY 1) se ON se.rid=s.id
WHERE coalesce(c.c,0) + coalesce(se.n,0)*200 - s.pool > 0
ON CONFLICT (tournament_id) DO NOTHING;

DO $$
DECLARE v_n int; v_sum numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount),0) INTO v_n, v_sum
    FROM public.tournament_conservation_baseline
   WHERE reason LIKE 'satellite overlay acknowledged 2026-08-30%';
  IF v_n < 16 THEN
    RAISE EXCEPTION 'expected >= 16 acknowledged satellites, found %', v_n;
  END IF;
  IF v_sum < 4132.49 OR v_sum > 4132.51 THEN
    RAISE EXCEPTION 'acknowledged total % differs from the audited 4132.50 — re-audit', v_sum;
  END IF;
END $$;

