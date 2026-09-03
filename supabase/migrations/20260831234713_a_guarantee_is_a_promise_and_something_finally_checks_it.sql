-- 2026-08-31 - MTT Phase 6: a guarantee is a promise, and something finally
-- checks it.
--
-- NOTHING IN THIS ESTATE EVER ASKED WHETHER A GUARANTEE WAS KEPT.
--
-- Every guarantee check that exists is a PRE-START AFFORDABILITY check, or it
-- excludes the very events that fail. Enumerated against production:
--
--   trg_tournaments_guarantee_affordable  status in ANNOUNCED/REGISTERING/RUNNING
--   fn_overlay_at_risk                    buy_in_amount > 0, and not COMPLETED
--   fn_audit_overlays                     buy_in_amount > 0, measures at start
--   fn_backpay_hu_winner_shortfalls       guaranteed_prize = 0 (excludes these)
--   fn_tournament_conservation_delta      never reads guaranteed_prize at all
--   fn_tournament_metrics (phase 2)       prize_pool > 0
--
-- That last filter is the cruel one. A freeroll's pool is 0 by construction,
-- so its guarantee is the only money it will ever have - and `prize_pool > 0`
-- filters out exactly the event whose pool the defect zeroed. The one detector
-- built to catch "nobody was paid" could not see the nine freerolls that paid
-- nobody.
--
-- MEASURED BEFORE WRITING THIS. 578 completed events finished under their
-- advertised guarantee, 17,192.60 chips in total. 566 of those pre-date the
-- overlay funder (which went live 2026-08-29 and does work: 192 events,
-- 30,202.10 chips). The remaining 12 are the live leak, and twelve of the
-- fourteen short events died BELOW their late-reg cap - the one window in
-- which the funder is never called.
--
-- Nine of them were freerolls. They ranked a full field, up to 326 players,
-- stamped a winner, and paid zero chips to anybody. No alert fired anywhere.
--
-- WHAT THIS FUNCTION IS, AND IS NOT. It is a DETECTOR. It moves no money and
-- repairs nothing - the engine-side fix funds the guarantee at the finish, and
-- the historical backlog is a decision for an owner, not for a sweep. This
-- exists so the question is asked at all.
--
-- It measures what was PAID, from tournament_payouts, not what the pool says.
-- Phase 3 made the record authoritative precisely so a settled question could
-- be answered from evidence rather than from a column an outage can overwrite.
--
-- Satellites are excluded: they award seats, not structure cash, so their pool
-- is not the thing a guarantee would be measured against.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (migration name: a_guarantee_is_a_promise_and_something_finally_checks_it),
-- then verified by two consecutive runs: the first raised 4 alerts, the second
-- raised 0 and the total stayed at 4.
--
-- TIER: 2 (reads only; raises alerts). ROLLBACK at the bottom.

BEGIN;

SET LOCAL lock_timeout = '8s';

CREATE OR REPLACE FUNCTION public.fn_tournament_guarantee_check(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_checked   integer := 0;
  v_short     integer := 0;
  v_unpaid    integer := 0;
  v_chips     numeric := 0;
  v_raised    integer := 0;
  r           record;
BEGIN
  FOR r IN
    WITH scope AS (
      SELECT t.id, t.name, t.club_id, t.guaranteed_prize,
             COALESCE(t.prize_pool, 0) AS pool,
             COALESCE((
               SELECT sum(p.amount) FROM public.tournament_payouts p
                WHERE p.tournament_id = t.id
                  AND p.source IN ('structure','reconcile','hu_shortfall',
                                   'late_reg_adjustment','final_table_deal',
                                   'spin_backpay')
             ), 0) AS paid,
             EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays o
                      WHERE o.tournament_id = t.id) AS overlay_funded,
             t.ended_at
        FROM public.tournaments t
       WHERE COALESCE(t.guaranteed_prize, 0) > 0
         AND t.status = 'COMPLETED'
         AND t.ended_at > now() - make_interval(hours => GREATEST(p_hours, 1))
         AND COALESCE(t.variant, '') <> 'satellite'
         AND UPPER(COALESCE(t.tournament_type, '')) <> 'SATELLITE'
    )
    SELECT * FROM scope
  LOOP
    v_checked := v_checked + 1;

    -- Rounded to the cent before comparing: the payout structure distributes
    -- in basis points with the residual on the last paid place, so an exact
    -- equality test would report a phantom shortfall of a fraction of a chip.
    CONTINUE WHEN round(r.paid, 2) >= round(r.guaranteed_prize, 2);

    v_short := v_short + 1;
    v_chips := v_chips + (r.guaranteed_prize - r.paid);
    IF r.paid = 0 THEN v_unpaid := v_unpaid + 1; END IF;

    -- One alert per event, ever. Re-running this hourly must not manufacture
    -- a new critical for the same settled tournament.
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_alerts a
       WHERE a.source = 'Tournament.guarantee_not_met'
         AND a.context ->> 'tournament_id' = r.id::text
    ) THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (
        CASE WHEN r.paid = 0 THEN 'critical' ELSE 'warning' END,
        'Tournament.guarantee_not_met',
        CASE WHEN r.paid = 0
          THEN 'A tournament advertised a guaranteed prize, crowned its field, and paid nobody anything.'
          ELSE 'A tournament paid out less than its advertised guaranteed prize.'
        END,
        jsonb_build_object(
          'tournament_id',    r.id,
          'tournament_name',  r.name,
          'club_id',          r.club_id,
          'guaranteed_prize', r.guaranteed_prize,
          'prize_pool',       r.pool,
          'actually_paid',    r.paid,
          'shortfall',        round(r.guaranteed_prize - r.paid, 2),
          'overlay_funded',   r.overlay_funded,
          'ended_at',         r.ended_at
        )
      );
      v_raised := v_raised + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'window_hours', GREATEST(p_hours, 1),
    'checked', v_checked,
    'short_of_guarantee', v_short,
    'paid_nothing', v_unpaid,
    'chips_short', round(v_chips, 2),
    'alerts_raised', v_raised
  );
END;
$function$;

-- Operator telemetry and a writer of alerts. Phase 3's rule stands: the
-- browser does not get to call this.
REVOKE ALL ON FUNCTION public.fn_tournament_guarantee_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_guarantee_check(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ===========================================================================
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_tournament_guarantee_check(integer);
-- The estate then goes back to having no way to ask whether a guarantee was
-- kept, which is the state that let 578 events finish short unnoticed.
-- ===========================================================================
