-- Self-aborting regression probe. Every transfer and history row rolls back.
DO $$
DECLARE
  v_club uuid; v_host uuid; v_kind text; v_owner uuid; v_key text; v_source uuid;
  v_result jsonb; v_leg public.chip_ledger%ROWTYPE; v_count integer;
  v_report text := '';
BEGIN
  FOREACH v_club IN ARRAY ARRAY[
    '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,
    'a0000000-0000-0000-0000-000000000001'::uuid
  ] LOOP
    SELECT h.host_id,h.host_kind INTO v_host,v_kind FROM public.fn_wheel_host(v_club) h;
    v_owner := public.fn_diamond_game_owner(v_host,v_kind);
    IF v_kind='union' THEN
      SELECT id INTO v_source FROM public.union_wallets WHERE union_id=v_host;
    ELSE v_source:=v_host; END IF;
    v_key := gen_random_uuid()::text;
    PERFORM set_config('request.jwt.claim.sub',v_owner::text,true);
    PERFORM set_config('request.jwt.claims',json_build_object('sub',v_owner,'role','authenticated')::text,true);

    -- The first transfer uses the installed function, including when testing
    -- the candidate pg_temp function: old keys must survive the upgrade.
    v_result := public.fn_diamond_game_fund_promo(v_club,1,v_key);
    IF v_result->>'ok' IS DISTINCT FROM 'true' OR v_result->>'replayed' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'PROBE FAIL: % first transfer: %',v_kind,v_result;
    END IF;
    SELECT * INTO STRICT v_leg FROM public.chip_ledger WHERE idempotency_key='diamond-games-fund:'||v_key;
    IF v_leg.amount <> 1 OR v_leg.from_entity_id <> v_source OR v_leg.to_entity_id <> v_host THEN
      RAISE EXCEPTION 'PROBE FAIL: % first journal leg does not match',v_kind;
    END IF;

    v_result := public.fn_diamond_game_fund_promo(v_club,1,v_key); -- candidate
    IF v_result->>'ok' IS DISTINCT FROM 'true' OR v_result->>'replayed' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'PROBE FAIL: % exact replay: %',v_kind,v_result;
    END IF;
    v_result := public.fn_diamond_game_fund_promo(v_club,2,v_key); -- candidate
    IF v_result->>'ok' IS DISTINCT FROM 'false' OR v_result->>'error' IS DISTINCT FROM 'That Request Key Was Already Used For Different Funding' THEN
      RAISE EXCEPTION 'PROBE FAIL: % changed amount claimed success: %',v_kind,v_result;
    END IF;
    v_result := public.fn_diamond_game_fund_promo(
      CASE WHEN v_kind='club' THEN 'a0000000-0000-0000-0000-000000000001'::uuid
        ELSE '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid END,1,v_key); -- candidate
    IF v_result->>'ok' IS DISTINCT FROM 'false' OR v_result->>'error' IS DISTINCT FROM 'That Request Key Was Already Used For Different Funding' THEN
      RAISE EXCEPTION 'PROBE FAIL: % different host claimed success: %',v_kind,v_result;
    END IF;
    PERFORM set_config('request.jwt.claim.sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d',true);
    PERFORM set_config('request.jwt.claims',json_build_object('sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d','role','authenticated')::text,true);
    v_result := public.fn_diamond_game_fund_promo(v_club,1,v_key); -- candidate
    IF v_result->>'ok' IS DISTINCT FROM 'false' OR v_result->>'error' IS DISTINCT FROM 'That Request Key Was Already Used For Different Funding' THEN
      RAISE EXCEPTION 'PROBE FAIL: % different operator claimed success: %',v_kind,v_result;
    END IF;
    PERFORM set_config('request.jwt.claim.sub',v_owner::text,true);
    PERFORM set_config('request.jwt.claims',json_build_object('sub',v_owner,'role','authenticated')::text,true);
    SELECT count(*) INTO v_count FROM public.chip_ledger WHERE idempotency_key='diamond-games-fund:'||v_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'PROBE FAIL: % repeated movement: % legs',v_kind,v_count; END IF;
    v_report:=v_report||format(' %s: one journal leg, exact replay accepted, amount, host and operator changes refused;',v_kind);
  END LOOP;
  RAISE EXCEPTION 'PROBE PASS (rolled back):%',v_report;
END $$;
