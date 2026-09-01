-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828074402; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CASH BUY-INS ARE 40BB-200BB (Dan 2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan: "Higher buy in games, 10-25 and 25-50 buyins should be 40BB-200BB and
-- currently you can only buy in for 2-4 BB max."
--
-- The broken surface: `NLH 25/50 INSURANCE TEST` carried min_buy_in 100 /
-- max_buy_in 200 — a 2BB/4BB band — inserted by an ad-hoc service-role script,
-- not by any product creation path (every live creator already writes
-- bb*40 / bb*200). Five more rows deviated below the band (100BB caps and a
-- 20BB floor on E2E rows). atomic_table_buyin enforces these columns, so the
-- lobby, the buy-in modal and the enforcement all correct together.
--
-- Tournament rows (tournament_id IS NOT NULL) are untouched: their 0/0 is
-- legitimate. The vestigial *_bb columns are resynced so the two column
-- families cannot disagree.

UPDATE public.tables
   SET min_buy_in    = big_blind * 40,
       max_buy_in    = big_blind * 200,
       min_buy_in_bb = 40,
       max_buy_in_bb = 200
 WHERE tournament_id IS NULL
   AND COALESCE(big_blind, 0) > 0
   AND (min_buy_in IS DISTINCT FROM big_blind * 40
     OR max_buy_in IS DISTINCT FROM big_blind * 200);

-- Assert: no cash row deviates from the band any more.
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tables
   WHERE tournament_id IS NULL
     AND COALESCE(big_blind, 0) > 0
     AND (min_buy_in IS DISTINCT FROM big_blind * 40
       OR max_buy_in IS DISTINCT FROM big_blind * 200);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'cash buy-in normalisation left % deviating rows', v_bad;
  END IF;
END $$;
