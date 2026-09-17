-- Owner September 17: every shown per-drop choice must be accepted by the authoritative bonus transaction.
-- Preserve custody, prize cover, server outcomes, and one-entry idempotency unchanged.
CREATE OR REPLACE FUNCTION public.fn_plinko_bonus_run(p_club uuid, p_commit uuid, p_seed text, p_total integer, p_denom integer, p_table integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE adm record; t public.plinko_tables; cap integer; idx integer; bit_idx integer; path integer; slot integer;
 balls jsonb[]:='{}'; hash bytea; mult integer; prize numeric; paid numeric:=0; debit jsonb; receipt record;
 v_id uuid; v_count integer; result jsonb;
BEGIN
 IF p_denom IS NULL OR p_denom NOT IN (1,2,4,5,10,20,25,50,100) OR p_total%p_denom<>0 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose A Drop Value That Uses Every Diamond'); END IF;
 SELECT e.id INTO v_id FROM public.diamond_bonus_entries e WHERE e.commit_id=p_commit AND e.user_id=auth.uid() AND e.result IS NULL;
 IF v_id IS NULL THEN RAISE EXCEPTION 'A Bonus Entry Is Required'; END IF;
 SELECT * INTO adm FROM public.fn_diamond_game_admit('plinko',p_club,p_commit,p_seed,p_total);
 IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;
 SELECT * INTO t FROM public.plinko_tables WHERE version=p_table AND activated_at IS NOT NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','Choose An Available Plinko Table'); END IF;
 -- Cover the whole selected table for every ball before any outcome is drawn.
 -- One locked transaction pays the completed batch; animation cannot alter it.
 cap:=public.fn_diamond_game_cap_cents(adm.o_cfg,adm.o_pool,adm.o_bank,adm.o_bet_chips,LEAST(t.max_multiplier_cents,(adm.o_cfg).max_multiplier_cents));
 IF cap<t.max_multiplier_cents OR (p_total/p_denom)*ceil(p_denom::numeric/adm.o_rate*t.max_multiplier_cents)/100 > adm.o_bet_chips*cap/100 THEN RETURN jsonb_build_object('ok',false,'error','The Host Cannot Cover This Bonus. Choose A Smaller Entry'); END IF;
 v_count:=p_total/p_denom;
 FOR idx IN 0..v_count-1 LOOP
  hash:=extensions.hmac(p_seed||':'||adm.o_nonce||':drop:'||idx,(adm.o_commit).server_seed,'sha256');
  path:=0; slot:=0;
  FOR bit_idx IN 0..15 LOOP IF get_bit(hash,bit_idx)=1 THEN path:=path|(1<<bit_idx); slot:=slot+1; END IF; END LOOP;
  mult:=t.multipliers_cents[slot+1];
  prize:=public.fn_diamond_round_chip_cents(p_denom::numeric/adm.o_rate*mult/100,(adm.o_commit).server_seed,p_seed||':'||adm.o_nonce||':rounding:'||idx);
  paid:=paid+prize;
  balls:=array_append(balls,jsonb_build_object('index',idx,'path_bits',path,'slot',slot,'multiplier_cents',mult,'payout_chips',prize));
 END LOOP;
 debit:=public.fn_diamond_game_take_bet(auth.uid(),p_total,(adm.o_cfg).purchased_only,'plinko_drop',
  'Diamond Spins Plinko Bonus','plinko-bonus:'||v_id,
  jsonb_build_object('bonus_id',v_id,'club_id',p_club,'host_id',adm.o_host,'commit_id',p_commit),adm.o_owner,'Diamond Spins Plinko Intake');
 IF COALESCE((debit->>'success')::boolean,false) IS NOT TRUE THEN RETURN jsonb_build_object('ok',false,'error','Not Enough Diamonds For This Bonus'); END IF;
 IF paid>0 THEN
  SELECT * INTO receipt FROM public.fn_diamond_game_pay_chips('plinko_prize',adm.o_host,adm.o_kind,p_club,auth.uid(),paid,
   'plinko-bonus-prize:'||v_id,'Diamond Spins Plinko Bonus',jsonb_build_object('bonus_id',v_id,'drops',v_count));
 END IF;
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+p_total,
  chips_paid=chips_paid+paid,updated_at=now() WHERE host_id=adm.o_host AND game='plinko';
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit;
 result:=jsonb_build_object('ok',true,'id',v_id,'game','plinko','club_id',p_club,'bet_diamonds',p_total,
  'diamonds_per_drop',p_denom,'diamonds_per_chip',adm.o_rate,'table_version',t.version,'table_name',t.name,
  'multipliers_cents',to_jsonb(t.multipliers_cents),'drops',to_jsonb(balls),'payout_chips',paid,
  'server_seed_hash',(adm.o_commit).server_seed_hash,'server_seed',(adm.o_commit).server_seed,
  'client_seed',p_seed,'nonce',adm.o_nonce,'commit_id',p_commit);
 RETURN result;
END $function$
;

REVOKE ALL ON FUNCTION public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer) TO service_role;
