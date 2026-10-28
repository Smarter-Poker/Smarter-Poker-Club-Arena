-- Owner October28: 6/9-handed SNG satellites, two seats, third entry refund plus residue,10% rake.
-- New events only. No historical contract, wallet or settlement rewrite.
-- @live-proof: (to_regprocedure('public.fn_ensure_fixed_sng_satellite(uuid,integer)') IS NOT NULL)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE FUNCTION public.fn_ca_is_fixed_sng_satellite(p_row jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
 SELECT COALESCE(jsonb_typeof(p_row)='object'
   AND upper(p_row->>'tournament_type')='SNG' AND lower(p_row->>'variant')='sng'
   AND p_row->>'max_players' IN ('6','9')
   AND p_row->>'min_players'=p_row->>'max_players'
   AND p_row->>'table_size'=p_row->>'max_players'
   AND p_row->>'satellite_seats'='2'
   AND COALESCE(NULLIF(p_row->>'satellite_target_id',''),NULLIF(p_row->>'satellite_target','')) IS NOT NULL
   AND (NULLIF(p_row->>'satellite_target_id','') IS NULL OR NULLIF(p_row->>'satellite_target','') IS NULL
     OR p_row->>'satellite_target_id'=p_row->>'satellite_target'),false);
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_is_fixed_sng_satellite(jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE definition text; needle text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_is_new_mtt(jsonb)'::regprocedure)
    IS DISTINCT FROM 'ad9224540faf12ccd3eb103113d4cc30' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_legacy_tournament_format(jsonb)'::regprocedure)
    IS DISTINCT FROM 'c813aaa60bc6d1fa337edf7425bfab91' THEN
   RAISE EXCEPTION 'FIXED_SNG_SATELLITE_FORMAT_PREIMAGE_DRIFT';
 END IF;
 needle:='    WHEN jsonb_typeof(p_row) IS DISTINCT FROM ''object'' THEN false';
 definition:=pg_get_functiondef('public.fn_ca_is_new_mtt(jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle) <> 1 THEN
   RAISE EXCEPTION 'FIXED_SNG_MTT_ANCHOR_DRIFT'; END IF;
 EXECUTE replace(definition,needle,needle||E'\n    WHEN public.fn_ca_is_fixed_sng_satellite(p_row) THEN false');
 needle:='    WHEN upper(p_row->>''tournament_type'')=''SPIN''';
 definition:=pg_get_functiondef('public.fn_ca_legacy_tournament_format(jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle) <> 1 THEN
   RAISE EXCEPTION 'FIXED_SNG_FORMAT_ANCHOR_DRIFT'; END IF;
 EXECUTE replace(definition,needle,E'    WHEN public.fn_ca_is_fixed_sng_satellite(p_row) THEN ''sng-v1''\n'||needle);
END $patch$;
-- FIXED_SNG_COHORT_SCOPE_BEGIN
-- Extend only the proven cohort format, preserving its existing atomic money writer.
DO $cohort$
DECLARE r record; definition text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_ca_assert_satellite_cohort_standings(uuid)','5c883464a5d0c61e32259a8764f08db0',$old$(SELECT to_jsonb(t)->>'format_contract' FROM public.tournaments t WHERE id=p_tournament_id)
       IS DISTINCT FROM 'mtt-v2'$old$,$new$(SELECT t.format_contract='mtt-v2' OR (t.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(t)))
         FROM public.tournaments t WHERE id=p_tournament_id) IS NOT TRUE$new$),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])','349d7ce95e8474fc47057852d24944ca',$old$(SELECT to_jsonb(t)->>'format_contract' FROM public.tournaments t WHERE id=p_tournament_id)
       IS DISTINCT FROM 'mtt-v2'$old$,$new$(SELECT t.format_contract='mtt-v2' OR (t.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(t)))
         FROM public.tournaments t WHERE id=p_tournament_id) IS NOT TRUE$new$),
  ('public.fn_get_satellite_qualifier_state(uuid)','08db3d2a8d33c2d9eebaf0fa20be4b65',$old$to_jsonb(t)->>'format_contract' IS DISTINCT FROM 'mtt-v2'$old$,$new$(t.format_contract='mtt-v2' OR (t.format_contract='sng-v1' AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(t)))) IS NOT TRUE$new$),
  ('public.fn_resolve_satellite_qualifier_outcome(uuid,uuid[])','e9584dc02fed91f2c252e8996bcce3b6',$old$t.format_contract IS DISTINCT FROM 'mtt-v2'$old$,$new$(t.format_contract='mtt-v2' OR (t.format_contract='sng-v1' AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(t)))) IS NOT TRUE$new$),
  ('public.fn_ca_guard_new_satellite_target()','fc5bf68c5523d97b6c36553d612867ae',$old$WHERE s.format_contract='mtt-v2'$old$,$new$WHERE (s.format_contract='mtt-v2' OR (s.format_contract='sng-v1' AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(s))))$new$)
 ) p(signature,digest,needle,replacement) LOOP
   IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(r.signature)) IS DISTINCT FROM r.digest THEN
     RAISE EXCEPTION 'FIXED_SNG_COHORT_PREIMAGE_DRIFT: %',r.signature; END IF;
   definition:=pg_get_functiondef(to_regprocedure(r.signature));
   IF (length(definition)-length(replace(definition,r.needle,'')))/length(r.needle) <> 1 THEN
     RAISE EXCEPTION 'FIXED_SNG_COHORT_ANCHOR_DRIFT: %',r.signature; END IF;
   EXECUTE replace(definition,r.needle,r.replacement);
 END LOOP;
END $cohort$;
-- FIXED_SNG_COHORT_SCOPE_END
CREATE FUNCTION public.fn_ensure_fixed_sng_satellite(p_target_id uuid,p_seats integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE target public.tournaments%ROWTYPE; existing public.tournaments%ROWTYPE;
 ticket numeric; entry numeric; fee numeric; remainder_cents bigint; ladder jsonb;
 event_id uuid; abi text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'SNG_SATELLITE_REQUIRES_READ_COMMITTED' USING ERRCODE='0A000'; END IF;
 IF p_seats IS NULL OR p_seats NOT IN (6,9) OR p_target_id IS NULL THEN
   RAISE EXCEPTION 'SNG_SATELLITE_INVALID_FIELD' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 abi:=public.fn_ca_lock_mtt_admission_contract();
 IF abi<>'unlimited-mtt-v2' THEN RETURN jsonb_build_object('ok',false,'reason','admission_not_activated'); END IF;
 IF public.fn_entry_purchases_frozen() THEN RETURN jsonb_build_object('ok',false,'reason','platform_frozen'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ca:fixed-sng-satellite:'||p_target_id::text||':'||p_seats::text,0));
 SELECT * INTO target FROM public.tournaments WHERE id=p_target_id FOR NO KEY UPDATE;
 IF NOT FOUND OR target.club_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
   OR target.union_id IS DISTINCT FROM target.club_id
   OR public.fn_ca_satellite_target_accepts_new_feeder(target.id) IS NOT TRUE
   OR upper(COALESCE(target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
   OR target.satellite_target_id IS NOT NULL OR target.satellite_target IS NOT NULL
   OR target.start_time IS NULL OR NOT isfinite(target.start_time)
   OR target.start_time < clock_timestamp()+interval '3 hours'
   OR target.start_time >= clock_timestamp()+interval '7 days'
   OR (p_seats=9 AND upper(target.game_type) IN ('PLO5','PLO6')) THEN
   RETURN jsonb_build_object('ok',false,'reason','target_unavailable'); END IF;
 ticket:=target.buy_in_amount+target.buy_in_fee;
 IF ticket IS NULL OR ticket::text IN ('NaN','Infinity','-Infinity')
   OR ticket<>round(ticket,2) OR (ticket<=25 AND NOT (
     ticket=25 AND target.schedule_id='a70c1028-1800-2500-9000-000000000001'::uuid)) THEN
   RETURN jsonb_build_object('ok',false,'reason','target_price_ineligible'); END IF;
 -- Whole entry, fee is exactly10% of that entry. All arithmetic is NUMERIC/cents.
 entry:=ceil(20*ticket/(9*p_seats-10)); fee:=entry/10;
 remainder_cents:=round((p_seats*(entry-fee)-2*ticket)*100)::bigint;
 IF remainder_cents<entry*100 OR remainder_cents>=ticket*100 THEN
   RAISE EXCEPTION 'SNG_SATELLITE_PRICE_DOES_NOT_FUND_TWO_SEATS_AND_REFUND'; END IF;
 SELECT * INTO existing FROM public.tournaments
   WHERE satellite_target_id=target.id AND tournament_type='SNG' AND variant='sng'
     AND max_players=p_seats AND satellite_seats=2 AND format_contract='sng-v1'
     AND upper(status) IN ('ANNOUNCED','REGISTERING') ORDER BY id LIMIT 1 FOR UPDATE;
 IF FOUND THEN
   IF existing.buy_in_amount+existing.buy_in_fee IS DISTINCT FROM entry OR existing.buy_in_fee IS DISTINCT FROM fee
     OR existing.min_players IS DISTINCT FROM p_seats OR existing.table_size IS DISTINCT FROM p_seats THEN
     RAISE EXCEPTION 'SNG_SATELLITE_EXISTING_CONTRACT_MISMATCH'; END IF;
   RETURN jsonb_build_object('ok',true,'created',false,'tournament_id',existing.id,'target_id',target.id); END IF;
 SELECT jsonb_agg(value||jsonb_build_object('durationMinutes',5) ORDER BY ordinality)
   INTO ladder FROM jsonb_array_elements(target.blind_structure::jsonb) WITH ORDINALITY;
 PERFORM public.fn_ca_mtt_blind_contract(ladder::text,10000);
 INSERT INTO public.tournaments(club_id,union_id,name,game_type,variant,tournament_type,
   buy_in_amount,buy_in_fee,guaranteed_prize,starting_chips,max_players,min_players,table_size,
   current_players,status,blind_structure,blind_speed,is_turbo,payout_structure,start_time,
   late_reg_levels,late_reg_mins,satellite_target_id,satellite_seats,synchronized_breaks,
   is_rebuy,is_reentry,add_on_available,max_rebuys,max_reentries,short_description)
 VALUES(target.club_id,target.union_id,target.name||' '||p_seats||'-Max SNG Satellite',target.game_type,'sng','SNG',
   entry-fee,fee,0,10000,p_seats,p_seats,p_seats,0,'REGISTERING',ladder::text,'turbo',true,
   '[{"place":1,"percentage":50},{"place":2,"percentage":50}]',clock_timestamp()+interval '2 minutes',
   0,0,target.id,2,false,false,false,false,0,0,
   'Top Two Win Seats. Third Receives Full Entry Back Plus Rounding Remainder. 10% Rake.')
 RETURNING id INTO event_id;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=event_id AND format_contract='sng-v1'
   AND max_players=p_seats AND min_players=p_seats AND satellite_seats=2 AND buy_in_fee=fee) THEN
   RAISE EXCEPTION 'SNG_SATELLITE_PERSISTED_CONTRACT_MISMATCH'; END IF;
 RETURN jsonb_build_object('ok',true,'created',true,'tournament_id',event_id,'target_id',target.id,
   'entry',entry,'fee',fee,'third_place',remainder_cents/100.0);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ensure_fixed_sng_satellite(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ensure_fixed_sng_satellite(uuid,integer) TO service_role;
COMMIT;
