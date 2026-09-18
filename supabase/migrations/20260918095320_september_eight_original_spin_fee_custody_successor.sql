-- Five explicitly authorized September 8 Spins. Existing payer and custody owner only.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

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

DO $patch$ DECLARE source text; BEGIN
SELECT pg_get_functiondef('public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure) INTO source;
IF md5(source) IS DISTINCT FROM 'dab16be4ff3b7378cdc914612b87a727' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: fn_ca_legacy_fee_custody_cohort(uuid)' USING ERRCODE='55000'; END IF;
source:=replace(source,$old0$ ) c(tournament_id,amount,source_fingerprint,source_count)$old0$,$new0$,
 ('199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,1.2000::numeric,'ceeb0817a40a48f9e7cfdac3883036b7',1),
 ('808ef798-0942-4ce0-9ae1-eeefaaf4b0a9'::uuid,0.4800::numeric,'13f274f32c3ae9ca27da9991d013e33e',1),
 ('b60c7add-6b38-4549-b091-601f64d118a0'::uuid,0.2400::numeric,'03b471964aaef196d4dddec3f73e64f8',1),
 ('e3f4e2ab-8397-43e8-8643-6cec3fff3a63'::uuid,4.8000::numeric,'cac905b2c20f288a272e04bc65d0b259',1),
 ('f3f050f1-569e-4fb6-859f-86b6092e682e'::uuid,4.8000::numeric,'a64cf2abd9d146390b482bd4aff9cd3e',1)
 ) c(tournament_id,amount,source_fingerprint,source_count)$new0$);
EXECUTE source; END $patch$;
DO $patch$ DECLARE source text; BEGIN
SELECT pg_get_functiondef('public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure) INTO source;
IF md5(source) IS DISTINCT FROM '20edaaed3b681fdd0416ef9c95d81af0' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: fn_ca_hold_legacy_tournament_fee(uuid,text)' USING ERRCODE='55000'; END IF;
source:=replace(source,$old0$OR lower(COALESCE(t.variant,'')) IN ('satellite','spin')$old0$,$new0$OR lower(COALESCE(t.variant,''))='satellite'
  OR (lower(COALESCE(t.variant,''))='spin' AND public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL)$new0$);
source:=replace(source,$old1$jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type),to_jsonb(e)$old1$,$new1$jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type)||CASE WHEN public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('spin_original',public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id)) END,to_jsonb(e)$new1$);
EXECUTE source; END $patch$;
DO $patch$ DECLARE source text; BEGIN
SELECT pg_get_functiondef('public.fn_ca_tournament_fee_custody_receipt(uuid)'::regprocedure) INTO source;
IF md5(source) IS DISTINCT FROM '847e969c3057877c9e36310483343aa5' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_tournament_fee_custody_receipt(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_tournament_fee_custody_receipt(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: fn_ca_tournament_fee_custody_receipt(uuid)' USING ERRCODE='55000'; END IF;
source:=replace(source,$old0$jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type)
  INTO scope$old0$,$new0$jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type)||CASE WHEN public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('spin_original',public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id)) END
  INTO scope$new0$);
EXECUTE source; END $patch$;
DO $patch$ DECLARE source text; BEGIN
SELECT pg_get_functiondef('public.fn_ca_begin_legacy_fee_resolution(uuid)'::regprocedure) INTO source;
IF md5(source) IS DISTINCT FROM '8db178c9594f48dfc98db1562127314d' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_begin_legacy_fee_resolution(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_begin_legacy_fee_resolution(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: fn_ca_begin_legacy_fee_resolution(uuid)' USING ERRCODE='55000'; END IF;
source:=replace(source,$old0$OR jsonb_array_length(plan->'active_source_ids')<1$old0$,$new0$OR jsonb_array_length(plan->'active_source_ids')<1
  OR (public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NOT NULL AND jsonb_array_length(plan->'active_source_ids')<>3)$new0$);
EXECUTE source; END $patch$;
DO $patch$ DECLARE source text; BEGIN
SELECT pg_get_functiondef('public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)'::regprocedure) INTO source;
IF md5(source) IS DISTINCT FROM '649892f022e3aa59e31dcb19f21fce8c' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)' USING ERRCODE='55000'; END IF;
source:=replace(source,$old0$ IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;$old0$,$new0$ -- The installed Union wallet autoledger identifies its source by the typed
 -- original prize liability and deliberately leaves tournament_id NULL.
 IF t IS NULL AND p_table='chip_ledger' AND p_operation='INSERT'
  AND p_new->>'from_type'='prize_liability'
  AND public.fn_ca_sep8_spin_original_fee_proof(NULLIF(p_new->>'from_entity_id','')::uuid) IS NOT NULL THEN
  t:=NULLIF(p_new->>'from_entity_id','')::uuid;
 END IF;
 IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;$new0$);
source:=replace(source,$old1$ ELSIF p_table='chip_ledger' THEN
  RETURN$old1$,$new1$ ELSIF p_table='chip_ledger' THEN
  IF p_operation='INSERT' AND r.original_plan->>'union_id' IS NOT NULL
   AND public.fn_ca_sep8_spin_original_fee_proof(t) IS NOT NULL THEN
   RETURN p_new->>'from_type'='prize_liability' AND p_new->>'from_entity_id'=t::text
    AND (p_new->>'tournament_id' IS NULL OR p_new->>'tournament_id'=t::text)
    AND p_new->>'to_type'='union_wallet' AND p_new->>'to_label'='union_wallets.rake_wallet'
    AND p_new->>'union_id'=r.original_plan->>'union_id' AND p_new->>'category'='rake'
    AND (p_new->>'amount')::numeric=r.amount
    AND p_new->>'description'='auto-ledgered union_wallets.rake_wallet delta '||round(r.amount,2)::text
    AND p_new->>'from_label' IS NULL AND p_new->>'club_id' IS NULL
    AND p_new->>'table_id' IS NULL AND p_new->>'hand_id' IS NULL
    AND p_new->>'idempotency_key' IS NULL AND p_new->>'metadata' IS NULL
    AND p_new->>'pre_from_balance' IS NULL AND p_new->>'post_from_balance' IS NULL
    AND p_new->>'status'='posted' AND (p_new->>'created_at')::timestamptz=r.resolved_at
    AND (p_new->>'performed_by')::uuid=COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
    AND (p_new->>'pre_to_balance')::numeric>=0
    AND (p_new->>'post_to_balance')::numeric-(p_new->>'pre_to_balance')::numeric=r.amount
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=(p_new->>'to_entity_id')::uuid
     AND w.union_id=(r.original_plan->>'union_id')::uuid
     AND w.rake_wallet=(p_new->>'post_to_balance')::numeric)
    AND EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=t
     AND s.destination='pending' AND s.amount=0 AND s.settled_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.from_type='prize_liability'
     AND l.from_entity_id=t AND l.to_type='union_wallet'
     AND (l.union_id=(r.original_plan->>'union_id')::uuid OR l.to_entity_id=(p_new->>'to_entity_id')::uuid));
  END IF;
  RETURN$new1$);
EXECUTE source; END $patch$;
DO $patch$ DECLARE source text; BEGIN
SELECT pg_get_functiondef('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure) INTO source;
IF md5(source) IS DISTINCT FROM '6dc3fc304eb4b106c1d150ac71d3d9ba' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: fn_ca_tournament_terminal_receipt(uuid,uuid)' USING ERRCODE='55000'; END IF;
source:=replace(source,$old0$v_original_witness jsonb;$old0$,$new0$v_original_witness jsonb;v_spin_witness jsonb;v_spin_original jsonb;$new0$);
source:=replace(source,$old1$  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric$old1$,$new1$  v_spin_original:=public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id);
  IF to_regprocedure('smarter_private.spin_original_standings_witness(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT smarter_private.spin_original_standings_witness($1,$2)' INTO v_spin_witness USING p_tournament_id,v_h.winner_id;
  END IF;
  IF (v_spin_original IS NOT NULL AND jsonb_typeof(v_spin_witness) IS DISTINCT FROM 'object')
    OR NULLIF(v_h.cash_receipt->'original_standings','null'::jsonb) IS DISTINCT FROM NULLIF(v_spin_witness,'null'::jsonb) THEN
    RAISE EXCEPTION 'terminal cash original Spin standings disagree with immutable authority' USING ERRCODE='P0404';
  END IF;
  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric$new1$);
EXECUTE source; END $patch$;
COMMIT;
