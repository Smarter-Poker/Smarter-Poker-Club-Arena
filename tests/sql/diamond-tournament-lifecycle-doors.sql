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
-- On 2026-09-21 four pure pricing doors joined them for the Phase 9
-- cross-format conservation cases - the prize ladder at both units and the
-- final-field payout generator - transported from production by a read-only
-- pg_get_functiondef(). The file now carries twenty-six.
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
-- @@PIN md5=8e0149116be545a6b4ccc0bfe690c372 len=4576 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_new_satellite_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_abi text; v_target uuid:=COALESCE(NEW.satellite_target_id,NEW.satellite_target);
 v_target_row public.tournaments%ROWTYPE; v_supported boolean;
 v_source_diamond boolean;  -- DIAMOND PHASE 9
BEGIN
 IF TG_OP='UPDATE' AND
   (NEW.satellite_target_id,NEW.satellite_target,NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,
    NEW.is_premium_spin,NEW.variant,NEW.tournament_type,NEW.club_id,NEW.union_id)
   IS NOT DISTINCT FROM
   (OLD.satellite_target_id,OLD.satellite_target,OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,
    OLD.is_premium_spin,OLD.variant,OLD.tournament_type,OLD.club_id,OLD.union_id) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 -- DIAMOND PHASE 9: ASSETS NEVER CROSS, under every admission contract. A
 -- satellite and its target are the same asset or the row is refused by name.
 v_source_diamond:=EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
 IF v_target IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournaments x WHERE x.id=v_target) THEN
  IF v_source_diamond AND NOT public.fn_poker_diamond_tournament(v_target) THEN
   RAISE EXCEPTION 'SATELLITE_DIAMOND_SOURCE_CANNOT_FEED_A_CHIP_TARGET' USING ERRCODE='22023';
  ELSIF NOT v_source_diamond AND public.fn_poker_diamond_tournament(v_target) THEN
   RAISE EXCEPTION 'SATELLITE_CHIP_SOURCE_CANNOT_FEED_A_DIAMOND_TARGET' USING ERRCODE='22023';
  END IF;
 END IF;
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
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty');
 -- DIAMOND PHASE 9: a Diamond row is supported like a chip row; the asset rule
 -- above decides which targets it may feed, and a target fed by a live
 -- satellite may not change its asset.
 IF TG_OP='UPDATE' AND (NOT v_supported OR v_target IS NOT NULL
      OR v_source_diamond IS DISTINCT FROM
         EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=OLD.club_id AND c.asset='diamonds')
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
  IF NOT FOUND OR NOT (CASE WHEN v_source_diamond  -- DIAMOND PHASE 9
       THEN public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target)
       ELSE public.fn_ca_satellite_target_accepts_new_feeder(v_target) END)
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
-- THE PRIZE LADDER, ADDED 2026-09-21 FOR THE PHASE 9 CONSERVATION CASES
-- ---------------------------------------------------------------------------
-- The terminal prices every paid place through fn_ca_prize_ladder_versioned
-- (version 1 is fn_ca_prize_ladder, version 2 is fn_ca_prize_ladder_v2), and
-- entry close regenerates an event's committed ladder from its final field
-- with fn_ca_payout_structure. All four are pure functions. The rounding case
-- in diamond-tournament-lifecycle-cases.sql reaches all four, so they are
-- captured first, the same md5-pinned way ("If a future case reaches either,
-- capture it first"). All four were transported from production on
-- 2026-09-21 by a read-only pg_get_functiondef().
-- ---------------------------------------------------------------------------
-- @@DOOR fn_ca_prize_ladder(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)
-- @@PIN md5=55d6a74569415d5d51ffac0d5704361f len=2618 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_prize_ladder(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer DEFAULT 1)
 RETURNS TABLE(place integer, cents bigint)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_unit bigint;
  v_total_bp bigint;
  v_count integer;
  v_places integer[];
  v_bps bigint[];
  v_remaining bigint;
  v_share bigint;
  i integer;
BEGIN
  v_unit := CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                 THEN p_unit_cents::bigint ELSE 1 END;
  IF p_pool_cents IS NULL OR p_pool_cents <= 0
     OR p_entries IS NULL OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_entries) = 0 THEN
    RETURN;
  END IF;

  SELECT array_agg((e->>'place')::integer ORDER BY (e->>'place')::integer),
         array_agg((e->>'bp')::bigint ORDER BY (e->>'place')::integer),
         COALESCE(sum((e->>'bp')::bigint), 0),
         count(*)
    INTO v_places, v_bps, v_total_bp, v_count
    FROM jsonb_array_elements(p_entries) e;
  IF v_total_bp <= 0 OR v_count = 0 THEN RETURN; END IF;

  -- THE SHORT FIELD. A pool holding fewer units than there are places pays the
  -- places it CAN, one unit each from the top. Left alone, every share below
  -- rounds to zero and the last place absorbs the pool as its "residual": the
  -- whole prize to the last finisher and nothing to the first. An indivisible
  -- unit cannot be split nine ways, and every other answer pays somebody more
  -- than the player who beat them.
  IF v_unit > 1 AND (p_pool_cents / v_unit) < v_count THEN
    FOR i IN 1..v_count LOOP
      place := v_places[i];
      cents := CASE WHEN i <= (p_pool_cents / v_unit) THEN v_unit ELSE 0 END;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Spend down in place order; the LAST paid place takes whatever remains, so
  -- the places sum to the pool exactly rather than by hoping the rounding
  -- cancels, and the adjustment lands on the smallest prize.
  v_remaining := p_pool_cents;
  FOR i IN 1..v_count LOOP
    IF i = v_count THEN
      v_share := v_remaining;
    ELSE
      v_share := LEAST(v_remaining,
        (round(round((p_pool_cents::numeric * v_bps[i]::numeric) / v_total_bp::numeric)
               / v_unit::numeric) * v_unit)::bigint);
    END IF;
    v_share := GREATEST(v_share, 0);
    v_remaining := v_remaining - v_share;
    place := v_places[i];
    cents := v_share;
    RETURN NEXT;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'prize ladder left % cents undistributed', v_remaining
      USING ERRCODE = '23514';
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_prize_ladder(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_prize_ladder(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_prize_ladder(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)

-- @@DOOR fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)
-- @@PIN md5=6a5ce2617cee7606b2151aea29d865c0 len=2911 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)
 RETURNS TABLE(place integer, cents bigint)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entry jsonb;
  v_place numeric;
  v_bp numeric;
  v_total numeric;
  v_units bigint;
BEGIN
  IF p_pool_cents IS NULL OR p_pool_cents<0
     OR p_unit_cents IS NULL OR p_unit_cents<1 THEN
    RAISE EXCEPTION 'Prize pool must contain whole payout units' USING ERRCODE='22023';
  END IF;
  IF p_pool_cents%p_unit_cents<>0 THEN
    RAISE EXCEPTION 'Prize pool must contain whole payout units' USING ERRCODE='22023';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries)<>'array'
     OR jsonb_array_length(p_entries)=0 THEN
    RAISE EXCEPTION 'Version 2 requires a canonical payout ladder' USING ERRCODE='22023';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    IF jsonb_typeof(v_entry)<>'object'
       OR jsonb_typeof(v_entry->'place') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_entry->'bp') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Canonical payout entries must contain numeric places and basis points'
        USING ERRCODE='22023';
    END IF;
    v_place:=(v_entry->>'place')::numeric;
    v_bp:=(v_entry->>'bp')::numeric;
    IF v_place<1 OR v_place>2147483647 OR v_place<>trunc(v_place)
       OR v_bp<=0 OR v_bp>10000 OR v_bp<>trunc(v_bp) THEN
      RAISE EXCEPTION 'Invalid canonical payout place or basis points' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF EXISTS (
    WITH entries AS (
      SELECT (e->>'place')::integer AS finish,(e->>'bp')::bigint AS bp
      FROM jsonb_array_elements(p_entries) e
    ), ranked AS (
      SELECT i.*,row_number() OVER(ORDER BY i.finish) AS ordinal,
        lag(i.bp) OVER(ORDER BY i.finish) AS prior_bp FROM entries i
    ) SELECT 1 FROM ranked r WHERE r.finish<>r.ordinal OR r.bp>r.prior_bp
  ) THEN
    RAISE EXCEPTION 'Version 2 requires contiguous places and nonincreasing percentages'
      USING ERRCODE='22023';
  END IF;
  IF p_pool_cents=0 THEN RETURN; END IF;
  SELECT sum((e->>'bp')::numeric) INTO v_total FROM jsonb_array_elements(p_entries) e;
  v_units:=p_pool_cents/p_unit_cents;
  RETURN QUERY
    WITH quotas AS (
      SELECT (e->>'place')::integer AS finish,
        floor(v_units::numeric*(e->>'bp')::numeric/v_total) AS units,
        mod(v_units::numeric*(e->>'bp')::numeric,v_total) AS remainder
      FROM jsonb_array_elements(p_entries) e
    ), ordered AS (
      SELECT q.*,row_number() OVER(ORDER BY q.remainder DESC,q.finish) AS priority
      FROM quotas q
    ), residual AS (SELECT v_units-sum(q.units) AS units FROM quotas q)
    SELECT q.finish,((q.units+CASE WHEN q.priority<=r.units THEN 1 ELSE 0 END)*p_unit_cents)::bigint
    FROM ordered q CROSS JOIN residual r ORDER BY q.finish;
END;
$function$;
ALTER FUNCTION public.fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer) TO service_role;
-- @@END fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)

-- @@DOOR fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer)
-- @@PIN md5=cb73955cbc90b47b36fd818631691303 len=668 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer)
 RETURNS TABLE(place integer, cents bigint)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_version=1 THEN
    RETURN QUERY SELECT l.place,l.cents FROM public.fn_ca_prize_ladder(p_pool_cents,p_entries,p_unit_cents) l;
  ELSIF p_version=2 THEN
    RETURN QUERY SELECT l.place,l.cents FROM public.fn_ca_prize_ladder_v2(p_pool_cents,p_entries,p_unit_cents) l;
  ELSE
    RAISE EXCEPTION 'Unsupported tournament payout math version' USING ERRCODE='22023';
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer) TO service_role;
-- @@END fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer)

-- @@DOOR fn_ca_payout_structure(p_entrants integer, p_percent integer)
-- @@PIN md5=320527cd5203efab28b465d2b56ca567 len=1594 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_payout_structure(p_entrants integer, p_percent integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_places int;
  v_pct    numeric;
  v_out    jsonb;
BEGIN
  v_pct := CASE WHEN p_percent IN (10,15,20) THEN p_percent ELSE 10 END;

  -- at least one place, never more places than players
  v_places := GREATEST(1, LEAST(COALESCE(p_entrants,0),
                                ceil(COALESCE(p_entrants,0) * v_pct / 100.0)::int));
  IF COALESCE(p_entrants,0) <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH w AS (
    SELECT i AS place, 1.0 / power(i, 0.8) AS weight
      FROM generate_series(1, v_places) i
  ), n AS (
    SELECT place, weight, 100.0 * weight / SUM(weight) OVER () AS exact
      FROM w
  ), f AS (
    SELECT place, exact,
           floor(exact * 100) / 100 AS floored,
           (exact * 100) - floor(exact * 100) AS frac
      FROM n
  ), r AS (
    -- largest remainder: hand the leftover cents to the biggest fractions, so
    -- the structure sums to exactly 100.00 for any field size
    SELECT place, floored,
           row_number() OVER (ORDER BY frac DESC, place ASC) AS rk,
           round((100.0 - SUM(floored) OVER ()) * 100)::int AS cents_left
      FROM f
  )
  SELECT jsonb_agg(
           jsonb_build_object('place', place,
                              'percentage', floored + CASE WHEN rk <= cents_left THEN 0.01 ELSE 0 END)
           ORDER BY place)
    INTO v_out
    FROM r;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$function$;
ALTER FUNCTION public.fn_ca_payout_structure(p_entrants integer, p_percent integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_payout_structure(p_entrants integer, p_percent integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_payout_structure(p_entrants integer, p_percent integer) TO authenticated, service_role;
-- @@END fn_ca_payout_structure(p_entrants integer, p_percent integer)

-- @@DOOR fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid)
-- @@PIN md5=29c40f922b42b732f292fc8611efe114 len=907 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid)
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
   AND public.fn_poker_diamond_tournament(t.id) IS TRUE
   FROM public.tournaments t WHERE t.id=p_target_id),false);
$function$;
ALTER FUNCTION public.fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid)

-- @@DOOR fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid)
-- @@PIN md5=0e3becd7819a0f58b99cfd6cc2750b5a len=8786 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text; v_total numeric; v_buy_in bigint; v_chips numeric; v_game text; v_name text; v_start timestamptz;
  v_blinds jsonb; v_tiers jsonb; v_contract jsonb; v_manifest jsonb; v_sha text;
  v_source public.poker_diamond_spin_reserve_source%ROWTYPE; v_held numeric;
  v_worst bigint; v_cover bigint; v_id uuid; v_table uuid; v_sb numeric; v_bb numeric;
BEGIN
  -- Only the creation door reaches this, after it proved a signed-in platform
  -- operator and found the arena; both are proved again here.
  IF v_actor IS NULL OR NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  IF p_arena IS NULL OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=p_arena
       AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL) THEN
    RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;

  -- The chip seat-first door refuses a configured multiplier: it is drawn.
  IF p_config ?| ARRAY['spinMultiplier','spinLockedTiers','spin_multiplier','spin_locked_tiers'] THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_is_drawn_not_configured' USING ERRCODE='22023';
  END IF;
  -- And it refuses a key it would not keep. A Spin is priced by its buy-in,
  -- fielded by three seats and paid by its drawn ladder: a fee, a bounty, a
  -- rebuy, a guarantee or a ladder of its own means nothing here.
  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF v_key NOT IN ('type','name','gameVariant','buyIn','startingStack','blindStructure','spinTiers',
                     'startTime','maxPlayers','minPlayers','tableSize') THEN
      RAISE EXCEPTION 'diamond_spin_rejects_a_non_spin_configuration: %', v_key USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_config ? 'maxPlayers' AND (p_config->>'maxPlayers') IS DISTINCT FROM '3')
     OR (p_config ? 'minPlayers' AND (p_config->>'minPlayers') IS DISTINCT FROM '3')
     OR (p_config ? 'tableSize' AND (p_config->>'tableSize') IS DISTINCT FROM '3') THEN
    RAISE EXCEPTION 'diamond_spin_is_three_handed' USING ERRCODE='22023';
  END IF;
  -- A Spin runs only on NLH, PLO4, PLO5 or PLO6: the chip creation door's rule
  -- (unsupported_spin_variant) and the creation forms' (tournamentCreationRules).
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6') THEN
    RAISE EXCEPTION 'diamond_spin_unsupported_variant' USING ERRCODE='22023';
  END IF;
  -- The buy-in is the whole charge; no fee rides on top. The table's
  -- expectation is where the edge lives (E[m] = 3 x (1 - rake)).
  BEGIN
    v_total := (p_config->>'buyIn')::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_total := NULL;
  END;
  IF v_total IS NULL OR v_total <> trunc(v_total) OR v_total < 1 OR v_total > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_buy_in := v_total::bigint;
  -- The stack is part of the contract the draw receipt carries; the chip
  -- seat-first door requires it, and so does this one.
  BEGIN
    v_chips := (p_config->>'startingStack')::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_chips := NULL;
  END;
  IF v_chips IS NULL OR v_chips <> trunc(v_chips) OR v_chips < 1 OR v_chips > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023';
  END IF;
  v_blinds := p_config->'blindStructure';
  -- The multiplier table staff configured, or the published one (spin_tier_spec
  -- with the estate ladders), which is the approved chip table. Either is held
  -- to the same rule at this buy-in; none is invented here.
  v_tiers := p_config->'spinTiers';
  IF v_tiers IS NULL OR jsonb_typeof(v_tiers) = 'null' THEN
    SELECT jsonb_agg(jsonb_build_object('multiplier', s.multiplier, 'freq', s.freq,
                                        'reserveThresholdX', s.reserve_threshold_x) ORDER BY s.multiplier)
      INTO v_tiers FROM public.spin_tier_spec s;
  END IF;
  v_contract := public.fn_poker_diamond_spin_contract(v_buy_in, v_chips::integer, v_tiers, v_blinds);
  v_manifest := v_contract->'manifest';
  v_worst := (v_contract->>'worst_excess')::bigint;
  v_cover := (v_contract->>'required_cover')::bigint;

  -- The reserve: an authorized source, the cap it was authorized with, and a
  -- balance that covers the whole table now (the draw proves the cover again).
  SELECT * INTO v_source FROM public.poker_diamond_spin_reserve_source WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_spin_reserve_source_not_authorized' USING ERRCODE='55000';
  END IF;
  IF v_worst > v_source.max_underwrite_per_spin THEN
    RAISE EXCEPTION 'diamond_spin_reserve_over_its_authorized_cap: this table can ask the source for % Diamonds at a buy-in of %; % are authorized per Spin',
      v_worst, v_buy_in, v_source.max_underwrite_per_spin USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(h.balance, 0) INTO v_held FROM public.ca_diamond_house h WHERE h.id = 1;
  IF COALESCE(v_held, 0) < v_cover THEN
    RAISE EXCEPTION 'diamond_spin_reserve_cannot_cover_the_table: the source holds %, the table needs % at a buy-in of %',
      COALESCE(v_held, 0), v_cover, v_buy_in USING ERRCODE='55000';
  END IF;

  v_name := COALESCE(NULLIF(btrim(p_config->>'name'),''),'Diamond Spin');
  BEGIN
    v_start := COALESCE((p_config->>'startTime')::timestamptz, now() + interval '1 minute');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_start_time' USING ERRCODE='22023';
  END;
  v_sb := (v_blinds->0->>'smallBlind')::numeric;
  v_bb := (v_blinds->0->>'bigBlind')::numeric;

  -- The listing, as the chip seat-first creator writes a Spin: three seats,
  -- no fee, no late registration, undrawn (no multiplier, no pool), and the
  -- smallest ladder until the draw stamps the drawn one.
  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    is_rebuy, is_reentry, add_on_available, free_buy, is_private, action_time_seconds)
  VALUES (
    p_arena, NULL, v_name, v_game, 'spin', 'SPIN',
    v_buy_in, 0, 0, v_chips::integer, 3, 3, 3,
    0, 'REGISTERING', v_blinds::text, '[{"place":1,"percentage":100}]', v_start,
    0, 0, false, false, false, 0,
    false, false, false, false, false, 15)
  RETURNING id INTO v_id;

  v_sha := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  INSERT INTO public.poker_diamond_spin_contracts
    (tournament_id, buy_in, starting_chips, rake_rate, rule_manifest, rule_sha256, worst_excess, required_cover, created_by)
  VALUES (v_id, v_buy_in, v_chips::integer, (v_manifest->>'rake_rate')::numeric, v_manifest, v_sha, v_worst, v_cover, v_actor);

  -- Its joinable table, in the same transaction, as the chip creator opens it.
  INSERT INTO public.tables (
    club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status)
  VALUES (
    p_arena, v_id, v_name, 'tournament', lower(v_game), v_sb::text || '/' || v_bb::text,
    v_sb, v_bb, 0, 0, 3, 0, 'waiting')
  RETURNING id INTO v_table;

  -- The row this door wrote must be one the money path prices in Diamonds and
  -- the seat door sells as a Spin.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id)
     OR public.fn_ca_tournament_recorded_format(v_id) IS DISTINCT FROM 'spin-v1'
     OR NOT public.fn_ca_tournament_recorded_seat_first(v_id, false) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'table_id',v_table,
    'buy_in_amount',v_buy_in,'buy_in_fee',0,'total',v_buy_in,'bounty_amount',0,'is_mystery_bounty',false,
    'asset','diamonds','format','spin','rule_sha256',v_sha,'multiplier_table',v_manifest->'tiers',
    'max_multiplier',(SELECT max((x->>'multiplier')::numeric) FROM jsonb_array_elements(v_manifest->'tiers') x),
    'worst_excess',v_worst,'required_cover',v_cover);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid)

-- @@DOOR fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb)
-- @@PIN md5=35a90ec487ba000e87ceec971998ceca len=9065 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rake numeric; v_b record; v_c jsonb; v_tier jsonb; v_place record; v_key text;
  v_m numeric; v_f numeric; v_thr numeric; v_pool numeric; v_share numeric; v_pct numeric;
  v_ladder jsonb; v_estate jsonb; v_tiers jsonb := '[]'::jsonb;
  v_freq numeric := 0; v_weight numeric := 0; v_worst numeric := 0; v_cover numeric := 0;
BEGIN
  IF p_buy_in IS NULL OR p_buy_in < 1 OR p_buy_in > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  IF p_starting_chips IS NULL OR p_starting_chips < 1 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023';
  END IF;

  -- The blind ladder, under the chip draw authority's manifest rule: twelve
  -- levels in order, no ante, the twelfth carrying the continuation that
  -- prices every level after it (the engine refuses a receipt without it).
  IF jsonb_typeof(p_blinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_blinds) <> 12 THEN
    RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
  END IF;
  FOR v_b IN SELECT b.value, b.ordinality FROM jsonb_array_elements(p_blinds) WITH ORDINALITY b ORDER BY b.ordinality LOOP
    IF jsonb_typeof(v_b.value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_b.value->'level') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'smallBlind') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'bigBlind') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'duration') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_b.value->'ante') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
    END IF;
    IF (v_b.value->>'level')::numeric <> v_b.ordinality
       OR (v_b.value->>'smallBlind')::numeric <= 0
       OR (v_b.value->>'bigBlind')::numeric < (v_b.value->>'smallBlind')::numeric
       OR (v_b.value->>'duration')::numeric <= 0
       OR (v_b.value->>'ante')::numeric <> 0 THEN
      RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
    END IF;
  END LOOP;
  v_c := p_blinds->11->'spinContinuation';
  IF jsonb_typeof(v_c) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_c->'version') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'anchorLevel') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'anchorBigBlind') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'growth') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_c->'roundBigTo') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
  END IF;
  IF (v_c->>'version')::numeric <> 1
     OR (v_c->>'anchorLevel')::numeric <= 0 OR (v_c->>'anchorLevel')::numeric <> trunc((v_c->>'anchorLevel')::numeric)
     OR (v_c->>'anchorBigBlind')::numeric <= 0
     OR (v_c->>'growth')::numeric <= 1
     OR (v_c->>'roundBigTo')::numeric <= 0 THEN
    RAISE EXCEPTION 'diamond_spin_requires_its_blind_ladder' USING ERRCODE='22023';
  END IF;

  -- The multiplier table, tier by tier, under the chip draw authority's rules.
  IF jsonb_typeof(p_tiers) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tiers) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
  END IF;
  v_rake := public.fn_spin_rake_rate(p_buy_in);
  FOR v_tier IN SELECT t.value FROM jsonb_array_elements(p_tiers) WITH ORDINALITY t ORDER BY t.ordinality LOOP
    IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_tier->'multiplier') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_tier->'freq') IS DISTINCT FROM 'number'
       OR jsonb_typeof(COALESCE(v_tier->'reserveThresholdX', '0'::jsonb)) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_tier) LOOP
      IF v_key NOT IN ('multiplier','freq','reserveThresholdX','payoutStructure') THEN
        RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid: a tier does not take %', v_key USING ERRCODE='22023';
      END IF;
    END LOOP;
    v_m := (v_tier->>'multiplier')::numeric;
    v_f := (v_tier->>'freq')::numeric;
    v_thr := COALESCE((v_tier->>'reserveThresholdX')::numeric, 0);
    IF v_m <= 0 OR v_f <= 0 OR v_thr < 0 THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    -- The ladder: the tier's own, or the estate's for this multiplier. The
    -- terminal prices a multiplier the estate knows from the estate's ladder
    -- (fn_ca_tournament_place_amounts), so a tier may not advertise another.
    v_estate := NULL;
    SELECT l.structure INTO v_estate FROM public.spin_payout_ladder l WHERE l.multiplier = v_m;
    v_ladder := COALESCE(v_tier->'payoutStructure', v_estate);
    IF v_ladder IS NULL THEN
      RAISE EXCEPTION 'diamond_spin_tier_needs_a_payout_ladder: %x has no ladder of its own and none in spin_payout_ladder', v_m
        USING ERRCODE='22023';
    END IF;
    IF v_estate IS NOT NULL AND v_ladder IS DISTINCT FROM v_estate THEN
      RAISE EXCEPTION 'diamond_spin_ladder_is_not_the_estate_ladder: %x pays %, the estate pays %', v_m, v_ladder, v_estate
        USING ERRCODE='22023';
    END IF;
    IF jsonb_typeof(v_ladder) IS DISTINCT FROM 'array' OR jsonb_array_length(v_ladder) NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    -- THE WHOLE-DIAMOND RULE: the pool, and every place of its ladder, is a
    -- whole number of Diamonds at this buy-in, or the tier cannot be honoured.
    v_pool := v_m * p_buy_in;
    IF v_pool <> trunc(v_pool) OR v_pool < 1 THEN
      RAISE EXCEPTION 'diamond_spin_tier_not_whole_at_the_buy_in: %x at a buy-in of % Diamonds is a prize pool of % Diamonds',
        v_m, p_buy_in, v_pool USING ERRCODE='22023';
    END IF;
    v_pct := 0;
    FOR v_place IN SELECT p.value, p.ordinality FROM jsonb_array_elements(v_ladder) WITH ORDINALITY p ORDER BY p.ordinality LOOP
      IF jsonb_typeof(v_place.value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_place.value->'place') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_place.value->'percentage') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
      END IF;
      IF (v_place.value->>'place')::numeric <> v_place.ordinality
         OR (v_place.value->>'percentage')::numeric <= 0 THEN
        RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
      END IF;
      v_share := v_pool * (v_place.value->>'percentage')::numeric / 100;
      IF v_share <> trunc(v_share) OR v_share < 1 THEN
        RAISE EXCEPTION 'diamond_spin_tier_not_whole_at_the_buy_in: %x place % takes % of a % Diamond pool',
          v_m, v_place.ordinality, v_share, v_pool USING ERRCODE='22023';
      END IF;
      v_pct := v_pct + (v_place.value->>'percentage')::numeric;
    END LOOP;
    IF v_pct <> 100 THEN
      RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid' USING ERRCODE='22023';
    END IF;
    v_freq := v_freq + v_f;
    v_weight := v_weight + v_f * v_m;
    -- What the source can be asked for: the pool above the three entries.
    -- What it must hold for the tier to be drawable: that, or the tier's
    -- reserve threshold times its pool (the chip reserve gate, with this
    -- event's own buy-in as its stake), whichever is more.
    v_worst := GREATEST(v_worst, v_pool - 3 * p_buy_in);
    v_cover := GREATEST(v_cover, v_pool - 3 * p_buy_in, CASE WHEN v_thr > 0 THEN ceil(v_pool * v_thr) ELSE 0 END);
    v_tiers := v_tiers || jsonb_build_array(jsonb_build_object(
      'multiplier', v_m, 'freq', v_f, 'reserveThresholdX', v_thr,
      'blind_structure', p_blinds, 'payout_structure', v_ladder));
  END LOOP;
  IF (SELECT count(DISTINCT (x->>'multiplier')::numeric) FROM jsonb_array_elements(v_tiers) x) <> jsonb_array_length(v_tiers) THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid: a multiplier appears twice' USING ERRCODE='22023';
  END IF;
  -- The chip authority's one pricing rule: E[multiplier] = seats x (1 - rake), exactly.
  IF v_weight <> v_freq * 3 * (1 - v_rake) THEN
    RAISE EXCEPTION 'diamond_spin_multiplier_table_invalid: the table expects %x of three seats, the approved edge prices %x',
      round(v_weight / v_freq, 6), 3 * (1 - v_rake) USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object(
    'manifest', jsonb_build_object('version', 1, 'asset', 'diamonds', 'unit_cents', 100,
      'buy_in', p_buy_in, 'seats', 3, 'starting_chips', p_starting_chips, 'rake_rate', v_rake, 'tiers', v_tiers),
    'worst_excess', v_worst::bigint, 'required_cover', v_cover::bigint);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb)

-- @@DOOR fn_tournaments_bagged_status_door()
-- @@PIN md5=0b794e7f3f5c35c762bbea29eab8afbc len=1656 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournaments_bagged_status_door()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'BAGGED' THEN
      RAISE EXCEPTION 'TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG: a tournament is never created bagged'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'BAGGED' THEN
    IF OLD.status IS DISTINCT FROM 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_stage_transitions x
          WHERE x.tournament_id = NEW.id
            AND x.kind = 'bag'
            AND x.transaction_id = pg_current_xact_id()
            AND current_setting('app.atomic_stage_bag', true) = NEW.id::text || ':' || x.id::text) THEN
      RAISE EXCEPTION 'TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG: % to BAGGED belongs to the stage bag RPC', OLD.status
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'BAGGED' THEN
    IF NEW.status IS DISTINCT FROM 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_stage_resume_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_stage_resume', true) = NEW.id::text || ':' || r.resume_id::text) THEN
      RAISE EXCEPTION 'TOURNAMENT_BAGGED_LEAVES_ONLY_BY_STAGE_RESUME: BAGGED to % refused', NEW.status
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_tournaments_bagged_status_door() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournaments_bagged_status_door() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_tournaments_bagged_status_door()

-- @@DOOR fn_tournament_record_acceptance()
-- @@PIN md5=e2b1faebf4b5d58e1b84c99cb8820681 len=1053 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_record_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.accepted_event_operations
    (event_kind, event_id, parent_event_id, club_id, union_id, accepted_at, accepted_by,
     authorization_basis, capability_versions, concluded_at, conclusion)
  VALUES
    ('tournament', NEW.id, NEW.parent_tournament_id, NEW.club_id, NEW.union_id, now(), auth.uid(),
     '{"operator_access":"legacy_free","recorded_by":"acceptance_trigger"}'::jsonb,
     COALESCE((SELECT jsonb_object_agg(c.capability_id, c.rule_version)
                 FROM public.platform_capabilities c
                WHERE c.readiness IN ('deployed','production_verified')), '{}'::jsonb),
     CASE WHEN NEW.status IN ('COMPLETED','CANCELLED') THEN now() END,
     CASE NEW.status WHEN 'COMPLETED' THEN 'completed' WHEN 'CANCELLED' THEN 'cancelled' END)
  ON CONFLICT (event_kind, event_id) DO NOTHING;
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_tournament_record_acceptance() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_record_acceptance() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_tournament_record_acceptance()

-- @@DOOR fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean)
-- @@PIN md5=00e225cc67cf595af35831e981106d93 len=897 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text; v_cap integer; v_status text;
BEGIN
 SELECT t.format_contract,t.max_players,upper(COALESCE(t.status::text,''))
 INTO v_format,v_cap,v_status FROM public.tournaments t WHERE t.id=p_tournament_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
 END IF;
 IF p_terminal_cleanup IS TRUE AND v_format IS NULL
    AND v_status IN ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN false;
 END IF;
 v_format:=public.fn_ca_tournament_recorded_format(p_tournament_id);
 RETURN v_format IN ('spin-v1','seat-first-satellite-v1')
     OR (v_format='sng-v1' AND v_cap BETWEEN 1 AND 2);
END $function$;
ALTER FUNCTION public.fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean)

-- @@DOOR fn_platform_frozen()
-- @@PIN md5=ec683805e052fceeae74789e82dce4cc len=1166 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;
ALTER FUNCTION public.fn_platform_frozen() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_platform_frozen() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO anon, authenticated, service_role;
-- @@END fn_platform_frozen()

-- @@DOOR fn_tournament_management_readiness_for_row(p_row jsonb)
-- @@PIN md5=f8a6070eb5847c8922e09f28566bfa9e len=8623 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := NULLIF(p_row ->> 'id', '')::uuid;
  v_club uuid := NULLIF(p_row ->> 'club_id', '')::uuid;
  v_row_union uuid := NULLIF(p_row ->> 'union_id', '')::uuid;
  v_union uuid;
  v_private boolean := COALESCE((p_row ->> 'is_private')::boolean, false);
  v_enforce boolean;
  v_floor numeric;
  v_bank numeric;
  v_bank_type text;
  v_exposure numeric;
  v_guaranteed numeric := COALESCE(NULLIF(p_row ->> 'guaranteed_prize', '')::numeric, 0);
  v_pool numeric := COALESCE(NULLIF(p_row ->> 'prize_pool', '')::numeric, 0);
  v_effective_guarantee numeric;
  v_seat_guarantee numeric := 0;
  v_required numeric;
  v_short numeric;
  v_locked boolean;
  v_complete boolean;
  v_status text := upper(COALESCE(p_row ->> 'status', ''));
  v_variant text := lower(COALESCE(p_row ->> 'variant', ''));
  v_tournament_type text := upper(COALESCE(p_row ->> 'tournament_type', ''));
  v_target uuid := COALESCE(
    NULLIF(p_row ->> 'satellite_target_id', ''),
    NULLIF(p_row ->> 'satellite_target', '')
  )::uuid;
  v_satellite_seats integer := COALESCE(
    NULLIF(p_row ->> 'satellite_seats', '')::integer,
    0
  );
  v_is_satellite boolean := v_variant = 'satellite'
    OR v_tournament_type = 'SATELLITE'
    OR v_target IS NOT NULL;
  v_target_found boolean := false;
  v_blinds jsonb;
  v_payouts jsonb;
BEGIN
  IF v_id IS NULL OR v_club IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  SELECT COALESCE(c.guarantee_enforcement_enabled, true),
         COALESCE(c.guarantee_treasury_floor, 0)
    INTO v_enforce, v_floor
    FROM public.clubs c
   WHERE c.id = v_club;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  v_union := CASE WHEN v_private THEN NULL ELSE v_row_union END;

  IF v_is_satellite AND v_satellite_seats > 0 AND v_target IS NOT NULL THEN
    SELECT round(
             (COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0))
             * v_satellite_seats,
             2
           )
      INTO v_seat_guarantee
      FROM public.tournaments t
     WHERE t.id = v_target;
    v_target_found := FOUND;
    v_seat_guarantee := COALESCE(v_seat_guarantee, 0);
  END IF;

  v_effective_guarantee := greatest(v_guaranteed, v_seat_guarantee);

  IF v_union IS NOT NULL THEN
    v_bank_type := 'union';
    v_floor := 0;
    SELECT COALESCE(uw.chip_balance, 0)
      INTO v_bank
      FROM public.union_wallets uw
     WHERE uw.union_id = v_union;
    v_bank := COALESCE(v_bank, 0);

    SELECT COALESCE(sum(greatest(
             greatest(
               COALESCE(t.guaranteed_prize, 0),
               CASE
                 WHEN COALESCE(t.satellite_seats, 0) > 0
                      AND (
                        lower(COALESCE(t.variant, '')) = 'satellite'
                        OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                        OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                      )
                 THEN COALESCE(
                   (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 ELSE 0
               END
             ) - COALESCE(t.prize_pool, 0),
             0
           )), 0)
      INTO v_exposure
      FROM public.tournaments t
      LEFT JOIN public.tournaments target
        ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
     WHERE t.union_id = v_union
       AND NOT COALESCE(t.is_private, false)
       AND t.id <> v_id
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  ELSE
    v_bank_type := 'club';
    SELECT COALESCE(c.chip_treasury, 0)
      INTO v_bank
      FROM public.clubs c
     WHERE c.id = v_club;
    v_bank := COALESCE(v_bank, 0);

    SELECT COALESCE(sum(greatest(
             greatest(
               COALESCE(t.guaranteed_prize, 0),
               CASE
                 WHEN COALESCE(t.satellite_seats, 0) > 0
                      AND (
                        lower(COALESCE(t.variant, '')) = 'satellite'
                        OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                        OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                      )
                 THEN COALESCE(
                   (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 ELSE 0
               END
             ) - COALESCE(t.prize_pool, 0),
             0
           )), 0)
      INTO v_exposure
      FROM public.tournaments t
      LEFT JOIN public.tournaments target
        ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
     WHERE t.club_id = v_club
       AND (COALESCE(t.is_private, false) OR t.union_id IS NULL)
       AND t.id <> v_id
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  END IF;

  v_required := greatest(v_effective_guarantee - v_pool, 0);
  v_short := greatest(
    COALESCE(v_floor, 0) + COALESCE(v_exposure, 0) + v_required - v_bank,
    0
  );
  v_locked := EXISTS (
    SELECT 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_id
  );

  v_blinds := CASE
    WHEN jsonb_typeof(p_row -> 'blind_structure') = 'array'
      THEN p_row -> 'blind_structure'
    ELSE public.fn_safe_jsonb_array(p_row ->> 'blind_structure')
  END;
  v_payouts := CASE
    WHEN jsonb_typeof(p_row -> 'payout_structure') = 'array'
      THEN p_row -> 'payout_structure'
    ELSE public.fn_safe_jsonb_array(p_row ->> 'payout_structure')
  END;

  v_complete := NULLIF(trim(COALESCE(p_row ->> 'name', '')), '') IS NOT NULL
    AND (
      NULLIF(p_row ->> 'start_time', '') IS NOT NULL
      OR v_tournament_type IN ('SNG', 'SPIN')
      OR v_variant IN ('sng', 'spin')
    )
    AND COALESCE(NULLIF(p_row ->> 'starting_chips', '')::numeric, 0) > 0
    AND ((p_row->>'format_contract' IS NOT DISTINCT FROM 'mtt-v2' AND p_row->>'max_players' IS NULL
          AND COALESCE(NULLIF(p_row->>'min_players','')::integer,0)>=3)
      OR COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2)
    AND COALESCE(NULLIF(p_row ->> 'buy_in_amount', '')::numeric, 0) >= 0
    AND jsonb_array_length(v_blinds) > 0
    AND (
      jsonb_array_length(v_payouts) > 0
      OR v_tournament_type = 'SPIN'
      OR v_variant = 'spin'
    )
    AND (
      NOT v_is_satellite
      OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)
      -- DIAMOND PHASE 9: a Diamond satellite promises no seat. A seat count
      -- promised in advance is a guarantee; a Diamond guarantee is funded only
      -- from an authorised Diamond house budget, which is not built and whose
      -- size is the owner's, and the creation door refuses one by name. The
      -- satellite's own prize bank buys whole seats in its Diamond target at
      -- settlement, so its contract is complete with none promised. The test
      -- is fn_poker_diamond_tournament's, read from the row.
      OR (v_satellite_seats = 0 AND v_target IS NOT NULL AND v_row_union IS NULL
          AND EXISTS (SELECT 1 FROM public.clubs c
                       WHERE c.id = v_club AND c.asset = 'diamonds'
                         AND c.is_platform IS TRUE AND c.union_id IS NULL)
          AND public.fn_poker_diamond_tournament(v_target))
    );

  RETURN jsonb_build_object(
    'state', CASE
      WHEN v_status IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN 'closed'
      WHEN NOT v_complete THEN 'incomplete'
      WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'
      ELSE 'ready'
    END,
    'can_start', v_status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
      AND v_complete
      AND (NOT v_enforce OR v_short = 0),
    'contract_locked', v_locked,
    'guarantee_enforced', v_enforce,
    'guaranteed_prize', v_guaranteed,
    'satellite_seat_guarantee', v_seat_guarantee,
    'effective_guarantee', v_effective_guarantee,
    'current_prize_pool', v_pool,
    'overlay_required', v_required,
    'bank_type', v_bank_type,
    'bank_balance', v_bank,
    'bank_floor', COALESCE(v_floor, 0),
    'other_live_exposure', COALESCE(v_exposure, 0),
    'short_by', v_short
  );
END;
$function$;
ALTER FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb) TO service_role;
-- @@END fn_tournament_management_readiness_for_row(p_row jsonb)

-- @@DOOR fn_managed_game_contract_document(p_kind text, p_row jsonb)
-- @@PIN md5=ecbcdaa38256199da944b92ff071ed18 len=5104 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_kind
    WHEN 'table' THEN p_row - ARRAY[
      'current_players', 'status', 'created_at', 'updated_at', 'deleted_at',
      'lifecycle', 'role', 'main_index', 'opened_at', 'live_at',
      'break_started_at', 'break_eligible_since', 'promote_pending',
      'deleted_by', 'is_deleted', 'current_hand_id', 'hand_number',
      'last_activity_at', 'tournament_id', 'engine_instance_id',
      'first_button_seat', 'bomb_pot_manual_pending', 'bomb_pot_sched_state',
      'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at', 'seat_game_scope', 'seat_admission_key'
    ]::text[]
    WHEN 'tournament' THEN jsonb_strip_nulls(
      jsonb_build_object(
        'id', p_row -> 'id', 'club_id', p_row -> 'club_id',
        'union_id', p_row -> 'union_id', 'name', p_row -> 'name',
        'description', p_row -> 'description',
        'short_description', p_row -> 'short_description',
        'game_type', p_row -> 'game_type', 'variant', p_row -> 'variant',
        'tournament_type', p_row -> 'tournament_type',
        'buy_in_amount', p_row -> 'buy_in_amount',
        'buy_in_fee', p_row -> 'buy_in_fee',
        'starting_chips', p_row -> 'starting_chips',
        'max_players', p_row -> 'max_players',
        'min_players', p_row -> 'min_players',
        'blind_structure', p_row -> 'blind_structure',
        'payout_structure', p_row -> 'payout_structure',
        'payout_percent', p_row -> 'payout_percent',
        'payout_math_version', CASE WHEN p_row->>'payout_math_version'='2' THEN p_row->'payout_math_version' END,
        'payout_unit_cents', CASE WHEN p_row->>'payout_math_version'='2' THEN p_row->'payout_unit_cents' END,
        'guaranteed_prize', p_row -> 'guaranteed_prize'
      ) || jsonb_build_object(
        'late_reg_levels', p_row -> 'late_reg_levels',
        'late_reg_mins', p_row -> 'late_reg_mins',
        'rebuy_levels', p_row -> 'rebuy_levels',
        'start_time', p_row -> 'start_time',
        'is_rebuy', p_row -> 'is_rebuy',
        'is_reentry', p_row -> 'is_reentry',
        'rebuy_cost', p_row -> 'rebuy_cost',
        'rebuy_chips', p_row -> 'rebuy_chips',
        'max_rebuys', p_row -> 'max_rebuys',
        'max_reentries', p_row -> 'max_reentries',
        'free_buy', p_row -> 'free_buy',
        'add_on_available', p_row -> 'add_on_available',
        'addon_from_start', p_row -> 'addon_from_start',
        'addon_cost', p_row -> 'addon_cost',
        'addon_chips', p_row -> 'addon_chips',
        'addon_levels', p_row -> 'addon_levels',
        'addon_break_minutes', p_row -> 'addon_break_minutes'
      ) || jsonb_build_object(
        'is_bounty', p_row -> 'is_bounty',
        'bounty_amount', p_row -> 'bounty_amount',
        'is_pko', p_row -> 'is_pko',
        'is_mystery_bounty', p_row -> 'is_mystery_bounty',
        'mystery_bounty_min', p_row -> 'mystery_bounty_min',
        'mystery_bounty_max', p_row -> 'mystery_bounty_max',
        'mystery_bounty_profile', p_row -> 'mystery_bounty_profile',
        'mystery_bounty_activation', p_row -> 'mystery_bounty_activation',
        'mystery_bounty_activation_value', p_row -> 'mystery_bounty_activation_value',
        'mystery_bounty_pool_percent', p_row -> 'mystery_bounty_pool_percent',
        'mystery_bounty_regular_pool_percent', p_row -> 'mystery_bounty_regular_pool_percent',
        'mystery_bounty_top_percent', p_row -> 'mystery_bounty_top_percent',
        'spin_type', p_row -> 'spin_type',
        'satellite_target_id', p_row -> 'satellite_target_id',
        'satellite_target', p_row -> 'satellite_target',
        'satellite_seats', p_row -> 'satellite_seats'
      ) || jsonb_build_object(
        'is_xmtt', p_row -> 'is_xmtt',
        'is_private', p_row -> 'is_private',
        'is_vip_only', p_row -> 'is_vip_only',
        'ban_chat', p_row -> 'ban_chat',
        'all_in_or_fold', p_row -> 'all_in_or_fold',
        'label_as_new', p_row -> 'label_as_new',
        'hide_club_name', p_row -> 'hide_club_name',
        'action_time_seconds', p_row -> 'action_time_seconds',
        'table_size', p_row -> 'table_size',
        'accelerated_mtt', p_row -> 'accelerated_mtt',
        'big_blind_ante', p_row -> 'big_blind_ante',
        'authorized_to_register', p_row -> 'authorized_to_register',
        'early_bird_enabled', p_row -> 'early_bird_enabled',
        'early_bird_chips', p_row -> 'early_bird_chips',
        'bubble_protection', p_row -> 'bubble_protection',
        'final_table_deal_enabled', p_row -> 'final_table_deal_enabled',
        'restart_every_minutes', p_row -> 'restart_every_minutes',
        'synchronized_breaks', p_row -> 'synchronized_breaks'
      ) || jsonb_build_object(
        'is_multi_day', p_row -> 'is_multi_day',
        'total_days', p_row -> 'total_days',
        'is_pinned', p_row -> 'is_pinned',
        'schedule_id', p_row -> 'schedule_id'
      )
    )
    ELSE '{}'::jsonb
  END
$function$;
ALTER FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb) TO service_role;
-- @@END fn_managed_game_contract_document(p_kind text, p_row jsonb)

-- @@DOOR fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric)
-- @@PIN md5=0e61fee391a67a566d6eb07883d13792 len=15292 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_levels jsonb;
  v_len integer;
  v_index integer;
  v_level jsonb;
  v_last_index integer;
  v_last jsonb;
  v_is_spin boolean;
  v_continuation jsonb;
  v_float_round double precision;
  v_float_units double precision;
  v_float_integral double precision;
  v_float_bb double precision;
  v_float_sb double precision;
  v_tail_count integer;
  v_tail_first numeric;
  v_tail_last numeric;
  v_ratio numeric := 1.4;
  v_factor numeric;
  v_sb numeric;
  v_bb numeric;
  v_ante numeric;
  v_max_bb numeric;
  v_scale numeric;
  v_capped boolean := false;
  v_anchor_bb numeric;
  v_anchor_ante numeric;
  v_ante_ceiling numeric;
  v_anchor_sb numeric;
  v_sb_ceiling numeric;
BEGIN
  v_levels := public.fn_safe_jsonb_array(p_blind_structure);
  v_len := jsonb_array_length(v_levels);
  IF v_len=0 THEN
    RAISE EXCEPTION 'Tournament blind structure is missing' USING ERRCODE='55000';
  END IF;
  v_index := GREATEST(COALESCE(p_current_level,0),0);

  -- A persisted level is authoritative and is never chip-capped in the engine.
  IF v_index<v_len THEN
    v_level := v_levels->v_index;
    v_sb := COALESCE(
      CASE WHEN COALESCE(v_level->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'smallBlind')::numeric END,
      CASE WHEN COALESCE(v_level->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'small_blind')::numeric END
    );
    v_bb := COALESCE(
      CASE WHEN COALESCE(v_level->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'bigBlind')::numeric END,
      CASE WHEN COALESCE(v_level->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'big_blind')::numeric END
    );
    v_ante := COALESCE(
      CASE WHEN COALESCE(v_level->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'ante')::numeric END,
      0
    );
    RETURN jsonb_build_object(
      'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
      'level_index',v_index,'source','persisted','blind_capped',false
    );
  END IF;

  v_is_spin := lower(COALESCE(p_variant,''))='spin'
            OR upper(COALESCE(p_tournament_type,''))='SPIN';
  IF v_is_spin THEN
    -- A funded draw freezes its continuation rule. Presence with malformed
    -- values is an error, never permission to substitute a newer local rule.
    IF (v_levels->(v_len-1)) ? 'spinContinuation' THEN
      v_continuation := v_levels->(v_len-1)->'spinContinuation';
      IF jsonb_typeof(v_continuation) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_continuation->'version') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'anchorLevel') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'anchorBigBlind') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'growth') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'roundBigTo') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Spin blind continuation is missing its frozen formula'
          USING ERRCODE='55000';
      END IF;
      -- The booked engine formula consumes JavaScript Number values. Keep
      -- IEEE-754 arithmetic through power, division, both rounds and the
      -- final multiplication. Decimal numeric changes 100 * 1.15 / 10.
      BEGIN
        PERFORM (e.value #>> '{}')::double precision
          FROM jsonb_each(v_continuation) e
         WHERE e.key IN ('version','anchorLevel','anchorBigBlind','growth','roundBigTo');
        IF (v_continuation->>'version')::double precision<>1
           OR (v_continuation->>'anchorLevel')::double precision<=0
           OR floor((v_continuation->>'anchorLevel')::double precision)<>(v_continuation->>'anchorLevel')::double precision
           OR (v_continuation->>'anchorBigBlind')::double precision<=0
           OR (v_continuation->>'growth')::double precision<=1
           OR (v_continuation->>'roundBigTo')::double precision<=0 THEN
          RAISE EXCEPTION 'Spin blind continuation is missing its frozen formula' USING ERRCODE='55000';
        END IF;
        v_float_round := (v_continuation->>'roundBigTo')::double precision;
        v_float_units := ((v_continuation->>'anchorBigBlind')::double precision
          * power((v_continuation->>'growth')::double precision,
                  v_index::double precision+1-(v_continuation->>'anchorLevel')::double precision))
          / v_float_round;
        -- PostgreSQL round(float8) rounds ties to even. JavaScript rounds
        -- positive ties upward. Adding 0.5 first also changes near-half
        -- values, so compare the fractional part without shifting it.
        v_float_integral := floor(v_float_units);
        IF v_float_units-v_float_integral >= 0.5::double precision THEN
          v_float_integral := v_float_integral+1::double precision;
        END IF;
        v_float_bb := v_float_integral*v_float_round;
        v_float_units := v_float_bb/2::double precision;
        v_float_sb := floor(v_float_units);
        IF v_float_units-v_float_sb >= 0.5::double precision THEN
          v_float_sb := v_float_sb+1::double precision;
        END IF;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Spin blind continuation is missing its finite frozen formula'
          USING ERRCODE='55000';
      END;
      IF v_float_bb <= 0 OR v_float_bb IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision)
         OR v_float_sb IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN
        RAISE EXCEPTION 'Spin blind continuation overflowed its stored formula'
          USING ERRCODE='55000';
      END IF;
      RETURN jsonb_build_object(
        'small_blind',v_float_sb,'big_blind',v_float_bb,'ante',0,
        'level_index',v_index,'source','spin_receipt_overflow','blind_capped',false
      );
    END IF;
    -- spinBlindsForLevel(index+1), including canonical values when a legacy
    -- persisted array is shorter than today's ten-row Spin ladder.
    v_bb := CASE v_index
      WHEN 0 THEN 20 WHEN 1 THEN 30 WHEN 2 THEN 40 WHEN 3 THEN 60
      WHEN 4 THEN 80 WHEN 5 THEN 100 WHEN 6 THEN 120 WHEN 7 THEN 150
      WHEN 8 THEN 180 WHEN 9 THEN 210
      ELSE round((210::numeric*power(1.4::numeric,v_index-9))/10)*10
    END;
    v_sb := round(v_bb/2);
    RETURN jsonb_build_object(
      'small_blind',v_sb,'big_blind',v_bb,'ante',0,
      'level_index',v_index,'source','spin_overflow','blind_capped',false
    );
  END IF;

  -- Ignore trailing break rows when choosing the overflow anchor.
  v_last_index := v_len-1;
  WHILE v_last_index>0
    AND lower(COALESCE(v_levels->v_last_index->>'isBreak','false'))='true'
  LOOP
    v_last_index := v_last_index-1;
  END LOOP;
  v_last := v_levels->v_last_index;

  -- Geometric mean of the last five positive advertised big-blind steps.
  WITH clean AS (
    SELECT e.ordinality::integer AS ord,
           COALESCE(
             CASE WHEN COALESCE(e.value->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (e.value->>'bigBlind')::numeric END,
             CASE WHEN COALESCE(e.value->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (e.value->>'big_blind')::numeric END
           ) AS bb
      FROM jsonb_array_elements(v_levels) WITH ORDINALITY AS e(value,ordinality)
  ), tail AS (
    SELECT ord,bb FROM clean WHERE bb>0 ORDER BY ord DESC LIMIT 5
  )
  SELECT count(*)::integer,
         (array_agg(bb ORDER BY ord))[1],
         (array_agg(bb ORDER BY ord DESC))[1]
    INTO v_tail_count,v_tail_first,v_tail_last
    FROM tail;
  IF v_tail_count>=2 AND v_tail_first>0 AND v_tail_last>v_tail_first THEN
    v_ratio := power(v_tail_last/v_tail_first,1::numeric/(v_tail_count-1));
    IF v_ratio<=1 THEN v_ratio := 1.4; END IF;
  END IF;
  v_ratio := LEAST(1.6,GREATEST(1.15,v_ratio));
  v_factor := power(
    v_ratio,
    LEAST(GREATEST(1,v_index-v_len+1),40)
  );

  v_sb := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'smallBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'small_blind')::numeric END,
    0
  )*v_factor,10000000);
  v_bb := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  )*v_factor,10000000);
  v_ante := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'ante')::numeric END,
    0
  )*v_factor,10000000);

  -- Match capLevelToTournamentChips for generic overflow. The database wrapper
  -- supplies the exact durable chip issuance total; NULL means cap nothing.
  IF p_total_chips>0 THEN
    v_max_bb := p_total_chips/20;
    IF v_bb>v_max_bb AND v_max_bb>=2 THEN
      v_scale := v_max_bb/v_bb;
      v_bb := GREATEST(2,floor(v_bb*v_scale));
      v_sb := GREATEST(1,floor(v_sb*v_scale));
      v_ante := CASE WHEN v_ante>0 THEN GREATEST(1,floor(v_ante*v_scale)) ELSE 0 END;
      v_capped := true;
    END IF;
  END IF;

  /* A CAPPED LEVEL IS STILL A BLIND LEVEL (2026-09-09). Both ceilings above
     are applied to smallBlind, bigBlind and ante independently, so a deep
     overflow clamps all three to the same number and the level leaves here
     with SB = BB = ante. That is not a blind level: it makes
     fn_ensure_late_registration_capacity refuse the event a table for ever
     (v_sb>=v_bb), and the engine deals from this same answer. Enforce the
     invariant after the clamps instead of trusting it to survive them. */
  IF v_bb IS NULL OR v_bb < 2 THEN
    v_bb := 2;
    v_capped := true;
  END IF;
  IF v_sb IS NULL OR v_sb >= v_bb THEN
    v_sb := GREATEST(1, floor(v_bb / 2));
    v_capped := true;
  END IF;

  /* THE SMALL BLIND KEEPS ITS AUTHORED SHARE OF THE BIG BLIND (2026-09-21).
     The repair immediately above fires only on SB >= BB, which is the END of
     the distortion and not the whole of it. Between the level where the big
     blind reaches the 10,000,000 ceiling and the level where the small blind
     reaches it too, the big blind is pinned and the small blind is still
     growing underneath it: SB < BB throughout, nothing fires, and an authored
     1:2 walks up through 0.63 and 0.84 towards 1:1 while reporting
     blind_capped false. 528 published levels were sitting in that band on
     2026-09-21, 48 of them at 0.9762 of their big blind.

     The small blind's authored relationship to the big blind lives on the same
     anchor row this branch already grew both of them from, so read it there
     and hold the small blind to it - the ante ceiling below does exactly this
     with ante:bigBlind. This is a CEILING and never a floor: it can only lower
     a small blind, so no level becomes more expensive than it is today. An
     anchor authoring sb >= bb is left alone, because the repair above has
     already put the small blind at half the big blind and raising it back is
     not this ceiling's job. */
  v_anchor_sb := COALESCE(
    CASE WHEN COALESCE(v_last->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'smallBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'small_blind')::numeric END,
    0
  );
  v_anchor_bb := COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  );
  IF v_sb > 0 AND v_anchor_bb > 0 AND v_anchor_sb > 0
     AND v_anchor_sb < v_anchor_bb THEN
    -- Multiply before dividing: the proportion itself is never materialised,
    -- so an anchor like 1500000/4000000 stays exact instead of losing its last
    -- digit to a rounded quotient.
    v_sb_ceiling := v_bb * v_anchor_sb / v_anchor_bb;
    -- Compared unrounded, assigned rounded: a level already sitting at its
    -- authored proportion is left alone rather than shaved by the floor.
    IF v_sb > v_sb_ceiling THEN
      v_sb := GREATEST(1, floor(v_sb_ceiling));
      v_capped := true;
    END IF;
  END IF;
  IF v_ante IS NULL OR v_ante < 0 THEN
    v_ante := 0;
  END IF;

  /* THE ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND (2026-09-20). The
     2026-09-09 repair above restored SB < BB after the two ceilings, but the
     ante left here still carrying whatever the 10,000,000 ceiling had
     saturated it to - on a deep overflow, the big blind itself. Two RUNNING
     events were dealing ante = BB on 2026-09-20.

     The ante's authored relationship to the big blind lives on the same
     anchor row this branch already grew SB and BB from, so read it there and
     hold the ante to it. This is a CEILING and never a floor: it can only
     lower an ante, so no level becomes more expensive than it is today. A
     structure that authors ante = BB (a big blind ante; AnteMath.ts counts
     two of them) has a proportion of 1 and is unchanged. A structure with no
     ante never reaches here with one. */
  v_anchor_bb := COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  );
  v_anchor_ante := COALESCE(
    CASE WHEN COALESCE(v_last->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'ante')::numeric END,
    0
  );
  IF v_ante > 0 THEN
    IF v_anchor_bb > 0 AND v_anchor_ante >= v_anchor_bb THEN
      -- A big blind ante authors ante = bigBlind. AnteMath.ts reads
      -- `ante >= bigBlind` as "this structure authored a TOTAL"; rounding the
      -- ante a fraction of a chip below a fractional big blind would flip that
      -- test and charge the table ante x seats instead. Hold it at the big
      -- blind exactly.
      v_ante_ceiling := v_bb;
    ELSIF v_anchor_bb > 0 AND v_anchor_ante > 0 THEN
      -- Multiply before dividing: the proportion itself is never materialised,
      -- so an anchor like 200000/1500000 stays exact instead of losing its
      -- last digit to a rounded quotient.
      v_ante_ceiling := v_bb * v_anchor_ante / v_anchor_bb;
    ELSE
      v_ante_ceiling := v_bb;
    END IF;
    -- Compared unrounded, assigned rounded: a level already sitting at its
    -- authored proportion is left alone rather than shaved by the floor.
    IF v_ante > v_ante_ceiling THEN
      v_ante := GREATEST(1, floor(v_ante_ceiling));
      v_capped := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );
END;
$function$;
ALTER FUNCTION public.fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric)

-- @@DOOR fn_sync_club_table_counts()
-- @@PIN md5=e6c241bd521e80221e86131959e0dc34 len=2848 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_sync_club_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clubs uuid[];
  v_unions uuid[];
BEGIN
  -- Both sides, so a table MOVING between clubs or unions fixes the club it
  -- left as well as the one it joined.
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);

  -- A COUNT THAT HAS NOT CHANGED IS NOT A WRITE (2026-09-29).
  -- This fires on every status change of every table, and the engine cycles a
  -- live table between 'waiting' and 'running' all day. fn_live_table_count
  -- counts tables whose status is NOT IN ('closed','deleted'), so both of those
  -- statuses count and the total does not move: the UPDATE assigned the value
  -- the row already held. Measured 2026-09-29 04:10 UTC, all five clubs had
  -- stored = recomputed, so every one of those writes was a no-op, and there
  -- were 128,715 of them against ten live rows in eleven hours.
  -- A no-op UPDATE is not free. It writes a new version of the club settings
  -- row, runs the fifteen triggers that fire on clubs UPDATE - every lifecycle
  -- and treasury guard, the settings audit, the autoledger, four management
  -- event emitters - and takes an exclusive lock on that one row which is held
  -- until the writing transaction commits. The engine changes table status
  -- inside the hand loop, so that lock was held across the rest of the hand,
  -- and public.clubs was the most contended tuple behind Lock/transactionid.
  -- The recount itself stays: it is an index scan of ~255 buffers and it takes
  -- no lock on clubs. Only the write is conditional, and the column still ends
  -- every call holding exactly fn_live_table_count(id).
  -- Same law as the table_seats no-op suppressor shipped 2026-09-03.
  IF cardinality(v_clubs) > 0 THEN
    UPDATE clubs c
       SET table_count = v.n
      FROM (SELECT t.id, fn_live_table_count(t.id) AS n
              FROM clubs t WHERE t.id = ANY(v_clubs)) v
     WHERE c.id = v.id
       AND c.table_count IS DISTINCT FROM v.n;
  END IF;

  -- Every club that can see a touched union's tables (members + the union row).
  IF cardinality(v_unions) > 0 THEN
    UPDATE clubs c
       SET table_count = v.n
      FROM (SELECT t.id, fn_live_table_count(t.id) AS n
              FROM clubs t
             WHERE t.id = ANY(v_unions)
                OR t.id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions))) v
     WHERE c.id = v.id
       AND c.table_count IS DISTINCT FROM v.n;
  END IF;

  RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_sync_club_table_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_sync_club_table_counts() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_sync_club_table_counts() TO service_role;
-- @@END fn_sync_club_table_counts()

-- @@DOOR trg_validate_tournament_table_origin()
-- @@PIN md5=23771af148d48a94a01e1df628f765aa len=2782 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_validate_tournament_table_origin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  SELECT t.status::text INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament table origin lost parent tournament %', NEW.tournament_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.origin_kind = 'capacity' THEN
    IF upper(v_parent_status) = 'RUNNING'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      PERFORM public.fn_stage_a_bridge_legacy_capacity_receipt(
        NEW.table_id,
        NEW.tournament_id
      );
    END IF;

    IF upper(v_parent_status) <> 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED: RUNNING table % must create its canonical capacity receipt in the same transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'launch' THEN
    IF upper(v_parent_status) <> 'REGISTERING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
            AND r.launch_id = NEW.launch_id
            AND r.lease_generation = NEW.launch_lease_generation
            AND r.completed_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: table % does not belong to the exact incomplete launch receipt',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'prelaunch' THEN
    IF upper(v_parent_status) = 'RUNNING'
       OR EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_PRELAUNCH_ORIGIN_STALE: table % crossed a launch boundary in its birth transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'legacy' THEN
    /* Only the pre-trigger migration backfill can create this honestly.  ACLs
       exclude every application role, and the runtime classifier has no
       legacy branch. */
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'unknown tournament table origin %', NEW.origin_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.trg_validate_tournament_table_origin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_validate_tournament_table_origin() FROM PUBLIC, anon, authenticated, service_role;
-- @@END trg_validate_tournament_table_origin()

-- @@DOOR trg_auto_cashout_on_table_close()
-- @@PIN md5=a936bf2b604a14a6ae620e6b3db852f0 len=479 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  -- An occupied table cannot close. The engine owns its departures.
  -- Do not convert this refusal into a warning and commit a closed table.
  PERFORM public.fn_cashout_seats_for_closing_table(NEW.id,'table '||NEW.status);
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.trg_auto_cashout_on_table_close() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_auto_cashout_on_table_close() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trg_auto_cashout_on_table_close() TO service_role;
-- @@END trg_auto_cashout_on_table_close()

-- @@DOOR fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text)
-- @@PIN md5=d3de0cde88f515f903c7fc381dc8681c len=1059 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text DEFAULT 'table closed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE='22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'skipped','tournament_table');
  END IF;
  -- This read-only assertion is also reached from authorized administrator
  -- close RPCs. It must not require an engine JWT when it moves no money.
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('ok',true,'players_paid',0,
    'chips_returned',0,'reason_text',coalesce(p_reason,'table closed'));
END;
$function$;
ALTER FUNCTION public.fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text) TO service_role;
-- @@END fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text)

-- @@DOOR fn_spin_tournament_contract_is_draw()
-- @@PIN md5=c43cf8d367e0028c0764df3c33f4df41 len=5484 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
  v_multiplier numeric;
  v_prize numeric;
  v_old_sealed boolean;
BEGIN
  IF NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.prize_pool IS NOT DISTINCT FROM OLD.prize_pool
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant,'')) <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- DIAMOND PHASE 9: A DIAMOND SPIN'S CONTRACT IS ITS ONE DRAW RECEIPT. It
  -- books no chip reserve row; its draw is the immutable receipt its own arm
  -- of the authority wrote beside the reserve legs. Before that receipt exists
  -- the contract is undrawn on both sides (the chip pre-launch door), or a
  -- cancellation zeroes the pool (the chip cancellation door, which never
  -- has a booking to unwind here). Once it exists the row equals the receipt
  -- and, published, never moves again.
  IF public.fn_poker_diamond_tournament(NEW.id) THEN
    SELECT (r.receipt->>'multiplier')::numeric, (r.receipt->>'prize_pool')::numeric
      INTO v_multiplier, v_prize
      FROM public.spin_draw_receipts r WHERE r.tournament_id = NEW.id;
    IF NOT FOUND THEN
      IF COALESCE(OLD.spin_multiplier,0) = 0 AND COALESCE(NEW.spin_multiplier,0) = 0
         AND OLD.spin_locked_tiers IS NULL AND NEW.spin_locked_tiers IS NULL
         AND OLD.started_at IS NULL AND NEW.started_at IS NULL
         AND upper(COALESCE(OLD.status::text,'')) IN ('ANNOUNCED','REGISTERING')
         AND (upper(COALESCE(NEW.status::text,'')) IN ('ANNOUNCED','REGISTERING')
              OR (upper(COALESCE(NEW.status::text,'')) IN ('CANCELLED','CANCELED')
                  AND NEW.prize_pool IS NOT DISTINCT FROM 0::numeric)) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Diamond Spin % contract must equal its one immutable draw receipt', NEW.id
        USING ERRCODE='P0404';
    END IF;
    IF NEW.spin_multiplier IS DISTINCT FROM v_multiplier OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
      RAISE EXCEPTION 'Spin % tournament contract must equal its one immutable reserve draw', NEW.id
        USING ERRCODE='P0404';
    END IF;
    IF OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier AND OLD.prize_pool IS NOT DISTINCT FROM v_prize
       AND OLD.spin_locked_tiers IS NOT NULL THEN
      RAISE EXCEPTION 'Spin % published draw contract is immutable', NEW.id USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Preserve the audited terminal exception: cancellation may zero the
  -- contract only when no reserve booking ever existed or its exact unwind
  -- receipt is already durable in this transaction.
  IF upper(COALESCE(NEW.status::text,'')) IN ('CANCELLED','CANCELED')
     AND upper(COALESCE(OLD.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     AND NEW.prize_pool IS NOT DISTINCT FROM 0::numeric
     AND NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers
     AND (
       (NOT EXISTS (
          SELECT 1 FROM public.spin_reserve_ledger r
           WHERE r.tournament_id=NEW.id
             AND r.kind IN ('contribution','jackpot_draw')))
       OR EXISTS (
          SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
           WHERE u.tournament_id=NEW.id)) THEN
    RETURN NEW;
  END IF;

  SELECT count(*),min(r.multiplier),min(round(-r.amount,2))
    INTO v_count,v_multiplier,v_prize
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=NEW.id AND r.kind='jackpot_draw';

  -- A Spin's fill-window deadline is not start truth. Until launch completion,
  -- the tournament status, started_at and immutable launch receipt all prove
  -- it has not started. Requiring zero reserve rows limits this door to the
  -- first two paid seats; the third-seat booking closes it permanently.
  IF v_count=0
     AND upper(COALESCE(OLD.status::text,''))
           IN ('ANNOUNCED','REGISTERING')
     AND upper(COALESCE(NEW.status::text,''))
           IN ('ANNOUNCED','REGISTERING')
     AND OLD.started_at IS NULL
     AND NEW.started_at IS NULL
     AND COALESCE(OLD.spin_multiplier,0)=0
     AND COALESCE(NEW.spin_multiplier,0)=0
     AND OLD.spin_locked_tiers IS NULL
     AND NEW.spin_locked_tiers IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=NEW.id
          AND r.completed_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.tournament_id=NEW.id
          AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN NEW;
  END IF;

  IF v_count<>1
     OR NEW.spin_multiplier IS DISTINCT FROM v_multiplier
     OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION
      'Spin % tournament contract must equal its one immutable reserve draw',
      NEW.id USING ERRCODE='P0404';
  END IF;
  v_old_sealed:=OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier
                AND OLD.prize_pool IS NOT DISTINCT FROM v_prize
                AND OLD.spin_locked_tiers IS NOT NULL;
  IF v_old_sealed THEN
    RAISE EXCEPTION 'Spin % published draw contract is immutable',NEW.id
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_spin_tournament_contract_is_draw() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_tournament_contract_is_draw() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_spin_tournament_contract_is_draw()

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

-- Two INSERT triggers production attached after 2026-09-20, installed on
-- 2026-09-29 in production's own pg_get_triggerdef() text, their functions
-- captured above: a new tournament is never created BAGGED
-- (20260924043224), and every insert records its acceptance (20260924025555).
-- A third trigger that arrived with them, trg_tournaments_record_conclusion,
-- fires only on an UPDATE of status to COMPLETED or CANCELLED - the UPDATE half
-- of the chain, which this capture does not stand up - and is named, not
-- installed. tournaments_guarantee_affordable_ins is the base's and renders to
-- an older function than production's; its WHEN clause (guaranteed_prize > 0)
-- never admits a Diamond row, whose guarantee the create door writes as 0.
CREATE TRIGGER trg_tournaments_bagged_status_door BEFORE INSERT OR UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_bagged_status_door();
CREATE TRIGGER trg_tournaments_record_acceptance AFTER INSERT ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournament_record_acceptance();

-- a0_tournament_manager_write_scope is attached in the historical base and
-- names trg_tournament_manager_write_scope, a function production does not
-- have at all (pg_proc lookup on 2026-09-20 returned zero rows, and no trigger
-- anywhere in production uses it). A retired refusal that still fires is a
-- fixture certifying a door the platform does not have, so it is dropped here,
-- with its reason, rather than left running quietly.
DROP TRIGGER a0_tournament_manager_write_scope ON public.tournaments;
-- The base attaches the same retired function to three more relations, and a
-- Diamond Spin's creation writes one of them (its table). Dropped for the same
-- reason on 2026-09-29: production has no such function and no trigger using it.
DROP TRIGGER a0_tournament_manager_write_scope ON public.tables;
DROP TRIGGER a0_tournament_manager_write_scope ON public.table_seats;
DROP TRIGGER a0_tournament_manager_write_scope ON public.tournament_players;

-- ---------------------------------------------------------------------------
-- THE CAPTURE IS ITS OWN BINDING
-- ---------------------------------------------------------------------------
DO $capture$
DECLARE r record; v_oid oid; v_bad int := 0; v_seen int := 0; v_tg int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('fn_ca_blind_contract_number(p_value jsonb)','7463d39ac93442f5afca76e4ab4e99ba'),
    ('fn_ca_guard_new_satellite_target()','8e0149116be545a6b4ccc0bfe690c372'),
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
    ('fn_union_pnl_original_frame()','9a6559774cc1ed4ed49b315a3428abdb'),
    ('fn_ca_prize_ladder(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)','55d6a74569415d5d51ffac0d5704361f'),
    ('fn_ca_prize_ladder_v2(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer)','6a5ce2617cee7606b2151aea29d865c0'),
    ('fn_ca_prize_ladder_versioned(p_pool_cents bigint, p_entries jsonb, p_unit_cents integer, p_version integer)','cb73955cbc90b47b36fd818631691303'),
    ('fn_ca_payout_structure(p_entrants integer, p_percent integer)','320527cd5203efab28b465d2b56ca567'),
    ('fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid)','29c40f922b42b732f292fc8611efe114'),
    ('fn_poker_diamond_create_spin(p_config jsonb, p_arena uuid)','0e3becd7819a0f58b99cfd6cc2750b5a'),
    ('fn_poker_diamond_spin_contract(p_buy_in bigint, p_starting_chips integer, p_tiers jsonb, p_blinds jsonb)','35a90ec487ba000e87ceec971998ceca'),
    ('fn_tournaments_bagged_status_door()','0b794e7f3f5c35c762bbea29eab8afbc'),
    ('fn_tournament_record_acceptance()','e2b1faebf4b5d58e1b84c99cb8820681'),
    ('fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean)','00e225cc67cf595af35831e981106d93'),
    ('fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc'),
    ('fn_tournament_management_readiness_for_row(p_row jsonb)','f8a6070eb5847c8922e09f28566bfa9e'),
    ('fn_managed_game_contract_document(p_kind text, p_row jsonb)','ecbcdaa38256199da944b92ff071ed18'),
    ('fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric)','0e61fee391a67a566d6eb07883d13792'),
    ('fn_sync_club_table_counts()','e6c241bd521e80221e86131959e0dc34'),
    ('trg_validate_tournament_table_origin()','23771af148d48a94a01e1df628f765aa'),
    ('trg_auto_cashout_on_table_close()','a936bf2b604a14a6ae620e6b3db852f0'),
    ('fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text)','d3de0cde88f515f903c7fc381dc8681c'),
    ('fn_spin_tournament_contract_is_draw()','c43cf8d367e0028c0764df3c33f4df41')
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
  IF v_seen <> 41 THEN
    RAISE EXCEPTION 'the lifecycle capture declares % doors but this file carries %', 41, v_seen;
  END IF;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% of % captured Diamond tournament lifecycle doors do not match their pins', v_bad, v_seen;
  END IF;
  -- Every trigger function now attached to public.tournaments must be one
  -- production attaches, and every production INSERT trigger this fixture
  -- installed must be attached here. A retired refusal must not survive.
  SELECT count(*) INTO v_tg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.oid = 'public.tournaments'::regclass AND NOT t.tgisinternal;
  IF v_tg <> 59 THEN
    RAISE EXCEPTION 'public.tournaments carries % triggers; this capture stands up 59 of the 63 production carried on 2026-09-29, and names the other four', v_tg;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE p.proname = 'trg_tournament_manager_write_scope') THEN
    RAISE EXCEPTION 'a retired trigger is still attached to a relation';
  END IF;
  RAISE NOTICE 'PASS: all % captured Diamond tournament lifecycle doors match their installed pins', v_seen;
  RAISE NOTICE 'PASS: public.tournaments carries % of production''s 63 trigger definitions; the four not installed are named in this file', v_tg;
END $capture$;
