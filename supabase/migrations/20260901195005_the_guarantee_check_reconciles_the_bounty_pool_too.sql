-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901195005; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_payout_guarantee_check(
  p_since_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_days     integer := LEAST(GREATEST(COALESCE(p_since_days, 7), 1), 400);
  v_since    timestamptz;
  v_vacant   integer := 0;
  v_vac_chips numeric := 0;
  v_short    integer := 0;
  v_short_chips numeric := 0;
  v_gap      integer := 0;
  v_gap_chips numeric := 0;
  v_bounty   integer := 0;
  v_bounty_chips numeric := 0;
  v_alerts   integer := 0;
  v_row      record;
BEGIN
  v_since := now() - make_interval(days => v_days);

  FOR v_row IN
    WITH ev AS (
      SELECT t.id, t.name, t.club_id, t.tournament_type, t.ended_at,
             COALESCE(t.prize_pool, 0) AS pool,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) AS entrants,
             t.payout_structure
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool, 0) > 0
         AND COALESCE(t.satellite_seats, 0) = 0
         AND COALESCE(t.variant, '') <> 'satellite'
    ), places AS (
      SELECT ev.*, (elem->>'place')::int AS place, (elem->>'percentage')::numeric AS pct
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ev.payout_structure::jsonb) = 'array'
               THEN ev.payout_structure::jsonb ELSE '[]'::jsonb END) elem
    )
    SELECT p.id, p.name, p.club_id, p.tournament_type, p.ended_at, p.pool, p.entrants,
           array_agg(p.place ORDER BY p.place) AS vacant_places,
           round(sum(p.pool * p.pct / 100), 2) AS chips
      FROM places p
     WHERE p.place <= p.entrants
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                        WHERE tp.tournament_id = p.id AND tp.position = p.place)
     GROUP BY p.id, p.name, p.club_id, p.tournament_type, p.ended_at, p.pool, p.entrants
  LOOP
    v_vacant := v_vacant + 1;
    v_vac_chips := v_vac_chips + COALESCE(v_row.chips, 0);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_payout_guarantee_check',
           format('%s ranked a %s-player field but left paid place(s) %s with nobody in them, so %s chips were paid to no one',
                  COALESCE(v_row.name, v_row.id::text), v_row.entrants,
                  array_to_string(v_row.vacant_places, ', '), v_row.chips),
           jsonb_build_object('kind','vacant_paid_place','tournament_id',v_row.id,
             'club_id',v_row.club_id,'tournament_type',v_row.tournament_type,
             'entrants',v_row.entrants,'prize_pool',v_row.pool,
             'vacant_places',to_jsonb(v_row.vacant_places),'chips',v_row.chips,
             'ended_at',v_row.ended_at,
             'detail','whoever finished in those places was mislabelled; no money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'vacant_paid_place'
                          AND fa.context->>'tournament_id' = v_row.id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  FOR v_row IN
    WITH ev AS (
      SELECT t.id, t.name, t.club_id, t.tournament_type, t.ended_at,
             COALESCE(t.prize_pool, 0) AS pool, t.payout_structure
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool, 0) > 0
         AND COALESCE(t.satellite_seats, 0) = 0
         AND COALESCE(t.variant, '') <> 'satellite'
    ), owed AS (
      SELECT ev.id, ev.name, ev.club_id, ev.tournament_type, ev.ended_at,
             tp.user_id, tp.position,
             round(ev.pool * (elem->>'percentage')::numeric / 100, 2) AS place_worth
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ev.payout_structure::jsonb) = 'array'
               THEN ev.payout_structure::jsonb ELSE '[]'::jsonb END) elem
        JOIN public.tournament_players tp
          ON tp.tournament_id = ev.id AND tp.position = (elem->>'place')::int
    )
    SELECT o.*, COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                           WHERE w.related_entity_id = o.id AND w.user_id = o.user_id
                             AND w.type = 'credit'
                             AND w.category IN ('prize','bounty')), 0) AS credited
      FROM owed o
     /* FIVE CENTS, NOT ONE (2026-09-01, same day). place_worth here is the flat
        pool * percentage. The engine allocates in whole cents and gives the
        last paid place the remainder, so a place can legitimately land a cent
        or two either side of the flat figure - the first run of this check
        reported the ninth place of a $100 Freeroll as short by 0.02 on exactly
        that difference, and it was not short. A player who was paid nothing
        still trips this at any tolerance; what the tolerance buys is that the
        one alert it raises is real. */
     WHERE COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = o.id AND w.user_id = o.user_id
                        AND w.type = 'credit'
                        AND w.category IN ('prize','bounty')), 0) + 0.05 < o.place_worth
  LOOP
    v_short := v_short + 1;
    v_short_chips := v_short_chips + (v_row.place_worth - v_row.credited);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_payout_guarantee_check',
           format('%s: the player who finished %s is owed %s and their wallet received %s',
                  COALESCE(v_row.name, v_row.id::text), v_row.position,
                  v_row.place_worth, v_row.credited),
           jsonb_build_object('kind','earner_not_paid','tournament_id',v_row.id,
             'club_id',v_row.club_id,'tournament_type',v_row.tournament_type,
             'user_id',v_row.user_id,'position',v_row.position,
             'place_worth',v_row.place_worth,'credited',v_row.credited,
             'short',round(v_row.place_worth - v_row.credited, 2),
             'ended_at',v_row.ended_at,
             'detail','no money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'earner_not_paid'
                          AND fa.context->>'tournament_id' = v_row.id::text
                          AND fa.context->>'user_id' = v_row.user_id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  /* THE OTHER POOL (2026-09-01). Everything above reconciles the PRIZE pool,
     and a bounty event funds a SECOND pool out of the same buy-in. Nothing
     asked whether that one was paid out, and 38 completed events were holding
     1,931.24 chips of it - 34 of them completed by the stuck-COMPLETING
     watchdog, which settled the rake and never touched bounties. The rule the
     platform already had is that whatever is left settles to the champion;
     fn_backpay_unfinalised_bounty_pools re-drives it. This is the check that
     makes the failure visible rather than the repair. */
  FOR v_row IN
    SELECT t.id, t.name, t.club_id, t.ended_at,
           round(COALESCE(t.bounty_pool, 0), 2) AS pool,
           COALESCE((SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'bounty'), 0) AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.ended_at >= v_since
       AND COALESCE(t.bounty_pool, 0) > 0
  LOOP
    CONTINUE WHEN v_row.paid + 0.01 >= v_row.pool;
    v_bounty := v_bounty + 1;
    v_bounty_chips := v_bounty_chips + (v_row.pool - v_row.paid);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_payout_guarantee_check',
           format('%s funded a %s bounty pool and paid out %s, so %s chips of it reached no player',
                  COALESCE(v_row.name, v_row.id::text), v_row.pool, v_row.paid,
                  round(v_row.pool - v_row.paid, 2)),
           jsonb_build_object('kind','bounty_pool_retained','tournament_id',v_row.id,
             'club_id',v_row.club_id,'bounty_pool',v_row.pool,'paid',v_row.paid,
             'retained',round(v_row.pool - v_row.paid, 2),'ended_at',v_row.ended_at,
             'detail','the residual settles to the champion; fn_backpay_unfinalised_bounty_pools re-drives it. No money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'bounty_pool_retained'
                          AND fa.context->>'tournament_id' = v_row.id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  SELECT count(*), COALESCE(round(sum(gap), 2), 0) INTO v_gap, v_gap_chips
    FROM (
      SELECT t.id,
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id AND w.type='credit'
                          AND w.category='prize'), 0)
           - COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
                        WHERE p.tournament_id = t.id
                          AND p.source NOT IN ('bounty','own_bounty','mystery_bounty_residual')), 0)
             AS gap
        FROM public.tournaments t
       WHERE t.status='COMPLETED' AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool,0) > 0
    ) g
   WHERE g.gap > 0.01;

  IF v_gap > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_payout_guarantee_check',
           format('%s event(s) in the last %s days paid %s chips of prizes that were never written to tournament_payouts; the reconciler reads that record and will treat those chips as still owed',
                  v_gap, v_days, v_gap_chips),
           jsonb_build_object('kind','paid_but_unrecorded','events',v_gap,
             'chips',v_gap_chips,'since_days',v_days,
             'detail','no player is short; this is what arms a double-pay if the pool is ever funded')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source='fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'paid_but_unrecorded'
                          AND fa.created_at > now() - interval '20 hours');
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_days', v_days,
    'vacant_paid_place_events', v_vacant,
    'vacant_paid_place_chips', round(v_vac_chips, 2),
    'earners_not_paid', v_short,
    'earners_not_paid_chips', round(v_short_chips, 2),
    'bounty_pool_retained_events', v_bounty,
    'bounty_pool_retained_chips', round(v_bounty_chips, 2),
    'paid_but_unrecorded_events', v_gap,
    'paid_but_unrecorded_chips', v_gap_chips,
    'alerts_raised', v_alerts);
END;
$function$;
