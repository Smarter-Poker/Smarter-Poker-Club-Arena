-- 20261002082303_satellite_board_stands_down_for_a_scheduled_series_and_orpha
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG (engine 55e568ca, 2026-10-02 08:00-08:16Z):
--
-- 1. TournamentRecurring.createSatelliteHeadsUp_error
--    SATELLITE_CREATE_ACTIVE_IDENTITY_AMBIGUOUS, ~28 per 20 minutes. The
--    heads-up satellite board asks fn_ensure_scheduled_mtt_satellite for ONE
--    feeder per (owner scope, target). Its idempotency read counted EVERY
--    non-terminal satellite into the target, including the scheduled
--    satellite series. "Sunday $200 Deep Stack" (61bd0d9c, Deep Stack
--    Society; 851d664a, Midway Union) each has a 9-event scheduled series
--    ("Sunday Deep Stack Satellite $5", all schedule_id NOT NULL, several with
--    12-18 entrants), so the count was 9 and the creator refused on every
--    tick. There is no duplicate to resolve: no board feeder (schedule_id IS
--    NULL) exists for either target, no entrant is affected, no money moves.
--
--    Fix: the board's identity is its unscheduled feeder. More than one
--    unscheduled feeder is still a refusal (a true duplicate). When the target
--    is already fed (by the board's feeder, or else by the scheduled series)
--    the creator returns existing_active on that feeder (board feeder first,
--    then the earliest-starting series event) instead of refusing, which is
--    exactly what it already did when the series had a single event. The
--    rest of the body is byte-for-byte the live body.
--
-- 2. TournamentRecurring.spin/sng_atomic_creation_failed on
--    tournaments_club_id_fkey, ~11 a minute each. spin_bonus_pools.club_id
--    has no foreign key; pools seeded by the welcome package (#5712) for the
--    reserved Create Club certification fixtures stayed is_active after the
--    certificate deleted the fixture club, and the engine opened Spin and SNG
--    boards for them. The engine now opens boards only for owners whose club
--    row exists and is active (same PR). Here the stale rows are retired:
--    every active pool whose club row no longer exists is deactivated
--    (is_active=false, deactivated_at=now()). Each one is asserted to be the
--    exact welcome-package certification shape (club owner, stake 1, 200
--    chip_treasury seed, never drawn, never played, only seed/activation and
--    the certificate's retirement adjustment in its ledger). Balances are not
--    touched by this migration: nothing is credited, debited or burned.
--
-- @live-proof: (SELECT p.prosrc LIKE '%ORDER BY (t.schedule_id IS NOT NULL),t.start_time,t.id LIMIT 1 FOR UPDATE%' FROM pg_proc p WHERE p.oid='public.fn_ensure_scheduled_mtt_satellite(jsonb)'::regprocedure)
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.spin_bonus_pools s WHERE s.is_active AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=s.club_id))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

-- PRE-IMAGE: refuse to run against a body this migration was not written from.
DO $pre$
DECLARE r record;
BEGIN
  SELECT md5(p.prosrc) AS h, pg_get_userbyid(p.proowner) AS own, p.proacl::text AS acl,
         p.proconfig::text AS cfg, p.prosecdef AS sd, p.provolatile AS vol
    INTO r
    FROM pg_proc p WHERE p.oid='public.fn_ensure_scheduled_mtt_satellite(jsonb)'::regprocedure;
  IF r.h IS DISTINCT FROM 'd624b2a22bb90d7edcad7d318d2e9ee0'
     OR r.own IS DISTINCT FROM 'postgres'
     OR r.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp",statement_timeout=30s}'
     OR r.sd IS DISTINCT FROM true OR r.vol IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'SATELLITE_BOARD_STANDS_DOWN_PRE_IMAGE_MISMATCH: md5=% owner=% acl=% cfg=% secdef=% vol=%',
      r.h, r.own, r.acl, r.cfg, r.sd, r.vol;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ensure_scheduled_mtt_satellite(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE v_legacy public.tournaments%ROWTYPE; v_scheduled public.tournaments%ROWTYPE;
 v_row public.tournaments%ROWTYPE; v_target public.tournaments%ROWTYPE;
 v_existing public.tournaments%ROWTYPE; v_config jsonb; v_abi text; v_scope text;
 v_count integer; v_table_id uuid; v_result jsonb; v_total numeric; v_target_total numeric;
 v_min_lead interval; v_id uuid; v_index integer; v_fed integer;
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
 -- The board's own identity is its unscheduled feeder (schedule_id IS NULL).
 -- A scheduled satellite series feeding the same target is the schedule's,
 -- not a duplicate of the board's: the target is already fed, so the board
 -- stands down on the earliest series feeder instead of refusing.
 SELECT count(*) FILTER (WHERE t.schedule_id IS NULL),count(*) INTO v_count,v_fed FROM public.tournaments t WHERE
  ((v_row.union_id IS NOT NULL AND t.union_id=v_row.union_id)
    OR (v_row.union_id IS NULL AND t.club_id=v_row.club_id AND t.union_id IS NULL))
  AND (t.satellite_target_id=v_target.id OR t.satellite_target=v_target.id)
  AND upper(COALESCE(t.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED');
 IF v_count>1 THEN RAISE EXCEPTION 'SATELLITE_CREATE_ACTIVE_IDENTITY_AMBIGUOUS' USING ERRCODE='22023';END IF;
 IF v_fed>0 THEN
  SELECT * INTO v_existing FROM public.tournaments t WHERE
   ((v_row.union_id IS NOT NULL AND t.union_id=v_row.union_id)
     OR (v_row.union_id IS NULL AND t.club_id=v_row.club_id AND t.union_id IS NULL))
   AND (t.satellite_target_id=v_target.id OR t.satellite_target=v_target.id)
   AND upper(COALESCE(t.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
   ORDER BY (t.schedule_id IS NOT NULL),t.start_time,t.id LIMIT 1 FOR UPDATE;
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

-- Retire the active spin pools whose club row is gone (certification fixtures).
DO $pools$
DECLARE v_bad integer; v_done integer;
BEGIN
  PERFORM 1 FROM public.spin_bonus_pools s
   WHERE s.is_active AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=s.club_id)
   ORDER BY s.club_id FOR UPDATE;
  SELECT count(*) INTO v_bad FROM public.spin_bonus_pools s
   WHERE s.is_active AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=s.club_id)
     AND NOT (
       s.owner_kind='club' AND s.seed_source_wallet='chip_treasury'
       AND COALESCE(s.offered_max_stake,0)=1 AND COALESCE(s.highest_stake,0)=1
       AND COALESCE(s.seeded_amount,0)=200 AND COALESCE(s.balance,0) IN (0,200)
       AND COALESCE(s.total_deposited,0)=0 AND COALESCE(s.total_drawn,0)=0
       AND COALESCE(s.spin_count,0)=0 AND COALESCE(s.bonus_count,0)=0
       AND COALESCE(s.surplus_returned,0)=0
       AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                        WHERE l.club_id=s.club_id AND l.kind NOT IN ('seed','activation','adjustment'))
       AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.club_id=s.club_id)
     );
  IF v_bad<>0 THEN
    RAISE EXCEPTION 'ORPHAN_SPIN_POOL_NOT_A_CERTIFICATION_FIXTURE: % pool(s)', v_bad;
  END IF;
  UPDATE public.spin_bonus_pools s SET is_active=false, deactivated_at=now(), updated_at=now()
   WHERE s.is_active AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=s.club_id);
  GET DIAGNOSTICS v_done=ROW_COUNT;
  RAISE NOTICE 'retired % orphan certification spin pool(s)', v_done;
END
$pools$;

-- POST-IMAGE.
DO $post$
DECLARE r record;
BEGIN
  SELECT p.prosrc AS src, pg_get_userbyid(p.proowner) AS own, p.proacl::text AS acl,
         p.proconfig::text AS cfg, p.prosecdef AS sd, p.provolatile AS vol
    INTO r
    FROM pg_proc p WHERE p.oid='public.fn_ensure_scheduled_mtt_satellite(jsonb)'::regprocedure;
  IF r.src NOT LIKE '%ORDER BY (t.schedule_id IS NOT NULL),t.start_time,t.id LIMIT 1 FOR UPDATE%'
     OR r.src NOT LIKE '%count(*) FILTER (WHERE t.schedule_id IS NULL),count(*) INTO v_count,v_fed%'
     OR r.src NOT LIKE '%SATELLITE_CREATE_ACTIVE_IDENTITY_AMBIGUOUS%'
     OR r.own IS DISTINCT FROM 'postgres'
     OR r.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp",statement_timeout=30s}'
     OR r.sd IS DISTINCT FROM true OR r.vol IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'SATELLITE_BOARD_STANDS_DOWN_POST_IMAGE_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM public.spin_bonus_pools s
              WHERE s.is_active AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=s.club_id)) THEN
    RAISE EXCEPTION 'ORPHAN_SPIN_POOL_POST_IMAGE_STILL_ACTIVE';
  END IF;
END
$post$;

COMMIT;
