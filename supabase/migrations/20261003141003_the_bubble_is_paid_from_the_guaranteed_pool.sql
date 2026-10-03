-- 20261003141003_the_bubble_is_paid_from_the_guaranteed_pool.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE BUBBLE IS PAID FROM THE GUARANTEED POOL (phase 6 of 9: money edges).
-- Full account: docs/changelog/2026-10-03-the-bubble-is-paid-from-the-guaranteed-pool.md.
--
-- Alert cc1fb3cc (Tournament.guarantee_not_met, 2026-09-27) says Sunday $200
-- Deep Stack f84852af paid 19,820.00 against a 20,000.00 guarantee. Read from
-- production: places 1 and 2 were paid 12,589.66 and 7,230.34 and the stone
-- bubble 180.00 (tournament_payouts source bubble_protection): 20,000.00 in
-- all, escrow closed at exactly zero. Bubble protection is reserved from the
-- prize pool before the ladder is priced, and the event page shows it as
-- "Bubble Protection ... From Prize Pool". fn_tournament_guarantee_check
-- summed only ladder sources, so every bubble-protected event whose pool sat
-- exactly on its guarantee read 180.00 short (690bfcb0 on 2026-09-14 too,
-- closed then as nothing owed). Nobody is owed anything.
--
-- The check now counts the bubble refund and an overlay backpay as money the
-- guarantee paid out. Everything else in the function is the live text.
-- Refuses to run if the function is not the text measured or its grants
-- differ. No job is added. No chips move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_tournament_guarantee_check(integer)'::regprocedure)) = '1a00e689f8b09aca406dda7ae462b25c')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_guarantee_check(integer)'::regprocedure)) IS DISTINCT FROM 'c86160ed0a10f5a5c94db0b934b7c19f' THEN
    RAISE EXCEPTION 'GUARANTEE_CHECK_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_tournament_guarantee_check(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'GUARANTEE_CHECK_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

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
             /* THE BUBBLE IS PAID FROM THE GUARANTEED POOL (2026-10-03). A
                bubble-protected event reserves one base buy-in for its stone
                bubble out of the prize pool before the ladder is priced, and
                says so on the event page. That refund is part of what the
                guarantee paid out, as is an overlay backpay that made a short
                pool whole. Leaving them out read f84852af (Sunday $200 Deep
                Stack, 2026-09-27: 19,820.00 to places 1-2 plus 180.00 to the
                bubble, 20,000.00 in all) as 180.00 short, and 690bfcb0 on
                2026-09-14 the same way. */
             COALESCE((
               SELECT sum(p.amount) FROM public.tournament_payouts p
                WHERE p.tournament_id = t.id
                  AND p.source IN ('structure','reconcile','hu_shortfall',
                                   'late_reg_adjustment','final_table_deal',
                                   'spin_backpay','bubble_protection',
                                   'overlay_backpay')
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

REVOKE ALL ON FUNCTION public.fn_tournament_guarantee_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_guarantee_check(integer) TO service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_guarantee_check(integer)'::regprocedure)) IS DISTINCT FROM '1a00e689f8b09aca406dda7ae462b25c'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_tournament_guarantee_check(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'GUARANTEE_CHECK_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
