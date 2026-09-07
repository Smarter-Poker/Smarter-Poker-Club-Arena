-- ═══════════════════════════════════════════════════════════════════════════
--  A POOL THAT IS FULLY PAID HAS NOBODY LEFT TO PAY,
--  AND AN ALARM THAT NEVER CLEARS IS AN ALARM NOBODY READS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On 2026-09-07 there were 233 open `financial_alerts`, 6 of them the critical
-- "the player who finished N is owed X and their wallet received Y". Read one
-- by one against the rows:
--
--   Sunday $200 Deep Stack  13,441.68  pool 52,920.00  credited 52,920.00
--   Sunday $200 Deep Stack   8,282.69  pool 28,640.00  credited 28,640.00
--   20 Chip Spin PLO4           60.00  pool     60.00  credited     55.20  <- real
--   PLO4 Heads-Up 25            23.75  pool     71.25  credited     71.25
--   Sunday Funday Main Event     0.07  pool 14,850.00  credited 14,850.00
--   DSS Tuesday $11 PLO5         0.06  pool  1,350.00  credited  1,350.00
--
-- ONE of the six was a player who could actually be paid. Five were events
-- whose prize pool had already left the escrow to the last chip:
--   * two were paid IN FULL at 04:10, hours AFTER the alert was raised, and
--     nothing ever went back to close it;
--   * one was settled by a `final_table_deal` - the players agreed a split, the
--     whole 71.25 was distributed, and the check compared the winner against a
--     `payout_structure` the deal had replaced;
--   * two are sub-0.10 rounding on pools of 14,850 and 1,350 - the engine
--     allocates in whole cents and hands the remainder to the last paid place.
--
-- ── WHY THAT MATTERS MORE THAN THE 4.80 ────────────────────────────────────
-- The reconciler reads the same signal. On the Heads-Up event it tried to top
-- the winner up by 23.75 out of a pool that was already fully distributed, and
-- the ONLY thing that stopped a real double payment was
-- `fn_settle_tournament_obligation` refusing an empty escrow. A false alarm
-- nearly moved money.
--
-- And the true one - a player 4.80 short since the previous afternoon - sat
-- fifth in a list of six that a reader has been taught to skim.
--
-- ── THE RULE THIS ENCODES ──────────────────────────────────────────────────
-- "A player was not paid" is a claim that money is still there and someone is
-- short. If the pool is fully distributed that claim is false whatever the
-- structure says: at worst a place is mislabelled, or a deal replaced the
-- structure, or a cent landed next door. Those are different questions and
-- none of them is answered by paying somebody.
--
-- So the critical alert now requires an UNDISTRIBUTED pool, and the rest are
-- counted in the return payload (`short_of_structure_but_pool_distributed`)
-- rather than alarmed. Measured over seven days and 76,760 paid places on
-- fully distributed events: the median difference between the flat
-- `pool * percentage` and what a place actually received is **0.0000**, only
-- **1,056** places differ by more than 0.05, and **1,051** of those differ by
-- more than 1.00 - so alarming on that band would raise a thousand rows a week
-- and silence itself inside a day (10.84).
--
-- ── AND IT CLEARS ITSELF ───────────────────────────────────────────────────
-- 10.11 rule 5: the net stays, and is expected to find nothing. Every run now
-- first resolves any open `earner_not_paid` alert whose condition no longer
-- holds. That is what was missing: the check has a NOT EXISTS guard so it
-- never duplicates an alert, and no path at all to close one. Once raised it
-- was open for ever - which is how a critical list becomes 233 rows long.
--
-- ROLLBACK: restore the previous body; the only changes are the
-- self-resolution block at the top and the pool test inside the earner loop.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_payout_guarantee_check(p_since_days integer DEFAULT 7)
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
  v_cleared  integer := 0;
  v_labelled integer := 0;
  v_row      record;
BEGIN
  v_since := now() - make_interval(days => v_days);

  /* ── CLEAR WHAT IS NO LONGER TRUE (2026-09-07) ─────────────────────────────
     This check could raise an earner_not_paid alert and never close one. Two
     of the six open on 2026-09-07 had been paid IN FULL at 04:10, hours after
     the alert, and the row still read critical. An alarm that cannot clear is
     an alarm that gets skimmed, and the one real case in that list - a player
     4.80 short - had been sitting in it for a day.
     An alert clears when either half of its claim stops holding: the player
     has since been credited to within five cents of the place, or the event's
     prize pool has left the escrow to the last chip, in which case there is
     nothing left to pay them with and this is not the alert for it. */
  WITH open_alerts AS (
    SELECT fa.id,
           (fa.context->>'tournament_id')::uuid AS tid,
           (fa.context->>'user_id')::uuid       AS uid,
           (fa.context->>'place_worth')::numeric AS place_worth
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_payout_guarantee_check'
       AND fa.resolved IS NOT TRUE
       AND fa.context->>'kind' = 'earner_not_paid'
       AND fa.context ? 'tournament_id'
       AND fa.context ? 'user_id'
  ), judged AS (
    SELECT a.id,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = a.tid AND w.user_id = a.uid
                        AND w.type = 'credit' AND w.category IN ('prize','bounty')), 0) AS credited,
           a.place_worth,
           COALESCE(t.prize_pool, 0) AS pool,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = a.tid
                        AND w.type = 'credit' AND w.category = 'prize'), 0) AS pool_paid
      FROM open_alerts a
      LEFT JOIN public.tournaments t ON t.id = a.tid
  )
  UPDATE public.financial_alerts fa
     SET resolved = true,
         resolved_at = now(),
         resolution = CASE
           WHEN j.credited + 0.05 >= j.place_worth
             THEN format('Cleared by fn_payout_guarantee_check: the player has since been credited %s against a place worth %s.',
                         round(j.credited, 2), round(j.place_worth, 2))
           ELSE format('Cleared by fn_payout_guarantee_check: the event''s prize pool of %s has been distributed in full (%s paid), so there is nothing left to pay this place with. A place that received less than the flat structure share of a fully distributed pool is a labelling, deal or obligation question, not an unpaid player.',
                         round(j.pool, 2), round(j.pool_paid, 2))
         END
    FROM judged j
   WHERE fa.id = j.id
     AND (j.credited + 0.05 >= j.place_worth
          OR (j.pool > 0 AND j.pool_paid + 0.01 >= j.pool));
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

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
             COALESCE(t.prize_pool, 0) AS pool, t.payout_structure,
             /* WHAT LEFT THE ESCROW. The discriminator between "a player is
                short and the money is still here" and "the pool is gone and
                this place got less than the flat share". Only the first is an
                unpaid player. */
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit' AND w.category = 'prize'), 0) AS pool_paid
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool, 0) > 0
         AND COALESCE(t.satellite_seats, 0) = 0
         AND COALESCE(t.variant, '') <> 'satellite'
    ), owed AS (
      SELECT ev.id, ev.name, ev.club_id, ev.tournament_type, ev.ended_at,
             ev.pool, ev.pool_paid,
             tp.user_id, tp.position,
             round(ev.pool * (elem->>'percentage')::numeric / 100, 2) AS place_worth
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ev.payout_structure::jsonb) = 'array'
               THEN ev.payout_structure::jsonb ELSE '[]'::jsonb END) elem
        JOIN public.tournament_players tp
          ON tp.tournament_id = ev.id AND tp.position = (elem->>'place')::int
    )
    SELECT o.*,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = o.id AND w.user_id = o.user_id
                        AND w.type = 'credit'
                        AND w.category IN ('prize','bounty')), 0) AS credited,
           (o.pool_paid + 0.01 >= o.pool) AS pool_distributed
      FROM owed o
     /* FIVE CENTS, NOT ONE (2026-09-01). place_worth here is the flat
        pool * percentage. The engine allocates in whole cents and gives the
        last paid place the remainder, so a place can legitimately land a cent
        or two either side of the flat figure. */
     WHERE COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = o.id AND w.user_id = o.user_id
                        AND w.type = 'credit'
                        AND w.category IN ('prize','bounty')), 0) + 0.05 < o.place_worth
  LOOP
    /* THE POOL TEST (2026-09-07). Five of the six alerts open when this was
       written named events whose pool had already left the escrow to the last
       chip - two paid in full hours after the alert, one settled by a
       final_table_deal that replaced the structure, two off by 0.07 and 0.06
       on pools of 14,850 and 1,350. Counted, not alarmed: nothing can be paid
       out of a pool that is gone, and the reconciler reading this as an unpaid
       player tried to top one of them up by 23.75 - a real double payment,
       stopped only by the empty escrow it would have come from. */
    IF v_row.pool_distributed THEN
      v_labelled := v_labelled + 1;
      CONTINUE;
    END IF;

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
             'prize_pool',v_row.pool,'pool_paid',v_row.pool_paid,
             'ended_at',v_row.ended_at,
             'detail','the prize pool has NOT been fully distributed, so these chips are still in the escrow and this player can be paid. No money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'earner_not_paid'
                          AND fa.context->>'tournament_id' = v_row.id::text
                          AND fa.context->>'user_id' = v_row.user_id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  /* THE OTHER POOL (2026-09-01). Everything above reconciles the PRIZE pool,
     and a bounty event funds a SECOND pool out of the same buy-in. */
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
    -- Counted, never alarmed: a place that received less than the flat
    -- structure share of a pool that is already fully distributed. Measured
    -- 2026-09-07 over 76,760 paid places on fully distributed events: median
    -- difference 0.0000, 1,056 over 0.05, 1,051 of those over 1.00.
    'short_of_structure_but_pool_distributed', v_labelled,
    'alerts_cleared', v_cleared,
    'bounty_pool_retained_events', v_bounty,
    'bounty_pool_retained_chips', round(v_bounty_chips, 2),
    'paid_but_unrecorded_events', v_gap,
    'paid_but_unrecorded_chips', v_gap_chips,
    'alerts_raised', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_payout_guarantee_check(integer) IS
  'Raises a critical alert only when a place is short AND the event''s prize '
  'pool has not been fully distributed - money still in the escrow and a '
  'player who can be paid from it. A place short of the flat structure share '
  'of a pool that is already gone (a final_table_deal, a relabelled place, a '
  'cent of rounding) is counted, not alarmed. Every run also RESOLVES open '
  'earner_not_paid alerts whose condition no longer holds; before 2026-09-07 '
  'it could raise one and never close one, and five of the six open were '
  'false.';

COMMIT;

-- ── POST-CHECKS ────────────────────────────────────────────────────────────
DO $$
DECLARE v_res jsonb; v_open int;
BEGIN
  v_res := public.fn_payout_guarantee_check(7);
  IF NOT (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION 'post-check: the guarantee check did not return ok';
  END IF;

  SELECT count(*) INTO v_open
    FROM public.financial_alerts
   WHERE source = 'fn_payout_guarantee_check'
     AND resolved IS NOT TRUE
     AND context->>'kind' = 'earner_not_paid';

  RAISE NOTICE 'guarantee check: %; open earner_not_paid alerts now %', v_res, v_open;
END $$;
