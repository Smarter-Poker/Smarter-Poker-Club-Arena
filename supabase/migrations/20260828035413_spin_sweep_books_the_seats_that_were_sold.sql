-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828035413; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  THE SPIN SWEEP BOOKED THE SEATS THAT WERE LEFT, NOT THE SEATS THAT SOLD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_spin_sweep_unbooked settled each unbooked Spin with t.current_players.
-- That column is a LIVE seat count: it drains as players bust, so by the time
-- the sweep reaches a finished Spin it can be anything from the real field down
-- to 1. fn_spin_settle_game multiplies it by the buy-in to get `collected` and
-- takes the house rake off that number, so a drained counter under-books both.
--
-- PROVEN, not assumed. A real 3-seat 10.00 Spin, unbooked and its counter
-- drained the way a finished Spin drains it, all inside a transaction that
-- rolled itself back:
--
--   PROBE5 buyin=10.00 entrants=3 current_players=1
--          sweep={"ok": true, "settled": 1, "failed": 0}
--          booked seats=1 (want 3)
--
-- 10.00 collected instead of 30.00, and the rake taken off a third of the real
-- number.
--
-- AFTER THIS MIGRATION, same Spin, same drained counter:
--
--   REPROBE5 booked seats=3 (want 3)
--
-- LIVE EXPOSURE IS SMALL AND THE REASON IS ITSELF A BUG. spin_reserve_ledger
-- holds 2 rows booked at seats=2 whose events really had 3, against 47,608
-- correct rows at seats=3 - about 2.00 of collected and 0.16 of rake. The
-- incidence is low because the old WHERE clause ALSO required
-- current_players > 0, so a Spin whose counter had drained all the way to zero
-- was skipped rather than mis-booked. Skipping is not safety: a skipped Spin is
-- one whose rake is never taken at all. That filter is replaced by the honest
-- question - did anybody actually enter - so a fully drained counter now books
-- correctly instead of being passed over.
--
-- The two mis-booked rows are left alone deliberately. Correcting them means
-- charging a club retrospectively for 2.00, and the standing rule after the
-- duplicate-place work is that a retrospective charge is a decision, not a
-- side effect of a repair.
--
-- SEATS SOLD MEANS ROWS IN tournament_players. They survive elimination and are
-- removed only by an unregistration while registration is still open, which is
-- the same reason the tournament payout reconciler counts the field that way.

CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_n integer := 0; v_fail integer := 0; v_skipped integer := 0;
  v_res jsonb; v_repair jsonb;
BEGIN
  BEGIN
    v_repair := public.fn_spin_repair_missing_multiplier(p_lookback_mins);
  EXCEPTION WHEN OTHERS THEN
    v_repair := jsonb_build_object('ok', false, 'reason', SQLERRM);
  END;

  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.spin_multiplier,
           -- The seats that were SOLD. t.current_players is what is LEFT, and
           -- settling on it under-books collected and the rake taken off it.
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS seats_sold
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      -- Did anybody actually enter? The old test was current_players > 0,
      -- which skips a Spin whose live counter has drained to zero - and a
      -- skipped Spin is one whose rake is never taken at all.
      AND EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id)
      AND t.started_at > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
  LOOP
    -- Belt: never book a seat count of zero or below. Nothing sold means
    -- nothing to collect, and settling it would write a ledger row that
    -- permanently marks the event as booked for nothing.
    IF COALESCE(v_t.seats_sold, 0) < 1 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, v_t.seats_sold, v_t.spin_multiplier,
        public.fn_spin_rake_rate(v_t.buy_in_amount));
      IF COALESCE((v_res->>'ok')::boolean, false) THEN v_n := v_n + 1;
      ELSE v_fail := v_fail + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'skipped_no_entrants', v_skipped,
                            'lookback_mins', p_lookback_mins,
                            'multiplier_repair', v_repair);
END; $function$;

REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_sweep_unbooked(integer) TO service_role;

COMMENT ON FUNCTION public.fn_spin_sweep_unbooked(integer) IS
  'Books any Spin that finished without a spin_reserve_ledger row, settling on the seats that were SOLD (rows in tournament_players) rather than on current_players, which drains as players bust. Fixed 2026-08-27.';

