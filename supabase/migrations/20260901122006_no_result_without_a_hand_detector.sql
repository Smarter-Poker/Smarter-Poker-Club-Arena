-- ═══════════════════════════════════════════════════════════════════════════
--  NO RESULT WITHOUT A HAND - the detector (2026-09-01, Phase 7)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Seven tournaments between 2026-08-15 and 2026-08-30 were COMPLETED with a
-- full set of finishing places, a stamped winner and, in five of them, real
-- chips paid - and not one hand was ever dealt in any of them. The finishing
-- order came from the stuck-COMPLETING rescue sorting a field in which every
-- survivor held exactly starting_chips, which is not a sort at all.
--
--   event                          entrants  ranked  seconds  chips paid
--   $100 Freeroll 6:00 PM               313     312       58        0.00
--   $100 Freeroll 12:00 PM              326     325       89        0.00
--   Friday Six-Card Nightcap             24      23      216      216.00
--   Sunday Deep Stack Satellite $5       24      23       84      108.00
--   Turbo Tuesday PLO Deepstack          24      23       89      216.00
--   All-In or Fold Frenzy                16      15       91       32.00
--   Afternoon Bounty (NLH)               18      17      199      203.00
--
-- Nothing on the platform noticed, for the whole two weeks. The engine guard
-- shipping alongside this migration stops the rescue inventing another one;
-- this function is the part that makes the CLASS visible, so a new cause
-- arriving by some other route cannot be silent the way this one was.
--
-- IT MOVES NO MONEY. It reports, exactly like fn_spin_unpaid_check. Who is owed
-- what on an event that never dealt is a human decision.
--
-- WHY THE WINDOW IS SHORT. sp_prune_hand_history deletes horse-only hands after
-- hand_history_retention_policy.horse_retention_days (7 as this was written),
-- and 99.95% of hands here are horse-only. Past that window an empty
-- hand_history means the prune ran, not that nothing happened, so a wider scan
-- would manufacture false criticals for every settled event on the platform.
-- The default is deliberately inside the policy value and is read from it.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_detect_results_without_a_hand(integer);

CREATE OR REPLACE FUNCTION public.fn_detect_results_without_a_hand(
  p_since_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_retention integer;
  v_days      integer;
  v_since     timestamptz;
  v_flagged   integer := 0;
  v_alerts    integer := 0;
  v_chips     numeric := 0;
  v_parked    integer := 0;
  v_ids       uuid[] := ARRAY[]::uuid[];
  v_row       record;
BEGIN
  -- Never scan further back than the hand history is trusted to reach.
  SELECT COALESCE(horse_retention_days, 7) INTO v_retention
    FROM public.hand_history_retention_policy LIMIT 1;
  v_retention := GREATEST(COALESCE(v_retention, 7) - 1, 1);
  v_days := LEAST(GREATEST(COALESCE(p_since_days, v_retention), 1), v_retention);
  v_since := now() - make_interval(days => v_days);

  FOR v_row IN
    SELECT t.id,
           t.name,
           t.club_id,
           t.started_at,
           t.ended_at,
           EXTRACT(epoch FROM (t.ended_at - t.started_at))::integer AS secs,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id)                          AS entrants,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.position IS NOT NULL) AS ranked,
           (SELECT COALESCE(sum(p.amount), 0) FROM public.tournament_payouts p
             WHERE p.tournament_id = t.id)                           AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.started_at IS NOT NULL
       AND t.started_at >= v_since
       AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                        WHERE hh.tournament_id = t.id)
       AND EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_id = t.id AND tp.position IS NOT NULL)
  LOOP
    v_flagged := v_flagged + 1;
    v_chips   := v_chips + COALESCE(v_row.paid, 0);
    v_ids     := v_ids || v_row.id;

    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical',
           'fn_detect_results_without_a_hand',
           format(
             'Tournament %s ranked %s of %s entrant(s) and paid %s chips, and not one hand was ever dealt in it',
             COALESCE(v_row.name, v_row.id::text), v_row.ranked, v_row.entrants,
             round(COALESCE(v_row.paid, 0), 2)),
           jsonb_build_object(
             'tournament_id',   v_row.id,
             'club_id',         v_row.club_id,
             'entrants',        v_row.entrants,
             'ranked',          v_row.ranked,
             'chips_paid',      round(COALESCE(v_row.paid, 0), 2),
             'started_at',      v_row.started_at,
             'ended_at',        v_row.ended_at,
             'seconds_to_end',  v_row.secs,
             'detail',          'no money was moved by this check; who is owed what on an event that never dealt is a human decision')
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_detect_results_without_a_hand'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'tournament_id' = v_row.id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  -- Informational, never alerted: events the engine guard is holding back from
  -- exactly this fate. A number climbing here is the guard working, not a leak.
  SELECT count(*) INTO v_parked
    FROM public.tournaments t
   WHERE t.status = 'COMPLETING'
     AND t.started_at IS NOT NULL
     AND t.started_at >= v_since
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                      WHERE hh.tournament_id = t.id);

  RETURN jsonb_build_object(
    'ok',                true,
    'since_days',        v_days,
    'flagged',           v_flagged,
    'alerts_raised',     v_alerts,
    'chips_paid',        round(v_chips, 2),
    'parked_completing', v_parked,
    'tournament_ids',    to_jsonb(v_ids));
END;
$function$;

COMMENT ON FUNCTION public.fn_detect_results_without_a_hand(integer) IS
  'Flags COMPLETED tournaments that carry finishing places while hand_history holds no hand for them: a result that no poker produced. Raises one deduped critical financial_alert per offender and moves no money. Bounded to the horse-only hand retention window, past which an empty history proves nothing.';

GRANT EXECUTE ON FUNCTION public.fn_detect_results_without_a_hand(integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_detect_results_without_a_hand')
  THEN
    RAISE EXCEPTION 'fn_detect_results_without_a_hand was not created';
  END IF;
END $$;
