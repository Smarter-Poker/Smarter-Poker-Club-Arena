-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830035124; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool bigint; v_paid bigint; v_unclaimed bigint; v_stage text;
  v_inflight bigint; v_inflight_n int; v_cap bigint; v_raw bigint;
BEGIN
  SELECT mystery_bounty_stage, COALESCE(mystery_bounty_pool_cents, 0)
    INTO v_stage, v_pool
    FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF v_stage = 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
                              'pool_cents', 0, 'settled_cents', 0, 'balanced', true, 'variance_cents', 0);
  END IF;

  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_paid
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id AND r.paid_at IS NOT NULL;

  -- IN FLIGHT. A chest in 'reserved' or 'revealed' is attached to a named
  -- eliminator and fn_mystery_bounty_pay is going to pay it. It is not the
  -- champion's, and it never was.
  SELECT COALESCE(sum(amount_cents), 0), count(*) INTO v_inflight, v_inflight_n
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status IN ('reserved','revealed');

  -- UNCLAIMED means nobody ever knocked anybody out for it.
  SELECT COALESCE(sum(amount_cents), 0) INTO v_raw
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status = 'available';

  -- CONSERVATION CAP. Whatever the state machine says, the champion cannot be
  -- handed a chip the mystery pool does not still hold.
  v_cap := GREATEST(v_pool - v_paid - v_inflight, 0);
  v_unclaimed := LEAST(v_raw, v_cap);

  -- UNCLAIMED CHESTS GO TO THE CHAMPION. The last player standing was never
  -- knocked out, so their own chest is theirs. The idempotency key is the
  -- tournament, so a re-run cannot pay it twice.
  IF v_unclaimed > 0 AND p_winner_user_id IS NOT NULL THEN
    PERFORM public.fn_credit_and_log(
      p_winner_user_id, (v_unclaimed / 100.0)::numeric,
      'mb-residual:' || p_tournament_id::text,
      'bounty', 'Unclaimed mystery bounty chests awarded to champion',
      p_tournament_id);
    UPDATE public.tournament_players
       SET bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_unclaimed / 100.0), 2)
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_unclaimed / 100.0), 2)
     WHERE id = p_tournament_id;
    v_paid := v_paid + v_unclaimed;
  END IF;

  -- Only what was actually swept is voided. A chest with a reveal in flight
  -- is left alone so the reveal path can still pay the player it belongs to.
  UPDATE public.tournament_bounty_chests SET status = 'void'
   WHERE tournament_id = p_tournament_id AND status = 'available';

  -- Money the champion did not get and the eliminator has not got yet. Loud,
  -- because the alternative -- sweeping it -- is what paid it twice.
  IF v_inflight > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_mystery_bounty_settle',
            'Tournament settled with mystery bounty chests still in flight',
            jsonb_build_object('tournament_id', p_tournament_id,
                               'inflight_chests', v_inflight_n,
                               'inflight_cents', v_inflight,
                               'pool_cents', v_pool,
                               'paid_cents', v_paid,
                               'detail', 'these chests were NOT swept to the champion - they belong to a named eliminator and fn_mystery_bounty_pay should still pay them. If they are never paid, the pool is under-distributed by inflight_cents.'));
  END IF;

  UPDATE public.tournaments SET mystery_bounty_stage = 'complete' WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'pool_cents', v_pool, 'settled_cents', v_paid, 'unclaimed_cents', v_unclaimed,
    'inflight_cents', v_inflight,
    'balanced', v_paid + v_inflight = v_pool,
    'variance_cents', v_paid + v_inflight - v_pool);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) TO service_role;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_settle';

  IF position('IN (''available'',''reserved'',''revealed'')' in v_def) > 0 THEN
    RAISE EXCEPTION 'the sweep still treats an in-flight chest as unclaimed';
  END IF;
  IF position('v_cap := GREATEST(v_pool - v_paid - v_inflight, 0)' in v_def) = 0 THEN
    RAISE EXCEPTION 'the conservation cap is missing';
  END IF;
  IF position('mb-residual:' in v_def) = 0 THEN
    RAISE EXCEPTION 'the champion idempotency key was lost';
  END IF;
  IF position('never_activated' in v_def) = 0 THEN
    RAISE EXCEPTION 'the pending-stage short circuit was lost';
  END IF;
END $$;

DO $$
DECLARE v_events int; v_total numeric;
BEGIN
  WITH b AS (
    SELECT t.id, COALESCE(t.bounty_pool,0) pool,
      (SELECT round(COALESCE(sum(CASE WHEN lower(w.type)='debit' THEN -abs(w.amount) ELSE w.amount END),0),2)
         FROM public.wallet_transactions w
        WHERE w.category='bounty' AND w.related_entity_id=t.id) paid
      FROM public.tournaments t
     WHERE t.status='COMPLETED' AND COALESCE(t.bounty_pool,0) > 0)
  SELECT count(*), round(COALESCE(sum(paid-pool),0),2) INTO v_events, v_total
    FROM b WHERE paid > pool + 0.005;

  IF v_events > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('critical', 'mystery_bounty_double_pay_backlog',
            'Historic mystery bounty overpayment recorded at time of fix - NOT clawed back',
            jsonb_build_object('events', v_events, 'total_overpaid', v_total,
                               'cause', 'fn_mystery_bounty_settle swept chests with a reveal in flight; the reveal then paid the same chest again under a different idempotency key',
                               'fixed_by', '20260830034500_a_chest_with_a_reveal_in_flight_is_not_unclaimed',
                               'decision_owner', 'Dan - reversing credits players have already been shown is not an agent decision'));
  END IF;
END $$;
