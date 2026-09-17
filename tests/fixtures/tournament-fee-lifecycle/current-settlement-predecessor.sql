-- Native fixture overlay only; never a production migration or a financial call.
-- Load after the unchanged captured full-schema functions/access, before any
-- complete candidate/prefix transaction that reaches component6. Keep the
-- original historical functions.json and schema.sql unchanged.
-- Exact metadata captured2026-09-17T05:18:36.750981Z under READ ONLY;
-- portable source: current-settlement-catalog.json and its exact query sibling.
-- Origin06-changed-baseline-definitions.json SHA256:
-- a336cd15f88f69b29b8746c85813ecd2e4c40c4e538d93a33994ac8978e26d0a
-- Source migration20260914223105, installed version20260917024037;
-- source commits5240475a1ccad1620ddf2ca3c721eb740d3e9f12 /
-- f37c87cdb1bb4ef387d4348109c5cfa2d287fb6e (explicit service-only ACL).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $predecessor$
DECLARE target oid:=to_regprocedure('public.fn_settle_tournament_rake(uuid,text)');
BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
  RAISE EXCEPTION 'current_settlement_overlay_requires_native_fixture'; END IF;
 IF target IS NULL OR md5(pg_get_functiondef(target)) NOT IN
  ('7cf1d81246d015b65d416ee6b3f96838','46128439ae7a46e4fd8ea2889a7dddf8') THEN
  RAISE EXCEPTION 'current_settlement_overlay_preimage_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=target
  AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'current_settlement_overlay_permissions_changed'; END IF;
END $predecessor$;

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
  v_attempt integer := 0; v_attempts integer := 0;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_global();
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
    SELECT amount, destination, settled_at, attributed_at, attributed_users, attribution_error
      INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    -- A historical claim is not proof that its player attribution completed.
    -- Refuse it without crediting, rewriting, or hiding its original state.
    IF v_prior.settled_at IS NULL OR v_prior.attributed_at IS NULL
       OR v_prior.attributed_users IS NULL OR v_prior.attributed_users < 0
       OR v_prior.attribution_error IS NOT NULL
       OR nullif(v_prior.destination, '') IS NULL OR v_prior.destination = 'pending' THEN
      RETURN jsonb_build_object('ok', false, 'already_settled', true,
        'reason', 'settlement_attribution_incomplete', 'amount', v_prior.amount,
        'destination', v_prior.destination, 'settled_at', v_prior.settled_at,
        'attributed', false);
    END IF;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at, 'attributed', true,
      'attributed_users', v_prior.attributed_users);
  END IF;

  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
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

  /* A transient attribution conflict may retry its rolled-back attempt.
     Exhaustion or a permanent error must escape this function so the fee
     credit, counters and new settlement claim roll back with attribution.
     Existing callers own durable refusal reporting outside this transaction. */
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_att := public.fn_attribute_tournament_rake(p_tournament_id);
      v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
      v_att_err := CASE WHEN v_att_ok THEN NULL
                        ELSE COALESCE(v_att->>'reason', 'attribution returned ok=false') END;
      EXIT;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        IF v_attempt >= 4 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
    END;
  END LOOP;
  v_attempts := v_attempt;

  v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
  v_members := COALESCE((v_att->>'members')::int, 0);

  /* Preserve the existing zero-member rule. A populated field credited
     nobody is incomplete and cannot leave a banked fee for a later repair. */
  v_done := v_att_ok AND (v_users > 0 OR v_members = 0);
  IF v_att_ok AND v_users = 0 AND v_members > 0 THEN
    v_att_err := 'attributed_nobody';
  END IF;
  IF NOT v_done THEN
    RAISE EXCEPTION 'tournament % rake attribution incomplete: %',
      p_tournament_id, COALESCE(v_att_err, 'unknown attribution result')
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_done THEN now() ELSE NULL END,
         attributed_users = v_users,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_done,
                            'attributed_users', v_users, 'members', v_members,
                            'attribution_attempts', v_attempts);
END;
$function$;

DO $current_readback$
DECLARE target oid:=to_regprocedure('public.fn_settle_tournament_rake(uuid,text)');
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=target
  AND md5(pg_get_functiondef(p.oid))='46128439ae7a46e4fd8ea2889a7dddf8'
  AND md5(p.prosrc)='a0bf6f75c5be429f3aa76ba218a2606b'
  AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}')
  OR has_function_privilege('anon',target,'EXECUTE')
  OR has_function_privilege('authenticated',target,'EXECUTE')
  OR NOT has_function_privilege('service_role',target,'EXECUTE') THEN
  RAISE EXCEPTION 'current_settlement_overlay_readback_changed'; END IF;
END $current_readback$;
COMMIT;
