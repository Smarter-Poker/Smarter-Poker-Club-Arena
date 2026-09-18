-- Read only proof of the original paid Spin entries. Missing earning agreements
-- remain missing; custody does not derive commissions from current settings.
CREATE FUNCTION public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE c record;r public.rake_records%ROWTYPE;t public.tournaments%ROWTYPE;
 v public.managed_game_contract_versions%ROWTYPE;tp record;e record;l record;s record;
 item record;n integer;gross numeric:=0;earliest timestamptz;rows jsonb:='[]';versions jsonb:='[]';
 reserve jsonb;game_union uuid;reserve_account uuid;
BEGIN
 IF p_tournament_id NOT IN (
 '199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,'808ef798-0942-4ce0-9ae1-eeefaaf4b0a9',
 'b60c7add-6b38-4549-b091-601f64d118a0','e3f4e2ab-8397-43e8-8643-6cec3fff3a63',
 'f3f050f1-569e-4fb6-859f-86b6092e682e') THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id);
 SELECT count(*) INTO n FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 SELECT * INTO r FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id;
 IF n<>1 OR c.source_count IS DISTINCT FROM 1 OR r.source IS DISTINCT FROM 'fn_spin_book_entry'
  OR r.rake_amount IS DISTINCT FROM c.amount OR md5(public.fn_accounting_tournament_fee_fingerprint(r)) IS DISTINCT FROM c.source_fingerprint
  OR r.created_at>='2026-09-17T18:24:02.831517Z'::timestamptz OR r.hand_id IS NOT NULL
  OR r.metadata->>'kind' IS DISTINCT FROM 'spin_rake' OR jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
  OR t.is_private IS DISTINCT FROM false OR t.variant IS DISTINCT FROM 'spin' OR t.tournament_type IS DISTINCT FROM 'SPIN'
  OR public.fn_poker_diamond_tournament(p_tournament_id)
 THEN RAISE EXCEPTION 'named Spin original aggregate identity missing' USING ERRCODE='P0404'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>3
  OR (SELECT count(DISTINCT value::numeric) FROM jsonb_each_text(r.player_contributions))<>1
 THEN RAISE EXCEPTION 'named Spin requires exactly three equal original paid contributors' USING ERRCODE='P0404'; END IF;
 FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
  SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=item.player_id;
  SELECT count(*) INTO n FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id
   AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge' AND x.charge_category='tournament_buyin'
   AND x.created_at=tp.registered_at AND x.gross=item.weight;
  IF n<>1 THEN RAISE EXCEPTION 'named Spin original paid entry ambiguous' USING ERRCODE='P0404'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id
   AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge' AND x.charge_category='tournament_buyin'
   AND x.created_at=tp.registered_at AND x.gross=item.weight;
  SELECT * INTO l FROM public.chip_ledger WHERE id=e.source_ledger_id;
  IF l.id IS NULL OR tp.club_id IS DISTINCT FROM e.refund_wallet_club_id OR l.created_at IS DISTINCT FROM e.created_at
   OR e.created_at>r.created_at OR l.amount IS DISTINCT FROM e.gross OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
   OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM item.player_id
   OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM p_tournament_id
   OR l.category IS DISTINCT FROM 'tournament_buyin' OR item.weight<=0
  THEN RAISE EXCEPTION 'named Spin original debit evidence disagrees' USING ERRCODE='P0404'; END IF;
  earliest:=least(earliest,e.created_at);gross:=gross+item.weight;
  rows:=rows||jsonb_build_array(jsonb_build_object('registration_id',tp.id,'player_id',item.player_id,
   'club_id',tp.club_id,'registered_at',tp.registered_at,'entitlement',to_jsonb(e)-'terminal_closed_at','ledger',to_jsonb(l)));
 END LOOP;
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='contribution';
 SELECT * INTO s FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='contribution';
 IF n<>1 OR s.seats IS DISTINCT FROM 3 OR s.house_rake IS DISTINCT FROM r.rake_amount
  OR s.amount IS DISTINCT FROM gross-r.rake_amount OR s.buy_in IS DISTINCT FROM gross/3
 THEN RAISE EXCEPTION 'named Spin original reserve contribution disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=jsonb_build_object('contribution',to_jsonb(s)-'terminal_closed_at');
 SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_entry';
 SELECT * INTO l FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_entry';
 IF n<>1 OR l.amount IS DISTINCT FROM s.amount OR l.created_at IS DISTINCT FROM s.created_at
  OR l.club_id IS DISTINCT FROM s.club_id OR l.from_type IS DISTINCT FROM 'prize_liability'
  OR l.from_entity_id IS DISTINCT FROM p_tournament_id OR l.to_type IS DISTINCT FROM 'spin_reserve' OR l.to_entity_id IS NULL
 THEN RAISE EXCEPTION 'named Spin reserve contribution debit disagrees' USING ERRCODE='P0404'; END IF;
 reserve_account:=l.to_entity_id;reserve:=reserve||jsonb_build_object('contribution_ledger',to_jsonb(l));
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='jackpot_draw';
 SELECT * INTO s FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='jackpot_draw';
 IF n<>1 OR s.seats IS DISTINCT FROM 3 OR s.house_rake IS DISTINCT FROM r.rake_amount
  OR s.amount IS DISTINCT FROM -t.prize_pool OR s.buy_in IS DISTINCT FROM gross/3 OR s.amount>=0
 THEN RAISE EXCEPTION 'named Spin original prize draw disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=reserve||jsonb_build_object('draw',to_jsonb(s)-'terminal_closed_at');
 SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_prize';
 SELECT * INTO l FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_prize';
 IF n<>1 OR l.amount IS DISTINCT FROM -s.amount OR l.created_at IS DISTINCT FROM s.created_at
  OR l.club_id IS DISTINCT FROM s.club_id OR l.from_type IS DISTINCT FROM 'spin_reserve'
  OR l.from_entity_id IS DISTINCT FROM reserve_account OR l.to_type IS DISTINCT FROM 'prize_liability'
  OR l.to_entity_id IS DISTINCT FROM p_tournament_id
 THEN RAISE EXCEPTION 'named Spin original prize draw credit disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=reserve||jsonb_build_object('draw_ledger',to_jsonb(l));
 SELECT * INTO v FROM public.managed_game_contract_versions WHERE game_id=p_tournament_id AND game_kind='tournament' AND version=1;
 IF NOT FOUND OR v.published_at>earliest OR v.club_id IS DISTINCT FROM r.club_id
  OR v.club_id IS DISTINCT FROM t.club_id OR v.union_id IS DISTINCT FROM t.union_id
 THEN RAISE EXCEPTION 'named Spin original created scope missing' USING ERRCODE='P0404'; END IF;
 game_union:=v.union_id;
 FOR v IN SELECT * FROM public.managed_game_contract_versions WHERE game_id=p_tournament_id AND game_kind='tournament'
  AND published_at<=r.created_at ORDER BY version,id LOOP
  IF v.club_id IS DISTINCT FROM t.club_id OR v.union_id IS DISTINCT FROM game_union
   OR v.contract->>'id' IS DISTINCT FROM p_tournament_id::text OR v.contract->>'club_id' IS DISTINCT FROM v.club_id::text
   OR NULLIF(v.contract->>'union_id','')::uuid IS DISTINCT FROM game_union OR v.contract->'is_private' IS DISTINCT FROM 'false'::jsonb
   OR v.contract->>'variant' IS DISTINCT FROM 'spin' OR v.contract->>'tournament_type' IS DISTINCT FROM 'SPIN'
   OR (v.contract->>'buy_in_amount')::numeric IS DISTINCT FROM gross/3 OR (v.contract->>'max_players')::integer IS DISTINCT FROM 3
   OR v.contract_hash IS DISTINCT FROM public.fn_managed_game_contract_hash(v.contract)
  THEN RAISE EXCEPTION 'named Spin immutable economic scope disagrees' USING ERRCODE='P0404'; END IF;
  versions:=versions||jsonb_build_array(to_jsonb(v));
 END LOOP;
 RETURN jsonb_build_object('tournament_id',p_tournament_id,'raw_source_count',1,'recognized_contributors',3,
  'source_fingerprint',c.source_fingerprint,'fee',c.amount,'gross',gross,'contributors',rows,'reserve',reserve,'scope_versions',versions);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_sep8_spin_original_fee_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
