-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831003400; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-08-30 heads-up/spin audit fixes
--
-- 1. fn_spin_rake_rate: flatten to 0.08. The banded 8/7/6/5 scheme was retired
--    from spinSpec.ts on 2026-08-27 (Dan's ruling: ONE multiplier table, whose
--    expectation satisfies E[mult] = seats*(1-rake) ONLY at 8%). The engine
--    settle path already books 8% (spinRakeRate ignores buy-in); this SQL
--    mirror still booked 5-7% above a 5 buy-in, so a spin settled by the
--    fn_spin_sweep_unbooked recovery path booked a DIFFERENT rake and reserve
--    deposit than the same spin settled by the engine.
--
-- 2. fn_spin_sweep_unbooked: settle on SPIN_SEATS = 3, not count(tournament_players).
--    A Spin is 3-handed by definition and the engine settles every spin at 3
--    seats (TournamentManagerBase forces SPIN_SEATS); counting rows lets a
--    stray/missing tournament_players row book a different collected total
--    than the engine would. The "did anybody enter" guard stays.
--
-- 3. tables.game_type law: backfill the three variant-valued rows written by
--    the TableConfigPage bug (fixed client-side in the same PR: it wrote the
--    VARIANT into game_type, so owner-created tables never matched the
--    sit-out / zero-chip eviction sweeps' t.game_type = 'cash' gate), then
--    add a CHECK so the regression cannot land silently again.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1 ─ flat rake
CREATE OR REPLACE FUNCTION public.fn_spin_rake_rate(p_buy_in numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- ONE rate at every stake. The multiplier table is what actually charges
  -- the rake, and its expectation (2.7638 over 3 seats) is 8% and no other
  -- number. See src/config/spinSpec.ts "THE BANDS ARE GONE".
  SELECT 0.08;
$function$;

-- 2 ─ sweep settles at the spin's defined seat count
CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record; v_n integer := 0; v_fail integer := 0; v_skipped integer := 0;
  v_res jsonb; v_repair jsonb; v_failures jsonb := '[]'::jsonb;
BEGIN
  BEGIN
    v_repair := public.fn_spin_repair_missing_multiplier(p_lookback_mins);
  EXCEPTION WHEN OTHERS THEN
    v_repair := jsonb_build_object('ok', false, 'reason', SQLERRM);
  END;

  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.spin_multiplier
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      -- Did anybody actually enter? current_players drains to zero, so test
      -- the rows, not the counter. A spin nobody entered has nothing to book.
      AND EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id)
      AND t.started_at > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
  LOOP
    BEGIN
      -- SPIN_SEATS = 3, by definition and to match the engine settle path
      -- exactly (TournamentManagerBase forces 3 regardless of row counts).
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, 3, v_t.spin_multiplier,
        public.fn_spin_rake_rate(v_t.buy_in_amount));
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_n := v_n + 1;
      ELSE
        v_fail := v_fail + 1;
        v_failures := v_failures || jsonb_build_object(
          'tournament_id', v_t.id, 'reason', COALESCE(v_res->>'reason', 'refused'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
      v_failures := v_failures || jsonb_build_object(
        'tournament_id', v_t.id, 'sqlstate', SQLSTATE, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'failures', v_failures,
                            'skipped_no_entrants', v_skipped,
                            'lookback_mins', p_lookback_mins,
                            'multiplier_repair', v_repair);
END;
$function$;

-- 3 ─ tables.game_type is the FORMAT
UPDATE public.tables
   SET game_type = 'cash'
 WHERE game_type NOT IN ('cash', 'tournament');

ALTER TABLE public.tables
  ADD CONSTRAINT tables_game_type_is_format
  CHECK (game_type IN ('cash', 'tournament'));

-- ─ assertions ─
DO $$
BEGIN
  IF public.fn_spin_rake_rate(1) <> 0.08 OR public.fn_spin_rake_rate(100) <> 0.08 THEN
    RAISE EXCEPTION 'fn_spin_rake_rate is not flat 0.08';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables WHERE game_type NOT IN ('cash','tournament')) THEN
    RAISE EXCEPTION 'tables.game_type backfill incomplete';
  END IF;
END $$;

-- ROLLBACK (Tier 3 notes):
--   CREATE OR REPLACE fn_spin_rake_rate with the banded CASE (see
--     20260827_tournament_rake_attribution_and_creation_caps.sql lines 58-70);
--   CREATE OR REPLACE fn_spin_sweep_unbooked from
--     20260828033000 (seats_sold subquery version);
--   ALTER TABLE public.tables DROP CONSTRAINT tables_game_type_is_format;
--   (game_type backfill of 3 rows is not reversible without the row list:
--    'nlhe','PLO6','NLH' — one row each as of 2026-08-30.)

