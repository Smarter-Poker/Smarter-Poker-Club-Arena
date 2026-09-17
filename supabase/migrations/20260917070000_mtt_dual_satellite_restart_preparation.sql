-- R46 preparation: the real dual-format satellite creator and immediate
-- restart identity. The admission ABI remains legacy; no historical financial
-- terms or managed-contract documents are rewritten by this migration.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $requires$ BEGIN
 IF current_user<>'postgres' OR
    (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton) IS DISTINCT FROM 'legacy-capacity-v1'
    OR to_regprocedure('public.fn_ca_new_tournament_is_unlimited(jsonb)') IS NULL
    OR to_regprocedure('public.fn_create_seat_first_game_atomic(uuid,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'MTT_SATELLITE_RESTART_REQUIRES_CREATION_PREPARATION';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
   ('fn_ensure_scheduled_mtt_satellite','fn_ca_satellite_target_accepts_new_feeder',
    'fn_ca_guard_new_satellite_target','fn_ca_guard_tournament_restart_source'))
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.tournaments'::regclass
      AND attname='restart_source_id' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'MTT_SATELLITE_RESTART_PREPARATION_NAME_COLLISION';
 END IF;
END $requires$;

-- This is admission for a NEW feeder, not the historical ticket-settlement
-- predicate. Accepted old links and their financial replay remain unchanged.
CREATE FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $function$
 SELECT COALESCE((SELECT t.format_contract IN ('mtt-v1','mtt-v2')
   AND t.is_bounty IS FALSE AND t.is_pko IS FALSE AND t.is_mystery_bounty IS FALSE
   AND t.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(t.variant,''))) NOT IN
     ('satellite','spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND lower(btrim(COALESCE(t.tournament_type,''))) NOT IN
     ('satellite','spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
   AND public.fn_poker_diamond_tournament(t.id) IS FALSE
   FROM public.tournaments t WHERE t.id=p_target_id),false);
$function$;
ALTER FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_guard_new_satellite_target()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE v_abi text; v_target uuid:=COALESCE(NEW.satellite_target_id,NEW.satellite_target);
 v_target_row public.tournaments%ROWTYPE; v_supported boolean;
BEGIN
 IF TG_OP='UPDATE' AND
   (NEW.satellite_target_id,NEW.satellite_target,NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,
    NEW.is_premium_spin,NEW.variant,NEW.tournament_type,NEW.club_id,NEW.union_id)
   IS NOT DISTINCT FROM
   (OLD.satellite_target_id,OLD.satellite_target,OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,
    OLD.is_premium_spin,OLD.variant,OLD.tournament_type,OLD.club_id,OLD.union_id) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF v_abi='legacy-capacity-v1' THEN RETURN NEW;END IF;
 IF NEW.satellite_target_id IS NOT NULL AND NEW.satellite_target IS NOT NULL
    AND NEW.satellite_target_id<>NEW.satellite_target THEN
  RAISE EXCEPTION 'SATELLITE_TARGET_POINTER_CONTRADICTION' USING ERRCODE='22023';
 END IF;
 -- Under READ COMMITTED the post-lock query sees a just-committed feeder.
 -- A repeatable snapshot could otherwise permit an incompatible target edit.
 IF current_setting('transaction_isolation')<>'read committed'
    AND (TG_OP='UPDATE' OR v_target IS NOT NULL) THEN
  RAISE EXCEPTION 'SATELLITE_CONTRACT_REQUIRES_READ_COMMITTED' USING ERRCODE='0A000';
 END IF;
 v_supported:=NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE AND NEW.is_mystery_bounty IS FALSE
   AND NEW.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(NEW.variant,''))) NOT IN
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND lower(btrim(COALESCE(NEW.tournament_type,''))) NOT IN
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
 IF TG_OP='UPDATE' AND (NOT v_supported OR v_target IS NOT NULL
      OR lower(COALESCE(NEW.variant,''))='satellite' OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE')
   AND EXISTS(SELECT 1 FROM public.tournaments s WHERE s.format_contract='mtt-v2'
     AND (s.satellite_target_id=NEW.id OR s.satellite_target=NEW.id) AND s.id<>NEW.id
     AND upper(COALESCE(s.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')) THEN
  RAISE EXCEPTION 'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' USING ERRCODE='22023';
 END IF;
 IF v_target IS NULL AND (lower(COALESCE(NEW.variant,''))='satellite'
    OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE') THEN
  RAISE EXCEPTION 'SATELLITE_NEW_TARGET_REQUIRED' USING ERRCODE='22023';
 END IF;
 IF v_target IS NOT NULL THEN
  IF NOT v_supported THEN RAISE EXCEPTION 'SATELLITE_NEW_SOURCE_UNSUPPORTED' USING ERRCODE='22023';END IF;
  SELECT * INTO v_target_row FROM public.tournaments WHERE id=v_target FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target)
     OR (NEW.union_id IS NOT NULL AND v_target_row.union_id IS DISTINCT FROM NEW.union_id)
     OR (NEW.union_id IS NULL AND (v_target_row.club_id IS DISTINCT FROM NEW.club_id OR v_target_row.union_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'SATELLITE_NEW_TARGET_UNSUPPORTED' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_new_satellite_target() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_new_satellite_target() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a2_tournaments_new_satellite_target
BEFORE INSERT OR UPDATE OF satellite_target_id,satellite_target,is_bounty,is_pko,
 is_mystery_bounty,is_premium_spin,variant,tournament_type,club_id,union_id
ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_new_satellite_target();

ALTER TABLE public.tournaments ADD COLUMN restart_source_id uuid
 REFERENCES public.tournaments(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments(restart_source_id)
 WHERE restart_source_id IS NOT NULL;
CREATE FUNCTION public.fn_ca_guard_tournament_restart_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE v_source public.tournaments%ROWTYPE; v_target_row public.tournaments%ROWTYPE;
 v_abi text; v_target uuid; v_column text; v_total numeric; v_fee numeric; v_mtt boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.restart_source_id IS NOT NULL THEN RAISE EXCEPTION 'TOURNAMENT_RESTART_HISTORY_IMMUTABLE' USING ERRCODE='22023';END IF;
  RETURN OLD;
 ELSIF TG_OP='UPDATE' THEN
  IF NEW.restart_source_id IS DISTINCT FROM OLD.restart_source_id THEN
   RAISE EXCEPTION 'TOURNAMENT_RESTART_SOURCE_IMMUTABLE' USING ERRCODE='22023';END IF;
  RETURN NEW;
 END IF;
 IF NEW.restart_source_id IS NULL THEN RETURN NEW;END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'service_role required for tournament restart' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF public.fn_entry_purchases_frozen() THEN RAISE EXCEPTION 'TOURNAMENT_RESTART_PLATFORM_FROZEN' USING ERRCODE='55000';END IF;
 SELECT * INTO v_source FROM public.tournaments WHERE id=NEW.restart_source_id FOR UPDATE;
 IF NOT FOUND OR upper(COALESCE(v_source.status,''))<>'COMPLETED' OR v_source.ended_at IS NULL
    OR v_source.schedule_id IS NOT NULL OR COALESCE(v_source.restart_every_minutes,0)<=0
    OR NEW.club_id IS DISTINCT FROM v_source.club_id OR NEW.union_id IS DISTINCT FROM v_source.union_id
    OR NEW.game_type IS DISTINCT FROM v_source.game_type OR NEW.status IS DISTINCT FROM 'REGISTERING'
    OR NEW.current_players IS DISTINCT FROM 0 OR NEW.schedule_id IS NOT NULL OR NEW.start_time IS NULL
    OR NOT isfinite(NEW.start_time) OR NEW.start_time<=clock_timestamp() THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_INVALID_SOURCE' USING ERRCODE='22023';END IF;
 -- NULL terminal parents have no historical exemption. Seat-first/Spin games
 -- are replaced by their board, never cloned by the timed restart path.
 v_mtt:=v_source.format_contract IN ('mtt-v1','mtt-v2');
 IF v_source.format_contract IS NULL OR v_source.format_contract NOT IN ('mtt-v1','mtt-v2','sng-v1')
    OR NEW.format_contract IS NOT NULL
    OR (v_mtt AND NOT public.fn_ca_is_new_mtt(to_jsonb(NEW)))
    OR (v_source.format_contract='sng-v1' AND (COALESCE(v_source.max_players,0)<=2
      OR public.fn_ca_is_new_mtt(to_jsonb(NEW))
      OR v_source.satellite_target_id IS NOT NULL OR v_source.satellite_target IS NOT NULL)) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_FORMAT_MISMATCH' USING ERRCODE='22023';END IF;
 FOREACH v_column IN ARRAY ARRAY['club_id','union_id','is_xmtt','name','game_type','variant','tournament_type','starting_chips','blind_structure','payout_structure','payout_percent','guaranteed_prize','late_reg_levels','late_reg_mins','rebuy_levels','is_rebuy','is_reentry','rebuy_cost','rebuy_chips','add_on_available','addon_cost','addon_chips','addon_levels','is_bounty','bounty_amount','is_pko','is_mystery_bounty','mystery_bounty_min','mystery_bounty_max','mystery_bounty_profile','mystery_bounty_activation','mystery_bounty_activation_value','mystery_bounty_pool_percent','mystery_bounty_regular_pool_percent','mystery_bounty_top_percent','spin_type','satellite_seats','is_private','short_description','is_vip_only','ban_chat','all_in_or_fold','label_as_new','hide_club_name','action_time_seconds','table_size','accelerated_mtt','addon_break_minutes','big_blind_ante','authorized_to_register','early_bird_enabled','early_bird_chips','bubble_protection','final_table_deal_enabled','restart_every_minutes','synchronized_breaks','max_rebuys','max_reentries','is_multi_day','total_days','is_pinned'] LOOP
  IF to_jsonb(NEW)->v_column IS DISTINCT FROM to_jsonb(v_source)->v_column THEN
   RAISE EXCEPTION 'TOURNAMENT_RESTART_BUSINESS_MISMATCH: %',v_column USING ERRCODE='22023';END IF;
 END LOOP;
 IF ((v_abi='legacy-capacity-v1' OR NOT v_mtt) AND (NEW.max_players IS DISTINCT FROM v_source.max_players
      OR NEW.min_players IS DISTINCT FROM v_source.min_players))
    OR (v_abi='unlimited-mtt-v2' AND v_mtt AND (NEW.max_players IS NOT NULL
      OR NEW.min_players IS DISTINCT FROM GREATEST(3,COALESCE(v_source.min_players,3)))) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_CAPACITY_MISMATCH' USING ERRCODE='22023';END IF;
 -- The existing caller only repairs an out-of-policy legacy fee split. Its
 -- player-paid total is fixed, and compliant booked splits pass unchanged.
 v_total:=v_source.buy_in_amount+v_source.buy_in_fee;
 v_fee:=LEAST(v_source.buy_in_fee,trunc(v_total*0.1*100)/100);
 IF v_total IS NULL OR v_total::text IN ('NaN','Infinity','-Infinity')
    OR NEW.buy_in_fee IS DISTINCT FROM v_fee OR NEW.buy_in_amount IS DISTINCT FROM v_total-v_fee THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_PRICE_MISMATCH' USING ERRCODE='22023';END IF;
 IF (v_source.satellite_target_id IS NOT NULL AND v_source.satellite_target IS NOT NULL
      AND v_source.satellite_target_id<>v_source.satellite_target)
    OR (NEW.satellite_target_id IS NOT NULL AND NEW.satellite_target IS NOT NULL
      AND NEW.satellite_target_id<>NEW.satellite_target) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_MISMATCH' USING ERRCODE='22023';END IF;
 v_target:=COALESCE(v_source.satellite_target_id,v_source.satellite_target);
 IF COALESCE(NEW.satellite_target_id,NEW.satellite_target) IS DISTINCT FROM v_target
    OR (v_target IS NULL AND (upper(COALESCE(v_source.tournament_type,''))='SATELLITE'
      OR lower(COALESCE(v_source.variant,''))='satellite')) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_MISMATCH' USING ERRCODE='22023';END IF;
 IF v_target IS NOT NULL THEN
  SELECT * INTO v_target_row FROM public.tournaments WHERE id=v_target FOR UPDATE;
  IF NOT FOUND OR upper(v_target_row.status) NOT IN ('ANNOUNCED','REGISTERING')
    OR v_target_row.start_time IS NULL OR NOT isfinite(v_target_row.start_time)
    OR v_target_row.start_time<=NEW.start_time OR v_target_row.prize_pool_finalized IS TRUE
    OR (NEW.union_id IS NOT NULL AND v_target_row.union_id IS DISTINCT FROM NEW.union_id)
    OR (NEW.union_id IS NULL AND (v_target_row.club_id IS DISTINCT FROM NEW.club_id OR v_target_row.union_id IS NOT NULL))
    OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target) THEN
   RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_UNAVAILABLE' USING ERRCODE='22023';END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_tournament_restart_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_restart_source() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a1_tournaments_restart_source
BEFORE INSERT OR UPDATE OF restart_source_id OR DELETE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_tournament_restart_source();

CREATE FUNCTION public.fn_ensure_scheduled_mtt_satellite(p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='30s' AS $function$
DECLARE v_legacy public.tournaments%ROWTYPE; v_scheduled public.tournaments%ROWTYPE;
 v_row public.tournaments%ROWTYPE; v_target public.tournaments%ROWTYPE;
 v_existing public.tournaments%ROWTYPE; v_config jsonb; v_abi text; v_scope text;
 v_count integer; v_table_id uuid; v_result jsonb; v_total numeric; v_target_total numeric;
 v_min_lead interval; v_id uuid; v_index integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501';END IF;
 IF p_config IS NULL OR jsonb_typeof(p_config)<>'object'
   OR jsonb_typeof(p_config->'legacy_config') IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_config->'scheduled_config') IS DISTINCT FROM 'object'
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_config)k WHERE k NOT IN ('legacy_config','scheduled_config')) THEN
  RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_REQUEST' USING ERRCODE='22023';END IF;
 FOR v_index IN 1..2 LOOP
  v_config:=CASE v_index WHEN 1 THEN p_config->'legacy_config' ELSE p_config->'scheduled_config' END;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_config)k WHERE k NOT IN (
    'club_id','union_id','name','game_type','variant','tournament_type','buy_in_amount','buy_in_fee',
    'guaranteed_prize','starting_chips','max_players','min_players','table_size','current_players','status',
    'blind_structure','payout_structure','start_time','late_reg_levels','late_reg_mins','satellite_target_id',
    'satellite_seats','short_description') AND (v_index=1 OR k NOT IN ('blind_speed','is_turbo','synchronized_breaks'))) THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_UNKNOWN_CONFIG_KEY' USING ERRCODE='22023';END IF;
  SELECT * INTO v_row FROM jsonb_populate_record(NULL::public.tournaments,v_config);
  IF v_row.club_id IS NULL OR v_row.satellite_target_id IS NULL
    OR (v_row.union_id IS NOT NULL AND v_row.union_id<>v_row.club_id)
    OR NULLIF(btrim(v_row.name),'') IS NULL OR v_row.tournament_type IS DISTINCT FROM 'SATELLITE'
    OR v_row.status IS DISTINCT FROM 'REGISTERING' OR v_row.current_players IS DISTINCT FROM 0
    OR COALESCE(v_row.starting_chips,0)<=0 OR COALESCE(v_row.table_size,0) NOT BETWEEN 2 AND 9
    OR upper(COALESCE(v_row.game_type,'')) NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8')
    OR (upper(v_row.game_type)='PLO6' AND v_row.table_size>7)
    OR (upper(v_row.game_type)='PLO5' AND v_row.table_size>8)
    OR jsonb_typeof(v_row.blind_structure::jsonb) IS DISTINCT FROM 'array'
    OR v_row.payout_structure::jsonb IS DISTINCT FROM '[{"place":1,"percentage":100}]'::jsonb
    OR v_row.start_time IS NULL OR NOT isfinite(v_row.start_time)
    OR v_row.satellite_seats IS DISTINCT FROM 1 OR v_row.guaranteed_prize IS DISTINCT FROM 0::numeric
    OR v_row.late_reg_levels IS DISTINCT FROM 0 OR v_row.late_reg_mins IS DISTINCT FROM 0::numeric THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_CONFIG' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(v_row.blind_structure::jsonb)=0 THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_STRUCTURE' USING ERRCODE='22023';END IF;
  v_total:=v_row.buy_in_amount+v_row.buy_in_fee;
  IF v_total IS NULL OR v_total::text IN ('NaN','Infinity','-Infinity') OR v_total<1 OR v_total<>round(v_total)
    OR v_row.buy_in_amount<=0 OR v_row.buy_in_fee<0
    OR v_row.buy_in_fee IS DISTINCT FROM trunc(v_total*(CASE v_index WHEN 1 THEN 0.05 ELSE 0.1 END)*100)/100 THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_PRICE' USING ERRCODE='22023';END IF;
  IF v_index=1 THEN
   IF v_row.variant IS DISTINCT FROM 'sng' OR v_row.max_players IS DISTINCT FROM 2
      OR v_row.min_players IS DISTINCT FROM 2 OR v_row.table_size IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_LEGACY_CONFIG' USING ERRCODE='22023';END IF;
   v_legacy:=v_row;
  ELSE
   IF v_row.variant IS DISTINCT FROM 'satellite' OR v_row.max_players IS NOT NULL
      OR COALESCE(v_row.min_players,0)<3 OR v_row.synchronized_breaks IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_SCHEDULED_CONFIG' USING ERRCODE='22023';END IF;
   PERFORM public.fn_ca_mtt_blind_contract(v_row.blind_structure,v_row.starting_chips);
   v_scheduled:=v_row;
  END IF;
 END LOOP;
 IF (v_legacy.club_id,v_legacy.union_id,v_legacy.satellite_target_id,v_legacy.game_type)
    IS DISTINCT FROM (v_scheduled.club_id,v_scheduled.union_id,v_scheduled.satellite_target_id,v_scheduled.game_type) THEN
  RAISE EXCEPTION 'SATELLITE_CREATE_ENVELOPE_IDENTITY_MISMATCH' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF public.fn_entry_purchases_frozen() THEN RETURN jsonb_build_object('ok',false,'reason','platform_frozen');END IF;
 IF v_abi='legacy-capacity-v1' THEN
  v_row:=v_legacy;v_config:=p_config->'legacy_config';v_min_lead:=interval '30 minutes';
 ELSE
  v_row:=v_scheduled;v_config:=p_config->'scheduled_config';v_min_lead:=interval '3 hours';
 END IF;
 v_scope:=CASE WHEN v_row.union_id IS NOT NULL THEN 'union:'||v_row.union_id::text ELSE 'club:'||v_row.club_id::text END;
 PERFORM pg_advisory_xact_lock(hashtextextended('ca:mtt-satellite-board:'||v_scope||':'||v_row.satellite_target_id::text,0));
 SELECT * INTO v_target FROM public.tournaments WHERE id=v_row.satellite_target_id FOR UPDATE;
 IF NOT FOUND OR (v_row.union_id IS NOT NULL AND v_target.union_id IS DISTINCT FROM v_row.union_id)
   OR (v_row.union_id IS NULL AND (v_target.club_id IS DISTINCT FROM v_row.club_id OR v_target.union_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'SATELLITE_CREATE_TARGET_SCOPE_MISMATCH' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO v_count FROM public.tournaments t WHERE
  ((v_row.union_id IS NOT NULL AND t.union_id=v_row.union_id)
    OR (v_row.union_id IS NULL AND t.club_id=v_row.club_id AND t.union_id IS NULL))
  AND (t.satellite_target_id=v_target.id OR t.satellite_target=v_target.id)
  AND upper(COALESCE(t.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED');
 IF v_count>1 THEN RAISE EXCEPTION 'SATELLITE_CREATE_ACTIVE_IDENTITY_AMBIGUOUS' USING ERRCODE='22023';END IF;
 IF v_count=1 THEN
  SELECT * INTO v_existing FROM public.tournaments t WHERE
   ((v_row.union_id IS NOT NULL AND t.union_id=v_row.union_id)
     OR (v_row.union_id IS NULL AND t.club_id=v_row.club_id AND t.union_id IS NULL))
   AND (t.satellite_target_id=v_target.id OR t.satellite_target=v_target.id)
   AND upper(COALESCE(t.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED') FOR UPDATE;
  IF v_existing.club_id IS DISTINCT FROM v_row.club_id OR v_existing.union_id IS DISTINCT FROM v_row.union_id THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_EXISTING_OWNER_MISMATCH' USING ERRCODE='22023';END IF;
  IF v_existing.satellite_target_id IS NOT NULL AND v_existing.satellite_target IS NOT NULL
     AND v_existing.satellite_target_id<>v_existing.satellite_target THEN
   RAISE EXCEPTION 'SATELLITE_TARGET_POINTER_CONTRADICTION' USING ERRCODE='22023';END IF;
  IF v_existing.format_contract='seat-first-satellite-v1' THEN
   SELECT count(*) INTO v_count FROM public.tables WHERE tournament_id=v_existing.id
     AND COALESCE(is_deleted,false)=false AND status IN ('waiting','running');
   IF v_count<>1 OR v_existing.max_players IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_LEGACY_TABLE_RECEIPT_MISSING' USING ERRCODE='23514';END IF;
   SELECT id INTO v_table_id FROM public.tables WHERE tournament_id=v_existing.id
     AND COALESCE(is_deleted,false)=false AND status IN ('waiting','running')
     AND club_id=v_existing.club_id AND max_players=2 FOR UPDATE;
   IF v_table_id IS NULL THEN RAISE EXCEPTION 'SATELLITE_CREATE_LEGACY_TABLE_RECEIPT_MISSING' USING ERRCODE='23514';END IF;
  ELSIF v_existing.format_contract IS NULL OR v_existing.format_contract NOT IN ('mtt-v1','mtt-v2') THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_EXISTING_FORMAT_UNQUALIFIED' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('ok',true,'outcome','existing_active','tournament_id',v_existing.id,
   'target_id',v_target.id,'club_id',v_row.club_id,'union_id',v_row.union_id,
   'format_contract',v_existing.format_contract,'table_id',v_table_id,'tournament',to_jsonb(v_existing));
 END IF;
 IF NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target.id)
   OR upper(COALESCE(v_target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
   OR v_target.prize_pool_finalized IS TRUE OR v_target.start_time IS NULL OR NOT isfinite(v_target.start_time)
   OR v_target.start_time<clock_timestamp()+v_min_lead OR v_target.start_time>=clock_timestamp()+interval '7 days'
   OR v_row.start_time<=clock_timestamp() OR v_row.start_time>=v_target.start_time THEN
  RAISE EXCEPTION 'SATELLITE_CREATE_TARGET_UNAVAILABLE' USING ERRCODE='22023';END IF;
 v_target_total:=v_target.buy_in_amount+v_target.buy_in_fee;
 IF v_target_total IS NULL OR v_target_total::text IN ('NaN','Infinity','-Infinity')
   OR v_target_total<20 OR v_target_total<>round(v_target_total,2)
   OR v_row.min_players*v_row.buy_in_amount<v_target_total THEN
  RAISE EXCEPTION 'SATELLITE_CREATE_UNFUNDED_MINIMUM' USING ERRCODE='22023';END IF;
 v_id:=gen_random_uuid();
 IF v_abi='legacy-capacity-v1' THEN
  v_result:=public.fn_create_seat_first_game_atomic(v_id,v_config);
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'SATELLITE_CREATE_LEGACY_AUTHORITY_REFUSED: %',v_result->>'reason' USING ERRCODE='55000';END IF;
  v_table_id:=(v_result->>'table_id')::uuid;
 ELSE
  INSERT INTO public.tournaments(club_id,union_id,name,game_type,variant,tournament_type,
   buy_in_amount,buy_in_fee,guaranteed_prize,starting_chips,max_players,min_players,table_size,current_players,status,
   blind_structure,blind_speed,is_turbo,payout_structure,start_time,late_reg_levels,late_reg_mins,synchronized_breaks,
   satellite_target_id,satellite_seats,short_description)
  VALUES(v_row.club_id,v_row.union_id,v_row.name,v_row.game_type,'satellite','SATELLITE',
   v_row.buy_in_amount,v_row.buy_in_fee,0,v_row.starting_chips,NULL,v_row.min_players,v_row.table_size,0,'REGISTERING',
   v_row.blind_structure,v_row.blind_speed,v_row.is_turbo,v_row.payout_structure,v_row.start_time,0,0,true,
   v_target.id,1,v_row.short_description) RETURNING id INTO v_id;
 END IF;
 SELECT * INTO STRICT v_existing FROM public.tournaments WHERE id=v_id;
 IF (v_abi='legacy-capacity-v1' AND (v_existing.format_contract IS DISTINCT FROM 'seat-first-satellite-v1' OR v_table_id IS NULL))
   OR (v_abi='unlimited-mtt-v2' AND (v_existing.format_contract IS DISTINCT FROM 'mtt-v2' OR v_table_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'SATELLITE_CREATE_FORMAT_RECEIPT_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('ok',true,'outcome','created','tournament_id',v_id,'target_id',v_target.id,
  'club_id',v_row.club_id,'union_id',v_row.union_id,'format_contract',v_existing.format_contract,
  'table_id',v_table_id,'tournament',to_jsonb(v_existing));
END $function$;
ALTER FUNCTION public.fn_ensure_scheduled_mtt_satellite(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ensure_scheduled_mtt_satellite(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ensure_scheduled_mtt_satellite(jsonb) TO service_role;
COMMIT;
