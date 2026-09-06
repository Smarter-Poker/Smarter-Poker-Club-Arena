-- TOURNAMENT RAKE SETTLES IN THE SAME LOCK ORDER AS CASH RAKE.
--
-- ROOT CAUSE, from the Postgres log for the 24 hours to 2026-09-06 15:15 UTC:
-- 249 deadlocks between fn_settle_tournament_rake and atomic_distribute_rake -
-- 136 "while inserting index tuple in union_wallets", 74 on club_wallets, 39
-- on clubs. Same club, same union, two rake writers:
--
--   atomic_distribute_rake (every cash hand):   club_wallets -> union_wallets | clubs
--   fn_settle_tournament_rake (every event end): union_wallets | clubs -> club_wallets
--
-- Mirror images. Whenever a cash hand's rake landed while an event in the
-- same club settled its fee, one of them was killed. When it was the
-- settlement, the fee sat unsettled until the sweep found it - the 'sweep'
-- rows the escrow shadow filed as "fee left in escrow" on 09-03 and 09-04 (H2)
-- - and when it was the cash hand, its rake row was retried or lost.
--
-- THE FIX IS THE ORDER. fn_settle_tournament_rake now takes the club_wallets
-- row BEFORE it credits the union wallet or the club treasury, so both
-- writers acquire club_wallets first and the union/clubs row second. Its
-- tournaments lock also drops from FOR UPDATE to FOR NO KEY UPDATE, so a
-- cash hand's rake_records FK check (KEY SHARE on the tournament) no longer
-- waits behind a settlement. Amounts, destinations, attribution and the
-- settlement record are unchanged. No sweep was added; the one that exists
-- should now find nothing.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb; v_att_ok boolean := false;
  v_att_err text; v_users integer; v_members integer; v_done boolean := false;
BEGIN
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR NO KEY UPDATE;
  /* NO KEY UPDATE, not UPDATE (20260906): a cash hand's rake_records row
     references this tournament and takes KEY SHARE on it, which FOR UPDATE
     refused and NO KEY UPDATE admits. Settlement is still serialised against
     itself. */
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_terminal', 'status', v_t.status);
  END IF;

  INSERT INTO public.tournament_rake_settlements (tournament_id, club_id, amount, destination, source)
  VALUES (p_tournament_id, v_t.club_id, 0, 'pending', COALESCE(p_source, 'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT amount, destination, settled_at INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at);
  END IF;

  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;

  IF v_net <= 0 OR v_t.club_id IS NULL THEN
    UPDATE public.tournament_rake_settlements
       SET amount = GREATEST(v_net, 0),
           destination = CASE WHEN v_t.club_id IS NULL THEN 'no_club' ELSE 'none' END,
           settled_at = now(),
           attributed_at = now(),
           attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

  /* ONE LOCK ORDER WITH atomic_distribute_rake (20260906). The cash path
     locks club_wallets FIRST and then union_wallets or clubs. This function
     credited the union wallet (or the club treasury) first and touched
     club_wallets last - the mirror image - and the two met in the middle 249
     times a day. Taking the club_wallets row here, before either credit, puts
     both writers in the same order: club_wallets -> union_wallets | clubs. */
  PERFORM 1 FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE;

  -- ZERO-DRIFT phase 2: banked tournament rake = 'rake' vs the tournament.
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  IF v_union IS NOT NULL THEN
    v_res := public.increment_union_wallet(
      v_union, v_net, v_t.club_id,
      'Tournament rake: ' || COALESCE(v_t.name, 'tournament')
        || ' (' || COALESCE(v_t.current_players, 0) || ' entries)'
        || ' [tournament ' || p_tournament_id || ']');
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake: union wallet credit failed for %: %',
        p_tournament_id, v_res;
    END IF;
    v_dest := 'union:' || v_union;
  ELSE
    PERFORM public.credit_club_rake_to_treasury(v_t.club_id, v_net);
    v_dest := 'club_treasury:' || v_t.club_id;
  END IF;

  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  BEGIN
    v_att := public.fn_attribute_tournament_rake(p_tournament_id);
    v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
    IF NOT v_att_ok THEN
      v_att_err := COALESCE(v_att->>'reason', 'attribution returned ok=false');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_att_err := SQLERRM;
    v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_settle_tournament_rake',
            'Rake settled but attribution failed: ' || v_att_err,
            jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net));
  END;

  v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
  v_members := COALESCE((v_att->>'members')::int, 0);

  /* ZERO IS NOT SUCCESS. Banked rake that credited nobody, while there were
     players to credit, is a FAILURE: it stays in the repair queue
     (attributed_at IS NULL) instead of being stamped as done. A settlement
     with no members is terminal - retrying it forever would pin the head of
     that queue, which is the failure mode the Heads-Up back-pay hit. */
  v_done := v_att_ok AND (v_users > 0 OR v_members = 0);
  IF v_att_ok AND v_users = 0 AND v_members > 0 THEN
    v_att_err := 'attributed_nobody';
  END IF;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_done THEN now() ELSE NULL END,
         attributed_users = v_users,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_done,
                            'attributed_users', v_users, 'members', v_members);
END;
$function$;

DO $verify$
DECLARE v_src text; p_lock int; p_union int; p_club int; p_wallet int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_settle_tournament_rake' AND pronamespace = 'public'::regnamespace;
  p_lock   := position('FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE' in v_src);
  p_union  := position('public.increment_union_wallet(' in v_src);
  p_club   := position('public.credit_club_rake_to_treasury(' in v_src);
  p_wallet := position('UPDATE public.club_wallets' in v_src);
  IF p_lock = 0 OR p_lock > p_union OR p_lock > p_club OR p_lock > p_wallet THEN
    RAISE EXCEPTION 'VERIFY FAILED: club_wallets is not locked before the union/treasury credit (lock %, union %, club %, wallet %)',
      p_lock, p_union, p_club, p_wallet;
  END IF;
  IF v_src ~ 'p_tournament_id FOR UPDATE;' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the tournaments lock is still FOR UPDATE';
  END IF;
  -- the cash writer's order is what this now matches; pin it too
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'atomic_distribute_rake' AND pronamespace = 'public'::regnamespace;
  IF position('UPDATE public.club_wallets' in v_src) > position('INSERT INTO public.union_wallets' in v_src)
     OR position('UPDATE public.club_wallets' in v_src) > position('UPDATE public.clubs' in v_src) THEN
    RAISE EXCEPTION 'VERIFY FAILED: atomic_distribute_rake no longer locks club_wallets first; re-derive the order before applying';
  END IF;
  RAISE NOTICE 'RAKE_LOCK_ORDER both writers: club_wallets -> union_wallets | clubs';
END $verify$;

COMMIT;
