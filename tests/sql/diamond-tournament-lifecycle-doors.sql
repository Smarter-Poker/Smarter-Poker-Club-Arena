-- ============================================================================
-- THE DIAMOND TOURNAMENT LIFECYCLE DOORS, CAPTURED
-- ============================================================================
--
-- The second half of the Diamond tournament capture, and the half the first
-- half did not need. `diamond-tournament-doors-captured.sql` carries the 79
-- functions the Diamond tournament money path CALLS. This file carries the
-- functions production FIRES: the trigger chain the create door's own INSERT
-- into public.tournaments runs, plus everything that chain calls, to closure.
--
-- It exists because the historical base and production disagree there. Loaded
-- against the base alone, a Diamond MTT is refused by a creation guard 165
-- bytes shorter than the installed one and never reaches nine refusals
-- production would have run. Measured on the loaded fixture and on production,
-- both read read-only, 2026-09-20: production attaches 60 triggers to
-- public.tournaments naming 58 distinct functions; of those 58, 34 are already
-- byte-identical in the historical base, 13 render to different text and 11 are
-- absent from it. Twelve of the 60 triggers are not attached in the base at
-- all, and one trigger the base carries - a0_tournament_manager_write_scope -
-- names a function production does not have.
--
-- So every door below is the exact text pg_get_functiondef() returns on
-- production, and every one carries the md5 of that text on the line above it.
-- The block at the foot of this file reads each one back out of the catalogue
-- it was just loaded into and refuses to finish if a single one disagrees.
-- Nothing here is authored and nothing here may be edited by hand.
--
-- NEVER weaken, stub, disable or compare-against-NULL one of these pins to
-- make a fixture build. The pin is the only thing standing between an
-- in-place edit and a silently different money function.
--
-- WHERE THE BYTES CAME FROM. Twenty of the twenty-two were already committed
-- in this repository, byte-identical to the installed definition, and were
-- found by hashing every CREATE FUNCTION block on disk against the production
-- pins rather than by assuming. Two were transported from production in this
-- session. The manifest beside this file records which, per door.
--
-- Load order does not matter: check_function_bodies is off, exactly as
-- pg_dump and the estate's other captured overlays load functions.
-- ============================================================================
SET check_function_bodies = off;
SET search_path = public, extensions, pg_catalog;

-- @@DOOR fn_ca_blind_contract_number(p_value jsonb)
-- @@PIN md5=7463d39ac93442f5afca76e4ab4e99ba len=441 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_blind_contract_number(p_value jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE STRICT
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v numeric; t text:=p_value #>> '{}';
BEGIN
  IF jsonb_typeof(p_value) NOT IN ('number','string') OR t !~ '^[0-9]+([.][0-9]+)?$' THEN RETURN NULL; END IF;
  v:=t::numeric;
  IF v>9007199254740991 THEN RETURN NULL; END IF;
  RETURN v;
END;
$function$;
ALTER FUNCTION public.fn_ca_blind_contract_number(p_value jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_blind_contract_number(p_value jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_blind_contract_number(p_value jsonb) TO service_role;
-- @@END fn_ca_blind_contract_number(p_value jsonb)

-- @@DOOR fn_ca_guard_new_satellite_target()
-- @@PIN md5=69247df72bfb68c7148c1a7f9ea4cfd7 len=3426 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_new_satellite_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
REVOKE ALL ON FUNCTION public.fn_ca_guard_new_satellite_target() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_guard_new_satellite_target()

-- @@DOOR fn_ca_guard_tournament_format()
-- @@PIN md5=ff6655365bfdd99ae31dc897568f31e7 len=1830 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_tournament_format()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text; v_abi text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.format_contract IS NOT NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IS_DATABASE_ASSIGNED' USING ERRCODE='22023';
    END IF;
    v_abi:=public.fn_ca_lock_mtt_admission_contract();
    IF v_abi='unlimited-mtt-v2' AND public.fn_ca_is_new_mtt(to_jsonb(NEW)) THEN
      IF NEW.max_players IS NOT NULL OR COALESCE(NEW.min_players,0)<3 THEN
        RAISE EXCEPTION 'MTT_V2_CAPACITY_NOT_NORMALIZED' USING ERRCODE='23514';
      END IF;
      v_format:='mtt-v2';
    ELSE
      v_format:=public.fn_ca_legacy_tournament_format(to_jsonb(NEW));
    END IF;
    IF v_format IS NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_LEGACY_FORMAT_AMBIGUOUS' USING ERRCODE='23514';
    END IF;
    NEW.format_contract:=v_format;
    RETURN NEW;
  END IF;
  IF NEW.format_contract IS DISTINCT FROM OLD.format_contract THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF OLD.format_contract='mtt-v2' THEN
    IF NOT public.fn_ca_is_new_mtt(to_jsonb(NEW)) OR NEW.max_players IS NOT NULL
       OR COALESCE(NEW.min_players,0)<3 THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF public.fn_ca_tournament_format_identity(to_jsonb(NEW))
      IS DISTINCT FROM public.fn_ca_tournament_format_identity(to_jsonb(OLD))
     AND (OLD.format_contract IS NULL
          OR public.fn_ca_legacy_tournament_format(to_jsonb(NEW)) IS DISTINCT FROM OLD.format_contract) THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_tournament_format() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_format() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_guard_tournament_format()

-- @@DOOR fn_ca_guard_tournament_restart_source()
-- @@PIN md5=afe57e7d2b37feba95af19b41f9f2df5 len=6455 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_tournament_restart_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_restart_source() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_guard_tournament_restart_source()

-- @@DOOR fn_ca_legacy_tournament_format(p_row jsonb)
-- @@PIN md5=a83410b4370de8d24e561709dd800ccd len=1700 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_tournament_format(p_row jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN upper(p_row->>'tournament_type')='SPIN' AND lower(p_row->>'variant')='spin'
      AND p_row->>'max_players'='3'
      AND NULLIF(p_row->>'satellite_target_id','') IS NULL
      AND NULLIF(p_row->>'satellite_target','') IS NULL THEN 'spin-v1'
    WHEN upper(p_row->>'tournament_type')='SNG' AND lower(p_row->>'variant')='sng'
      AND CASE WHEN coalesce(p_row->>'max_players','')~'^[0-9]+$'
               THEN (p_row->>'max_players')::numeric>=2 ELSE false END
      AND NULLIF(p_row->>'satellite_target_id','') IS NULL
      AND NULLIF(p_row->>'satellite_target','') IS NULL THEN 'sng-v1'
    WHEN upper(p_row->>'tournament_type')='SATELLITE' AND lower(p_row->>'variant')='sng'
      AND p_row->>'max_players'='2' AND p_row->>'min_players'='2'
      AND p_row->>'table_size'='2'
      AND coalesce(NULLIF(p_row->>'satellite_target_id',''),NULLIF(p_row->>'satellite_target','')) IS NOT NULL
      AND (NULLIF(p_row->>'satellite_target_id','') IS NULL
           OR NULLIF(p_row->>'satellite_target','') IS NULL
           OR p_row->>'satellite_target_id'=p_row->>'satellite_target')
      THEN 'seat-first-satellite-v1'
    WHEN upper(p_row->>'tournament_type') IN ('MTT','XMTT')
      AND lower(p_row->>'variant') IN
        ('freezeout','rebuy','reentry','bounty','progressive_bounty','mystery_bounty','satellite','mtt')
      AND CASE WHEN coalesce(p_row->>'max_players','')~'^[0-9]+$'
               THEN (p_row->>'max_players')::numeric>2 ELSE false END THEN 'mtt-v1'
    ELSE NULL END
$function$;
ALTER FUNCTION public.fn_ca_legacy_tournament_format(p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_tournament_format(p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_legacy_tournament_format(p_row jsonb)

-- @@DOOR fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer)
-- @@PIN md5=4a13e21eba115284df84b1f8be2c83de len=3523 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  levels jsonb; r jsonb; i integer:=0; played integer:=0;
  sb numeric; bb numeric; ante numeric; mins numeric; secs numeric; opening numeric;
  previous_sb numeric:=-1; previous_bb numeric:=-1; speed text;
BEGIN
  IF p_starting_chips IS NULL OR p_starting_chips<=0 THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: starting stack must be a positive whole number' USING ERRCODE='22023';
  END IF;
  BEGIN levels:=p_structure::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: unreadable ladder' USING ERRCODE='22023';
  END;
  IF levels IS NULL OR jsonb_typeof(levels)<>'array' THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: at least one playable level is required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(levels)=0 THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: at least one playable level is required' USING ERRCODE='22023';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(levels) LOOP
    i:=i+1;
    IF jsonb_typeof(r)<>'object' THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % must be an object',i USING ERRCODE='22023';
    END IF;
    IF r ? 'isBreak' AND jsonb_typeof(r->'isBreak')<>'boolean' THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % has an invalid break flag',i USING ERRCODE='22023';
    END IF;
    mins:=public.fn_ca_blind_contract_number(COALESCE(NULLIF(r->'durationMinutes','null'::jsonb),r->'duration_minutes'));
    secs:=public.fn_ca_blind_contract_number(r->'duration');
    IF COALESCE(mins,0)<=0 AND COALESCE(secs,0)<=0 THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % needs a positive duration',i USING ERRCODE='22023';
    END IF;
    sb:=public.fn_ca_blind_contract_number(r->'smallBlind');
    bb:=public.fn_ca_blind_contract_number(r->'bigBlind');
    ante:=CASE WHEN r ? 'ante' THEN public.fn_ca_blind_contract_number(r->'ante') ELSE 0 END;
    IF sb IS NULL OR bb IS NULL OR ante IS NULL THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % has invalid blinds or ante',i USING ERRCODE='22023';
    END IF;
    IF r->'isBreak'='true'::jsonb THEN
      IF i=1 OR sb<>0 OR bb<>0 OR ante<>0 THEN
        RAISE EXCEPTION 'Invalid tournament blind structure: level % is not a valid break',i USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;
    IF bb<=0 OR sb>bb THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % needs a positive big blind at least as large as its small blind',i USING ERRCODE='22023';
    END IF;
    IF sb<previous_sb OR bb<previous_bb THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % decreases the blinds',i USING ERRCODE='22023';
    END IF;
    IF played=0 THEN opening:=CASE WHEN mins>0 THEN mins ELSE secs/60 END; END IF;
    previous_sb:=sb; previous_bb:=bb; played:=played+1;
  END LOOP;
  IF played=0 THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: at least one playable level is required' USING ERRCODE='22023';
  END IF;
  speed:=CASE WHEN opening<=2 THEN 'hyper_turbo' WHEN opening<=5 THEN 'turbo' WHEN opening>=12 THEN 'slow' ELSE 'standard' END;
  RETURN jsonb_build_object('blind_speed',speed,'is_turbo',speed IN ('turbo','hyper_turbo'));
END;
$function$;
ALTER FUNCTION public.fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer) TO service_role;
-- @@END fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer)

-- @@DOOR fn_ca_normalize_new_mtt_capacity()
-- @@PIN md5=06cbd73a8011fac92e0c51b8d752b3da len=1257 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_normalize_new_mtt_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_unlimited boolean;
BEGIN
 v_unlimited:=public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW));
 IF TG_OP='INSERT' THEN
  IF v_unlimited THEN
   IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'MTT_CREATION_PLATFORM_FROZEN' USING ERRCODE='55000';
   END IF;
   NEW.max_players:=NULL;
   NEW.min_players:=GREATEST(3,COALESCE(NEW.min_players,3));
   IF COALESCE(NEW.satellite_target_id,NEW.satellite_target) IS NOT NULL
      AND (upper(COALESCE(NEW.tournament_type,'')) IN ('SNG','SPIN')
           OR lower(COALESCE(NEW.variant,'')) IN ('sng','spin')) THEN
    RAISE EXCEPTION 'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' USING ERRCODE='55000';
   END IF;
  END IF;
 ELSIF OLD.format_contract='mtt-v2' THEN
  IF NOT v_unlimited THEN
   RAISE EXCEPTION 'MTT_V2_REQUIRES_ACTIVE_ADMISSION' USING ERRCODE='55000';
  END IF;
  NEW.max_players:=NULL;
 ELSIF v_unlimited AND OLD.format_contract='mtt-v1' THEN
  -- A now-irrelevant cap edit cannot rewrite an accepted version1 contract.
  NEW.max_players:=OLD.max_players;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_normalize_new_mtt_capacity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_normalize_new_mtt_capacity() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_normalize_new_mtt_capacity()

-- @@DOOR fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)
-- @@PIN md5=3933ec28773f12a1da9b02952ad99ed4 len=900 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
ALTER FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)

-- @@DOOR fn_ca_tournament_format_identity(p_row jsonb)
-- @@PIN md5=49173db4a4cb01024d37e292d9471795 len=584 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_format_identity(p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
    'id',p_row->'id','club_id',p_row->'club_id','union_id',p_row->'union_id',
    'tournament_type',p_row->'tournament_type','variant',p_row->'variant',
    'max_players',p_row->'max_players','min_players',p_row->'min_players',
    'table_size',p_row->'table_size',
    'satellite_target_id',p_row->'satellite_target_id','satellite_target',p_row->'satellite_target')
$function$;
ALTER FUNCTION public.fn_ca_tournament_format_identity(p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_format_identity(p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_format_identity(p_row jsonb)

-- @@DOOR fn_emit_managed_game_row_event()
-- @@PIN md5=9706ead97b5e6f495957bfd02a6eb282 len=2075 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_document jsonb := to_jsonb(NEW);
  v_old_document jsonb := to_jsonb(OLD);
  v_club  uuid := COALESCE(v_new_document ->> 'club_id', v_old_document ->> 'club_id')::uuid;
  v_id    uuid := COALESCE(v_new_document ->> 'id',      v_old_document ->> 'id')::uuid;
  v_watch text[];
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME = 'tables' THEN
    IF COALESCE(v_new_document ->> 'tournament_id',
                v_old_document ->> 'tournament_id') IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Exactly the columns fn_list_managed_games projects for this kind. Keep
    -- these two lists in step with that function: a column the board reads and
    -- this does not watch is a row that silently stops refreshing.
    v_watch := CASE TG_TABLE_NAME
      WHEN 'tables' THEN ARRAY[
        'club_id', 'union_id', 'tournament_id', 'is_deleted', 'name', 'status',
        'game_variant', 'current_players', 'max_players', 'small_blind',
        'big_blind', 'min_buy_in', 'max_buy_in', 'created_at']
      ELSE ARRAY[
        'club_id', 'union_id', 'name', 'status', 'game_type', 'variant',
        'current_players', 'max_players', 'start_time', 'created_at',
        'buy_in_amount', 'guaranteed_prize', 'prize_pool']
    END;

    IF (SELECT jsonb_object_agg(k, COALESCE(v_old_document -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
       IS NOT DISTINCT FROM
       (SELECT jsonb_object_agg(k, COALESCE(v_new_document -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
    THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL,
    CASE WHEN TG_TABLE_NAME = 'tables' THEN 'table' ELSE 'tournament' END,
    v_id, NULL, jsonb_build_object('operation', lower(TG_OP)));
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_emit_managed_game_row_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_emit_managed_game_row_event() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_emit_managed_game_row_event() TO service_role;
-- @@END fn_emit_managed_game_row_event()

-- @@DOOR fn_guard_new_mtt_blind_contract()
-- @@PIN md5=aac67e5c89eaa564744a97a85b5f3fbb len=1510 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_guard_new_mtt_blind_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE contract jsonb;
BEGIN
  IF (TG_OP='INSERT' OR OLD.format_contract IN ('mtt-v1','mtt-v2'))
     AND public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN
    IF TG_OP='UPDATE' AND OLD.format_contract IN ('mtt-v1','mtt-v2')
       AND NEW.blind_structure IS NOT DISTINCT FROM OLD.blind_structure
       AND NEW.starting_chips IS NOT DISTINCT FROM OLD.starting_chips THEN RETURN NEW; END IF;
    contract:=public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);
    NEW.blind_speed:=contract->>'blind_speed';
    NEW.is_turbo:=(contract->>'is_turbo')::boolean;
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.tournament_type,''))<>'MTT'
     OR lower(COALESCE(NEW.variant,'')) IN ('spin','sng')
     OR COALESCE(NEW.max_players,0)<=2 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.blind_structure IS NOT DISTINCT FROM OLD.blind_structure
     AND NEW.starting_chips IS NOT DISTINCT FROM OLD.starting_chips
     AND upper(COALESCE(OLD.tournament_type,''))='MTT'
     AND lower(COALESCE(OLD.variant,'')) NOT IN ('spin','sng')
     AND COALESCE(OLD.max_players,0)>2 THEN RETURN NEW; END IF;
  contract:=public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);
  NEW.blind_speed:=contract->>'blind_speed';
  NEW.is_turbo:=(contract->>'is_turbo')::boolean;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_new_mtt_blind_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_new_mtt_blind_contract() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_new_mtt_blind_contract() TO service_role;
-- @@END fn_guard_new_mtt_blind_contract()

-- @@DOOR fn_guard_tournament_mystery_creation_contract()
-- @@PIN md5=07d896448e45728a89fc46eafc2a0eeb len=3005 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_guard_tournament_mystery_creation_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_expected jsonb; v_actual jsonb;
BEGIN
  IF TG_OP='UPDATE' AND coalesce(OLD.is_mystery_bounty,false)
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'pending'
     AND ROW(NEW.is_mystery_bounty,NEW.mystery_bounty_profile,NEW.mystery_bounty_activation,NEW.mystery_bounty_activation_value,
       NEW.mystery_bounty_pool_percent,NEW.mystery_bounty_regular_pool_percent,NEW.mystery_bounty_top_percent)
     IS DISTINCT FROM ROW(OLD.is_mystery_bounty,OLD.mystery_bounty_profile,OLD.mystery_bounty_activation,OLD.mystery_bounty_activation_value,
       OLD.mystery_bounty_pool_percent,OLD.mystery_bounty_regular_pool_percent,OLD.mystery_bounty_top_percent) THEN
    RAISE EXCEPTION 'Mystery bounty terms cannot change after activation' USING ERRCODE='55000';
  END IF;
  IF NOT coalesce(NEW.is_mystery_bounty,false) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND coalesce(OLD.is_mystery_bounty,false)
     AND ROW(NEW.mystery_bounty_profile,NEW.mystery_bounty_activation,NEW.mystery_bounty_activation_value,
       NEW.mystery_bounty_pool_percent,NEW.mystery_bounty_regular_pool_percent,NEW.mystery_bounty_top_percent)
     IS NOT DISTINCT FROM ROW(OLD.mystery_bounty_profile,OLD.mystery_bounty_activation,OLD.mystery_bounty_activation_value,
       OLD.mystery_bounty_pool_percent,OLD.mystery_bounty_regular_pool_percent,OLD.mystery_bounty_top_percent)
    THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.mystery_bounty_stage IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Mystery bounty terms cannot change after activation' USING ERRCODE='55000';
  END IF;
  v_expected:=public.fn_mystery_bounty_creation_document(jsonb_build_object(
    'mysteryBountyProfile',NEW.mystery_bounty_profile,'mysteryBountyActivation',NEW.mystery_bounty_activation,
    'mysteryBountyActivationValue',NEW.mystery_bounty_activation_value,
    'mysteryBountyPoolPercent',NEW.mystery_bounty_pool_percent,'mysteryBountyTopPercent',NEW.mystery_bounty_top_percent));
  IF NEW.mystery_bounty_regular_pool_percent IS DISTINCT FROM
     (v_expected->>'mystery_bounty_regular_pool_percent')::numeric THEN
    RAISE EXCEPTION 'Mystery bounty pool percentages must total 100' USING ERRCODE='22023';
  END IF;
  v_actual:=jsonb_build_object('mystery_bounty_profile',NEW.mystery_bounty_profile,
    'mystery_bounty_activation',NEW.mystery_bounty_activation,
    'mystery_bounty_activation_value',NEW.mystery_bounty_activation_value,
    'mystery_bounty_pool_percent',NEW.mystery_bounty_pool_percent,
    'mystery_bounty_regular_pool_percent',NEW.mystery_bounty_regular_pool_percent,
    'mystery_bounty_top_percent',NEW.mystery_bounty_top_percent);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Invalid canonical mystery bounty configuration' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_tournament_mystery_creation_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_mystery_creation_contract() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_mystery_creation_contract() TO service_role;
-- @@END fn_guard_tournament_mystery_creation_contract()

-- @@DOOR fn_guard_tournament_prize_math_contract()
-- @@PIN md5=9db38ea56f880456fdbbc29394c4cb27 len=1988 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_guard_tournament_prize_math_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_unit integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    -- Legacy club routing remains governed by its existing contract guards.
    -- This trigger freezes denomination only for an explicitly versioned ladder.
    IF OLD.payout_math_version=1 AND NEW.payout_math_version=1
       AND OLD.payout_unit_cents=1 AND NEW.payout_unit_cents=1 THEN RETURN NEW; END IF;
    IF ROW(NEW.payout_math_version,NEW.payout_unit_cents,NEW.club_id) IS NOT DISTINCT FROM
       ROW(OLD.payout_math_version,OLD.payout_unit_cents,OLD.club_id) THEN RETURN NEW; END IF;
    IF COALESCE(OLD.entry_contract_locked,false) OR COALESCE(OLD.prize_pool_finalized,false)
       OR OLD.started_at IS NOT NULL
       OR upper(COALESCE(OLD.status,'')) NOT IN('ANNOUNCED','REGISTERING','SCHEDULED')
       OR upper(COALESCE(NEW.status,'')) NOT IN('ANNOUNCED','REGISTERING','SCHEDULED')
       OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=OLD.id)
       OR EXISTS(SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id=OLD.id)
       OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts lr WHERE lr.tournament_id=OLD.id) THEN
      RAISE EXCEPTION 'Tournament prize arithmetic is frozen after entry or launch'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.payout_math_version=2 THEN
    SELECT CASE WHEN c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
                THEN 100 ELSE 1 END INTO v_unit FROM public.clubs c WHERE c.id=NEW.club_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Prize contract requires an existing club' USING ERRCODE='23503'; END IF;
    -- The club determines denomination; a caller cannot request fractional Diamonds.
    NEW.payout_unit_cents:=v_unit;
  ELSE
    NEW.payout_unit_cents:=1;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_tournament_prize_math_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_prize_math_contract() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_prize_math_contract() TO service_role;
-- @@END fn_guard_tournament_prize_math_contract()

-- @@DOOR fn_mystery_bounty_creation_document(p_config jsonb)
-- @@PIN md5=0651f9abdf0f91cfb3378dee79d3e65c len=2633 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_creation_document(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile text:=coalesce(p_config->>'mysteryBountyProfile','classic');
  v_activation text:=coalesce(p_config->>'mysteryBountyActivation','at_the_money');
  v_value jsonb:=coalesce(p_config->'mysteryBountyActivationValue','null'::jsonb);
  v_pool jsonb:=coalesce(nullif(p_config->'mysteryBountyPoolPercent','null'::jsonb),'50'::jsonb);
  v_top jsonb:=coalesce(nullif(p_config->'mysteryBountyTopPercent','null'::jsonb),'20'::jsonb);
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'Invalid mystery bounty configuration' USING ERRCODE='22023';
  END IF;
  IF v_profile NOT IN ('balanced','classic','jackpot') THEN
    RAISE EXCEPTION 'Invalid mystery bounty profile' USING ERRCODE='22023';
  END IF;
  IF v_activation NOT IN ('at_the_money','percent_field','player_count') THEN
    RAISE EXCEPTION 'Invalid mystery bounty activation' USING ERRCODE='22023';
  END IF;
  IF v_activation<>'at_the_money' THEN
    IF jsonb_typeof(v_value)<>'number' THEN
      RAISE EXCEPTION 'Invalid mystery bounty activation value' USING ERRCODE='22023';
    END IF;
    IF v_activation='percent_field' AND ((v_value#>>'{}')::numeric<=0 OR (v_value#>>'{}')::numeric>100) THEN
      RAISE EXCEPTION 'Invalid mystery bounty activation percentage' USING ERRCODE='22023';
    END IF;
    IF v_activation='player_count' AND ((v_value#>>'{}')::numeric<2
       OR (v_value#>>'{}')::numeric>9007199254740991
       OR trunc((v_value#>>'{}')::numeric)<>(v_value#>>'{}')::numeric) THEN
      RAISE EXCEPTION 'Invalid mystery bounty activation player count' USING ERRCODE='22023';
    END IF;
  ELSE
    v_value:='null'::jsonb;
  END IF;
  IF jsonb_typeof(v_pool)<>'number' OR jsonb_typeof(v_top)<>'number' THEN
    RAISE EXCEPTION 'Invalid mystery bounty percentage type' USING ERRCODE='22023';
  END IF;
  IF (v_pool#>>'{}')::numeric<0 OR (v_pool#>>'{}')::numeric>100
     OR trunc((v_pool#>>'{}')::numeric*100)<>(v_pool#>>'{}')::numeric*100
     OR (v_top#>>'{}')::numeric<=0 OR (v_top#>>'{}')::numeric>100 THEN
    RAISE EXCEPTION 'Invalid mystery bounty percentage range' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('mystery_bounty_profile',v_profile,
    'mystery_bounty_activation',v_activation,'mystery_bounty_activation_value',v_value,
    'mystery_bounty_pool_percent',v_pool,'mystery_bounty_regular_pool_percent',100-(v_pool#>>'{}')::numeric,
    'mystery_bounty_top_percent',v_top);
END;
$function$;
ALTER FUNCTION public.fn_mystery_bounty_creation_document(p_config jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_creation_document(p_config jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_creation_document(p_config jsonb) TO service_role;
-- @@END fn_mystery_bounty_creation_document(p_config jsonb)

-- @@DOOR fn_poker_guard_arena_structure()
-- @@PIN md5=f17675dd0b647abda7b0b9d8772c9c0e len=3148 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_guard_arena_structure()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF TG_OP='UPDATE' AND (NEW.asset,NEW.is_platform) IS DISTINCT FROM (OLD.asset,OLD.is_platform) THEN
      RAISE EXCEPTION 'Arena Asset Is Immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.asset='diamonds' AND auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT asset INTO v_asset FROM public.clubs WHERE id=NEW.club_id;
  IF TG_TABLE_NAME='club_members' AND TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
     AND EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Participation Cannot Become A Chip Membership' USING ERRCODE='23514';
  END IF;
  -- Branch before resolving fields: membership rows do not have union_id.
  IF TG_TABLE_NAME IN ('tables','tournaments') THEN
    IF TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
       AND (EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset IS DISTINCT FROM v_asset)
         OR (OLD.club_id IS NULL AND OLD.union_id IS NOT NULL AND v_asset='diamonds')) THEN
      RAISE EXCEPTION 'Game Asset Is Immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_asset='diamonds' THEN
    IF TG_TABLE_NAME='club_members' THEN
      IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
         OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
         OR coalesce(NEW.chip_balance,0)<>0 OR coalesce(NEW.credit_limit,0)<>0
         OR coalesce(NEW.credit_used,0)<>0 OR coalesce(NEW.promo_balance,0)<>0
         OR coalesce(NEW.held_chips,0)<>0 THEN
        RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='union_clubs' THEN
      RAISE EXCEPTION 'Diamond Arena Cannot Join A Union' USING ERRCODE='23514';
    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false)
       -- DIAMOND PHASE 8: a player's entry, add-on and withdrawal move the
       -- play-state counters through the estate's doors; the structure is
       -- still platform operations only.
       AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('tournaments','tables')
                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';
    ELSIF NEW.union_id IS NOT NULL THEN
      RAISE EXCEPTION 'Diamond Games Cannot Belong To A Union' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_poker_guard_arena_structure() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_guard_arena_structure() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_guard_arena_structure() TO service_role;
-- @@END fn_poker_guard_arena_structure()

-- @@DOOR fn_satellite_feeds_only_a_deliverable_target()
-- @@PIN md5=4251f65adfd51a29967a346af7ae98f1 len=2135 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_satellite_feeds_only_a_deliverable_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
  v_old_target uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_target := COALESCE(OLD.satellite_target_id, OLD.satellite_target);
  END IF;

  -- A satellite may only be opened into, or re-pointed at, a target whose
  -- seat the settlement authority can deliver.
  IF v_target IS NOT NULL
     AND (TG_OP = 'INSERT' OR v_target IS DISTINCT FROM v_old_target)
     AND NOT public.fn_satellite_target_is_deliverable(v_target) THEN
    RAISE EXCEPTION
      'satellite % cannot feed target %: the satellite settlement authority refuses a bounty, PKO, mystery-bounty or Spin entry split',
      NEW.id, v_target
      USING ERRCODE = '22023',
            HINT = 'Pick a target whose entry is a plain buy-in plus fee.';
  END IF;

  -- A tournament live satellites feed may not become one that refuses them.
  IF TG_OP = 'UPDATE'
     AND (NEW.is_bounty, NEW.is_pko, NEW.is_mystery_bounty, NEW.is_premium_spin,
          NEW.variant, NEW.tournament_type)
         IS DISTINCT FROM
         (OLD.is_bounty, OLD.is_pko, OLD.is_mystery_bounty, OLD.is_premium_spin,
          OLD.variant, OLD.tournament_type)
     AND NOT (NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE
              AND NEW.is_mystery_bounty IS FALSE AND NEW.is_premium_spin IS FALSE
              AND lower(COALESCE(NEW.variant, '')) <> 'spin'
              AND upper(COALESCE(NEW.tournament_type, '')) <> 'SPIN')
     AND EXISTS (
       SELECT 1 FROM public.tournaments s
        WHERE COALESCE(s.satellite_target_id, s.satellite_target) = NEW.id
          AND s.id <> NEW.id
          AND upper(COALESCE(s.status, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
     ) THEN
    RAISE EXCEPTION
      'tournament % is fed by a live satellite and cannot take a bounty, PKO, mystery-bounty or Spin entry split',
      NEW.id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_satellite_feeds_only_a_deliverable_target() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_satellite_feeds_only_a_deliverable_target() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_satellite_feeds_only_a_deliverable_target()

-- @@DOOR fn_satellite_target_is_deliverable(p_target_id uuid)
-- @@PIN md5=dbd45692f53316d0142c0034fe0a7245 len=793 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Mirrors the admission refusal in fn_settle_satellite_tournament_pre_money_path_gate
  -- exactly: every flag must be a known false, and neither Spin spelling.
  -- A missing target is not deliverable either (the authority refuses it).
  SELECT COALESCE((
    SELECT t.is_bounty IS FALSE
       AND t.is_pko IS FALSE
       AND t.is_mystery_bounty IS FALSE
       AND t.is_premium_spin IS FALSE
       AND lower(COALESCE(t.variant, '')) <> 'spin'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SPIN'
      FROM public.tournaments t
     WHERE t.id = p_target_id
  ), false)
$function$;
ALTER FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid) TO service_role;
-- @@END fn_satellite_target_is_deliverable(p_target_id uuid)

-- @@DOOR fn_short_formats_never_break()
-- @@PIN md5=fb3adc8a9ea6346e34fee79945f9046a len=528 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_short_formats_never_break()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (TG_OP='INSERT' OR OLD.format_contract IN ('mtt-v1','mtt-v2'))
     AND public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng')
  THEN
    NEW.synchronized_breaks := false;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_short_formats_never_break() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_short_formats_never_break() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_short_formats_never_break() TO service_role;
-- @@END fn_short_formats_never_break()

-- @@DOOR fn_tournaments_creation_guard()
-- @@PIN md5=f5dcb63005864b24bf422c6628cb169e len=1025 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournaments_creation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid int;
BEGIN
  IF public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN
    RETURN NEW; -- The earlier normalizer and final recorded-format constraint own NULL.
  END IF;
  IF COALESCE(NEW.max_players, 0) <= 0 THEN
    RAISE EXCEPTION
      'tournament guard: max_players must be positive (got %) - a tournament with no seats can never start',
      NEW.max_players
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payout_structure IS NOT NULL
     AND jsonb_typeof(NEW.payout_structure::jsonb) = 'array' THEN
    v_paid := jsonb_array_length(NEW.payout_structure::jsonb);
    IF v_paid > NEW.max_players THEN
      RAISE EXCEPTION
        'tournament guard: % paid places for % seats - more places than players who can enter',
        v_paid, NEW.max_players
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_tournaments_creation_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournaments_creation_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournaments_creation_guard() TO service_role;
-- @@END fn_tournaments_creation_guard()

-- @@DOOR fn_union_pnl_inventory_observe()
-- @@PIN md5=11c7c788d943a11375a15819e78873ba len=987 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_observe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior jsonb; following jsonb; frame public.union_pnl_transaction_frames;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'pnl_inventory_source_truncate_refused' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN prior:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN following:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 IF prior IS NOT DISTINCT FROM following THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(TG_TABLE_NAME,(COALESCE(following,prior)->>'id')::uuid,frame.observed_at,frame.transaction_id,TG_OP,prior,following);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_observe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_observe() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_inventory_observe()

-- @@DOOR fn_union_pnl_inventory_project(p_source text, p_row jsonb)
-- @@PIN md5=cc819d2476a0252326e7bdd4e72d468f len=1145 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_project(p_source text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE keys text[]; result jsonb;
BEGIN
 IF p_row IS NULL THEN RETURN NULL; END IF;
 keys:=CASE p_source
  WHEN 'union_clubs' THEN ARRAY['id','union_id','club_id','joined_at']
  WHEN 'tables' THEN ARRAY['id','club_id','union_id','tournament_id','is_private']
  WHEN 'table_seats' THEN ARRAY['id','table_id','user_id','club_id','occupancy_id','joined_at','left_at','stack']
  WHEN 'tournaments' THEN ARRAY['id','club_id','union_id','is_private','status','started_at','ended_at','prize_pool','bounty_pool','bounty_pool_paid']
  WHEN 'tournament_players' THEN ARRAY['id','tournament_id','user_id','club_id','status','registered_at','eliminated_at','prize','bounty_winnings','source_satellite_id']
  ELSE NULL END;
 IF keys IS NULL OR NOT p_row ?& keys THEN RAISE EXCEPTION 'pnl_inventory_source_contract_changed:%',p_source USING ERRCODE='55000'; END IF;
 SELECT jsonb_object_agg(k,p_row->k) INTO result FROM unnest(keys) k;
 RETURN result;
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_project(p_source text, p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_project(p_source text, p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_inventory_project(p_source text, p_row jsonb)

-- @@DOOR fn_union_pnl_original_frame()
-- @@PIN md5=9a6559774cc1ed4ed49b315a3428abdb len=1198 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_frame()
 RETURNS union_pnl_transaction_frames
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE frame public.union_pnl_transaction_frames; observed timestamptz; book timestamptz;
BEGIN
 SELECT * INTO frame FROM public.union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
 IF FOUND THEN RETURN frame; END IF;
 observed:=clock_timestamp(); book:=public.fn_union_week_start(observed);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
 observed:=clock_timestamp();
 IF public.fn_union_week_start(observed)<>book THEN
  book:=public.fn_union_week_start(observed);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  observed:=clock_timestamp();
  IF public.fn_union_week_start(observed)<>book THEN RAISE EXCEPTION 'pnl_frame_clock_crossed_twice' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),observed,book) RETURNING * INTO frame;
 RETURN frame;
END $function$;
ALTER FUNCTION public.fn_union_pnl_original_frame() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_frame() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_original_frame()

-- ---------------------------------------------------------------------------
-- THE TRIGGER SET ON public.tournaments, AS PRODUCTION CARRIES IT
-- ---------------------------------------------------------------------------
-- Twelve triggers production attaches that the historical base does not, in
-- production's own pg_get_triggerdef() text. Trigger NAMES decide firing
-- order, so a capture that installed the functions and not the triggers would
-- run the right code in the wrong order, or not at all.
--
-- Two of the twelve - trg_clear_seats_on_game_end and
-- trg_release_seats_on_tournament_finish - fire only on an UPDATE of status to
-- a terminal value, which no case in this fixture performs, and
-- union_pnl_original_inventory_no_truncate is the same function as
-- union_pnl_original_inventory on the same events. They are named here and NOT
-- installed, so the fixture never claims a trigger it did not stand up.
-- ---------------------------------------------------------------------------
CREATE TRIGGER a0_tournaments_dual_entry_capacity BEFORE INSERT OR UPDATE OF max_players, tournament_type, variant, satellite_target_id, satellite_target ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_normalize_new_mtt_capacity();
CREATE TRIGGER a1_tournaments_restart_source BEFORE INSERT OR DELETE OR UPDATE OF restart_source_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_restart_source();
CREATE TRIGGER a2_tournaments_new_satellite_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type, club_id, union_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_new_satellite_target();
CREATE TRIGGER satellite_feeds_only_a_deliverable_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_feeds_only_a_deliverable_target();
CREATE TRIGGER tournament_prize_math_contract BEFORE INSERT OR UPDATE OF payout_math_version, payout_unit_cents, club_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_prize_math_contract();
CREATE TRIGGER tournaments_mystery_creation_contract BEFORE INSERT OR UPDATE OF is_mystery_bounty, mystery_bounty_profile, mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, mystery_bounty_top_percent ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_mystery_creation_contract();
CREATE TRIGGER tournaments_new_mtt_blind_contract BEFORE INSERT OR UPDATE OF blind_structure, starting_chips, tournament_type, variant, max_players ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_new_mtt_blind_contract();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER zzzzzzz_tournaments_record_format BEFORE INSERT OR UPDATE OF format_contract, tournament_type, variant, max_players, min_players, table_size, satellite_target_id, satellite_target, club_id, union_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_format();

-- a0_tournament_manager_write_scope is attached in the historical base and
-- names trg_tournament_manager_write_scope, a function production does not
-- have at all (pg_proc lookup on 2026-09-20 returned zero rows, and no trigger
-- anywhere in production uses it). A retired refusal that still fires is a
-- fixture certifying a door the platform does not have, so it is dropped here,
-- with its reason, rather than left running quietly.
DROP TRIGGER a0_tournament_manager_write_scope ON public.tournaments;

-- ---------------------------------------------------------------------------
-- THE CAPTURE IS ITS OWN BINDING
-- ---------------------------------------------------------------------------
DO $capture$
DECLARE r record; v_oid oid; v_bad int := 0; v_seen int := 0; v_tg int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('fn_ca_blind_contract_number(p_value jsonb)','7463d39ac93442f5afca76e4ab4e99ba'),
    ('fn_ca_guard_new_satellite_target()','69247df72bfb68c7148c1a7f9ea4cfd7'),
    ('fn_ca_guard_tournament_format()','ff6655365bfdd99ae31dc897568f31e7'),
    ('fn_ca_guard_tournament_restart_source()','afe57e7d2b37feba95af19b41f9f2df5'),
    ('fn_ca_legacy_tournament_format(p_row jsonb)','a83410b4370de8d24e561709dd800ccd'),
    ('fn_ca_mtt_blind_contract(p_structure text, p_starting_chips integer)','4a13e21eba115284df84b1f8be2c83de'),
    ('fn_ca_normalize_new_mtt_capacity()','06cbd73a8011fac92e0c51b8d752b3da'),
    ('fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)','3933ec28773f12a1da9b02952ad99ed4'),
    ('fn_ca_tournament_format_identity(p_row jsonb)','49173db4a4cb01024d37e292d9471795'),
    ('fn_emit_managed_game_row_event()','9706ead97b5e6f495957bfd02a6eb282'),
    ('fn_guard_new_mtt_blind_contract()','aac67e5c89eaa564744a97a85b5f3fbb'),
    ('fn_guard_tournament_mystery_creation_contract()','07d896448e45728a89fc46eafc2a0eeb'),
    ('fn_guard_tournament_prize_math_contract()','9db38ea56f880456fdbbc29394c4cb27'),
    ('fn_mystery_bounty_creation_document(p_config jsonb)','0651f9abdf0f91cfb3378dee79d3e65c'),
    ('fn_poker_guard_arena_structure()','f17675dd0b647abda7b0b9d8772c9c0e'),
    ('fn_satellite_feeds_only_a_deliverable_target()','4251f65adfd51a29967a346af7ae98f1'),
    ('fn_satellite_target_is_deliverable(p_target_id uuid)','dbd45692f53316d0142c0034fe0a7245'),
    ('fn_short_formats_never_break()','fb3adc8a9ea6346e34fee79945f9046a'),
    ('fn_tournaments_creation_guard()','f5dcb63005864b24bf422c6628cb169e'),
    ('fn_union_pnl_inventory_observe()','11c7c788d943a11375a15819e78873ba'),
    ('fn_union_pnl_inventory_project(p_source text, p_row jsonb)','cc819d2476a0252326e7bdd4e72d468f'),
    ('fn_union_pnl_original_frame()','9a6559774cc1ed4ed49b315a3428abdb')
  ) AS t(ident, want)
  LOOP
    v_seen := v_seen + 1;
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = r.ident;
    IF v_oid IS NULL THEN
      RAISE WARNING 'captured lifecycle door % is not installed', r.ident; v_bad := v_bad + 1;
    ELSIF md5(pg_get_functiondef(v_oid)) <> r.want THEN
      RAISE WARNING 'captured lifecycle door % renders to % but its pin says %',
        r.ident, md5(pg_get_functiondef(v_oid)), r.want;
      v_bad := v_bad + 1;
    END IF;
    v_oid := NULL;
  END LOOP;
  IF v_seen <> 22 THEN
    RAISE EXCEPTION 'the lifecycle capture declares % doors but this file carries %', 22, v_seen;
  END IF;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% of % captured Diamond tournament lifecycle doors do not match their pins', v_bad, v_seen;
  END IF;
  -- Every trigger function now attached to public.tournaments must be one
  -- production attaches, and every production INSERT trigger this fixture
  -- installed must be attached here. A retired refusal must not survive.
  SELECT count(*) INTO v_tg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.oid = 'public.tournaments'::regclass AND NOT t.tgisinternal;
  IF v_tg <> 57 THEN
    RAISE EXCEPTION 'public.tournaments carries % triggers; this capture stands up 57 of the 60 production carried on 2026-09-20, and names the other three', v_tg;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.oid = 'public.tournaments'::regclass
                AND t.tgname = 'a0_tournament_manager_write_scope') THEN
    RAISE EXCEPTION 'a retired trigger is still attached to public.tournaments';
  END IF;
  RAISE NOTICE 'PASS: all % captured Diamond tournament lifecycle doors match their installed pins', v_seen;
  RAISE NOTICE 'PASS: public.tournaments carries % of production''s 60 trigger definitions; the three not installed are named in this file', v_tg;
END $capture$;
