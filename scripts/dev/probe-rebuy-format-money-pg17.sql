-- Rebuy, re-entry and add-on on every bounty format and on satellites.
--
-- Production has only ever sold these on `freezeout` (873 rebuy, 861 re-entry,
-- 865 add-on rows; 0 on bounty, progressive_bounty, mystery_bounty or
-- satellite). The money core is shared, so this runs the byte-exact captured
-- body against each format and each purchase and proves, per combination:
--   * the wallet is debited exactly the advertised price, once;
--   * price = prize contribution + bounty head + fee, to the cent;
--   * a bounty format funds exactly one entry head on a rebuy or re-entry
--     and none on an add-on; a satellite and a freezeout fund no head;
--   * a re-entry REPLACES the head and the stack, a rebuy ADDS to them, an
--     add-on adds chips and leaves the head alone;
--   * the fee is booked once (total_rake, rake_records) and the funding
--     ledger names the purchase;
--   * the same purchase again moves nothing (answered idempotently, or
--     refused: process_tournament_rebuy owns replay from its own receipt).
\set ON_ERROR_STOP on

CREATE FUNCTION probe.event(p_variant text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_bounty boolean := p_variant IN ('bounty','progressive_bounty','mystery_bounty');
BEGIN
  INSERT INTO public.tournaments(
    id,name,club_id,status,variant,tournament_type,buy_in_amount,buy_in_fee,
    starting_chips,is_rebuy,is_reentry,add_on_available,addon_period_triggered,
    rebuy_cost,rebuy_chips,rebuy_levels,late_reg_levels,addon_cost,addon_chips,
    addon_levels,current_level,prize_pool,bounty_pool,total_rake,
    is_bounty,is_pko,is_mystery_bounty,bounty_amount)
  VALUES(
    v_id,'probe '||p_variant,'00000000-0000-4000-8000-00000000c1b0','RUNNING',
    p_variant,CASE WHEN p_variant='satellite' THEN 'SATELLITE' ELSE 'MTT' END,
    90,10,10000,true,true,true,true,
    100,10000,6,8,100,15000,1,2,900,CASE WHEN v_bounty THEN 400 ELSE 0 END,100,
    v_bounty,p_variant='progressive_bounty',p_variant='mystery_bounty',
    CASE WHEN v_bounty THEN 40 ELSE NULL END);
  INSERT INTO public.tables(id,tournament_id) VALUES (v_id,v_id);
  RETURN v_id;
END $$;

-- One entrant. A rebuy or re-entry buyer has busted (zero stack, head already
-- collected by the knockout that took it); an add-on buyer is alive.
CREATE FUNCTION probe.entrant(p_event uuid, p_kind text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_club uuid := '00000000-0000-4000-8000-00000000c1b0';
  v_alive boolean := p_kind='addon';
BEGIN
  INSERT INTO public.club_members(user_id,club_id,chip_balance) VALUES (v_user,v_club,1000);
  INSERT INTO public.tournament_players(
    tournament_id,user_id,club_id,table_id,chips,status,rebuys,current_bounty,
    eliminated_at,position)
  VALUES(
    p_event,v_user,v_club,p_event,CASE WHEN v_alive THEN 5000 ELSE 0 END,
    CASE WHEN p_kind='reentry' THEN 'eliminated' ELSE 'playing' END,0,
    CASE WHEN v_alive THEN (SELECT COALESCE(bounty_amount,0) FROM public.tournaments WHERE id=p_event) ELSE 0 END,
    CASE WHEN p_kind='reentry' THEN now() END,
    CASE WHEN p_kind='reentry' THEN 7 END);
  INSERT INTO public.table_seats(table_id,user_id,seat_number,stack)
  VALUES(p_event,v_user,3,CASE WHEN v_alive THEN 5000 ELSE 0 END);
  RETURN v_user;
END $$;

CREATE FUNCTION probe.check(p_variant text, p_kind text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_event uuid := probe.event(p_variant);
  v_user uuid := probe.entrant(v_event, p_kind);
  v_bounty boolean := p_variant IN ('bounty','progressive_bounty','mystery_bounty');
  v_head numeric := CASE WHEN v_bounty AND p_kind<>'addon' THEN 40 ELSE 0 END;
  v_fee numeric := CASE WHEN p_kind='addon' THEN 0 ELSE 10 END;
  v_before_t public.tournaments%ROWTYPE;
  v_after_t public.tournaments%ROWTYPE;
  v_before_p public.tournament_players%ROWTYPE;
  v_after_p public.tournament_players%ROWTYPE;
  v_r jsonb;
  v_replay jsonb;
  v_wallet numeric;
  v_stack numeric;
  v_expected_chips integer;
  v_expected_head numeric;
  v_fail text := '';
BEGIN
  SELECT * INTO v_before_t FROM public.tournaments WHERE id=v_event;
  SELECT * INTO v_before_p FROM public.tournament_players WHERE tournament_id=v_event AND user_id=v_user;
  v_r := public.fn_ca_process_tournament_chip_purchase_money_v1(
    v_event, v_user, p_kind, 100, NULL, 2, 'probe-token');
  -- The same purchase again. process_tournament_rebuy answers a replay from
  -- its own receipt before it reaches this core; here the core must either
  -- answer idempotently or refuse, and in neither case move money.
  BEGIN
    v_replay := public.fn_ca_process_tournament_chip_purchase_money_v1(
      v_event, v_user, p_kind, 100, NULL, 2, 'probe-token');
  EXCEPTION WHEN OTHERS THEN
    v_replay := jsonb_build_object('refused', SQLERRM);
  END;
  SELECT * INTO v_after_t FROM public.tournaments WHERE id=v_event;
  SELECT * INTO v_after_p FROM public.tournament_players WHERE tournament_id=v_event AND user_id=v_user;
  SELECT chip_balance INTO v_wallet FROM public.club_members WHERE user_id=v_user;
  SELECT stack INTO v_stack FROM public.table_seats WHERE user_id=v_user AND left_at IS NULL;

  v_expected_chips := CASE p_kind
    WHEN 'addon' THEN 5000+15000
    WHEN 'rebuy' THEN 0+10000
    ELSE 10000 END;
  v_expected_head := CASE
    WHEN NOT v_bounty THEN 0
    WHEN p_kind='addon' THEN 40            -- untouched live head
    WHEN p_kind='reentry' THEN 40          -- replaced by the new entry's head
    ELSE 0+40 END;                         -- rebuy adds to a collected (zero) head

  IF (v_r->>'success')::boolean IS NOT TRUE THEN v_fail := v_fail||' not_success'; END IF;
  IF (v_replay->>'idempotent')::boolean IS NOT TRUE AND NOT (v_replay ? 'refused') THEN
    v_fail := v_fail||' replay_charged_again';
  END IF;
  IF v_wallet <> 1000-100 THEN v_fail := v_fail||' wallet='||v_wallet; END IF;
  IF (v_r->>'cost')::numeric <> 100 THEN v_fail := v_fail||' cost='||(v_r->>'cost'); END IF;
  IF (v_r->>'fee')::numeric <> v_fee THEN v_fail := v_fail||' fee='||(v_r->>'fee'); END IF;
  IF (v_r->>'bounty_head_funded')::numeric <> v_head THEN
    v_fail := v_fail||' head='||(v_r->>'bounty_head_funded');
  END IF;
  IF v_after_t.bounty_pool - v_before_t.bounty_pool <> v_head THEN
    v_fail := v_fail||' bounty_pool_delta='||(v_after_t.bounty_pool - v_before_t.bounty_pool);
  END IF;
  IF (v_after_t.prize_pool - v_before_t.prize_pool)
     + (v_after_t.bounty_pool - v_before_t.bounty_pool)
     + (v_after_t.total_rake - v_before_t.total_rake) <> 100 THEN
    v_fail := v_fail||' does_not_conserve';
  END IF;
  IF v_after_t.total_rake - v_before_t.total_rake <> v_fee THEN
    v_fail := v_fail||' rake_delta='||(v_after_t.total_rake - v_before_t.total_rake);
  END IF;
  IF (SELECT count(*) FROM public.rake_records WHERE tournament_id=v_event AND is_tournament)
     <> (CASE WHEN v_fee>0 THEN 1 ELSE 0 END) THEN
    v_fail := v_fail||' rake_records';
  END IF;
  IF v_after_p.chips <> v_expected_chips OR v_stack <> v_expected_chips THEN
    v_fail := v_fail||' chips='||v_after_p.chips||'/seat='||v_stack;
  END IF;
  IF COALESCE(v_after_p.current_bounty,0) <> v_expected_head THEN
    v_fail := v_fail||' current_bounty='||v_after_p.current_bounty;
  END IF;
  IF p_kind='addon' THEN
    IF v_after_p.add_on IS NOT TRUE OR v_after_p.rebuys <> 0 THEN v_fail := v_fail||' addon_flags'; END IF;
  ELSE
    IF v_after_p.rebuys <> 1 OR v_after_p.status <> 'playing'
       OR v_after_p.eliminated_at IS NOT NULL OR v_after_p.position IS NOT NULL THEN
      v_fail := v_fail||' entry_not_revived';
    END IF;
  END IF;
  IF (SELECT count(*) FROM public.wallet_transactions
       WHERE user_id=v_user AND amount=100
         AND category=CASE WHEN p_kind='addon' THEN 'addon' ELSE 'rebuy' END) <> 1 THEN
    v_fail := v_fail||' wallet_receipt';
  END IF;
  IF (SELECT count(*) FROM probe.funding f
       WHERE f.participant_id=v_before_p.id AND f.kind=p_kind AND f.amount=100) <> 1 THEN
    v_fail := v_fail||' funding_ledger';
  END IF;
  RETURN CASE WHEN v_fail='' THEN 'ok' ELSE trim(v_fail) END;
END $$;

DO $$
DECLARE
  v_variant text;
  v_kind text;
  v_result text;
  v_failures text := '';
  v_count integer := 0;
BEGIN
  FOREACH v_variant IN ARRAY ARRAY['freezeout','bounty','progressive_bounty','mystery_bounty','satellite'] LOOP
    FOREACH v_kind IN ARRAY ARRAY['rebuy','reentry','addon'] LOOP
      v_result := probe.check(v_variant, v_kind);
      v_count := v_count + 1;
      RAISE NOTICE '% x %: %', rpad(v_variant,18), rpad(v_kind,7), v_result;
      IF v_result <> 'ok' THEN
        v_failures := v_failures||format(E'\n  %s x %s: %s', v_variant, v_kind, v_result);
      END IF;
    END LOOP;
  END LOOP;
  IF v_failures <> '' THEN
    RAISE EXCEPTION 'rebuy x format money probe failed:%', v_failures;
  END IF;
  RAISE NOTICE 'REBUY_FORMAT_MONEY_PG17_OK (% combinations)', v_count;
END $$;
