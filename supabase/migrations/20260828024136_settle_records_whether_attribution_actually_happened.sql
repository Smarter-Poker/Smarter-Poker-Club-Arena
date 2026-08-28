-- fn_settle_tournament_rake now WRITES DOWN whether attribution succeeded, so
-- fn_repair_tournament_rake_attribution has a queue to work from. Unchanged in
-- every other respect: the rake still settles even when attribution throws,
-- because the chips are already banked and rolling the settlement back over a
-- downstream VIP-points failure would be the worse trade. The difference is
-- that the failure is now a row the repair sweep can find, not only a warning
-- somebody has to read.

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb; v_att_ok boolean := false;
  v_att_err text;
BEGIN
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
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
           -- Nothing to attribute: closed, not queued.
           attributed_at = now()
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

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

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_att_ok THEN now() ELSE NULL END,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_att_ok,
                            'attributed_users', COALESCE(v_att->>'attributed_users', '0')::int);
END;
$function$;

DO $post$
BEGIN
  -- The settle path must be able to leave a row unattributed, or the repair
  -- queue can never fill and the sweep is decoration. Assert on the executable
  -- definition, not on any comment text.
  IF position('attributed_at = CASE WHEN v_att_ok' IN
       pg_get_functiondef('public.fn_settle_tournament_rake(uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake does not record attribution state';
  END IF;
END
$post$;
