-- R46: every multi-table tournament, including satellites, has unlimited entries.
-- SOURCE ONLY until the protected catalog and publication pipeline qualify.
-- Captured production function bodies: 2026-09-15; pins below hash pg_proc.prosrc.
-- No financial history, accepted ticket plan, player reentry rule, or physical
-- table capacity is rewritten. Legacy numeric MTT caps cease to enforce limits.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION public.fn_ca_is_unlimited_mtt(p_row jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN false
    -- A genuine satellite target has product meaning; an empty object does not.
    WHEN (jsonb_typeof(p_row->'satellite_target_id')='string'
          AND NULLIF(btrim(p_row->>'satellite_target_id'),'') IS NOT NULL)
      OR (jsonb_typeof(p_row->'satelliteTargetId')='string'
          AND NULLIF(btrim(p_row->>'satelliteTargetId'),'') IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM (VALUES(p_row->'satellite_target'),(p_row->'satelliteTarget')) s(target)
         WHERE (jsonb_typeof(target)='string'
                AND NULLIF(btrim(target#>>'{}'),'') IS NOT NULL)
            OR (jsonb_typeof(target)='object' AND (
                 (jsonb_typeof(target->'tournamentId')='string'
                  AND NULLIF(btrim(target->>'tournamentId'),'') IS NOT NULL)
                 OR (jsonb_typeof(target->'tournament_id')='string'
                  AND NULLIF(btrim(target->>'tournament_id'),'') IS NOT NULL)))
      ) THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry') THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('sng','spin','hu_sng','heads_up') THEN false
    ELSE lower(btrim(COALESCE(p_row->>'variant',''))) IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry')
  END;
$function$;
COMMENT ON FUNCTION public.fn_ca_is_unlimited_mtt(jsonb) IS
  'MTT capacity classification; matches server tournamentEntryCapacity. Targets and explicit MTT family precede legacy variant. is_xmtt does not override fixed formats. Unknown is not unlimited.';

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT COALESCE((SELECT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
    FROM public.tournaments t WHERE t.id=p_tournament_id),false);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_is_unlimited_mtt(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_unlimited_mtt(jsonb) TO anon,authenticated,service_role;

-- New/restarted feeder eligibility is stricter than historical settlement.
-- Keep that shared structural rule in one private authority; do not rewrite
-- an accepted old plan or its replay by changing the old settlement predicate.
CREATE FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT COALESCE((SELECT lower(btrim(COALESCE(t.variant,''))) NOT IN
      ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
    AND lower(btrim(COALESCE(t.tournament_type,''))) NOT IN
      ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
    AND public.fn_satellite_target_is_deliverable(t.id)
    AND public.fn_poker_diamond_tournament(t.id) IS FALSE
    FROM public.tournaments t WHERE t.id=p_target_id),false);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(uuid) FROM PUBLIC,anon,authenticated;

-- Bind structural target admission to every writer, including schedules and
-- manual direct inserts. Existing funded target links are not reinterpreted.
CREATE FUNCTION public.fn_ca_guard_new_satellite_target()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_target uuid:=COALESCE(NEW.satellite_target_id,NEW.satellite_target);
  v_structure_supported boolean;
BEGIN
  IF TG_OP='UPDATE' AND v_target IS NOT DISTINCT FROM
    COALESCE(OLD.satellite_target_id,OLD.satellite_target)
    AND (NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,NEW.is_premium_spin,
         NEW.variant,NEW.tournament_type,NEW.club_id,NEW.union_id)
      IS NOT DISTINCT FROM
        (OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,OLD.is_premium_spin,
         OLD.variant,OLD.tournament_type,OLD.club_id,OLD.union_id) THEN RETURN NEW; END IF;
  -- The incoming-feeder check needs a fresh snapshot after the target row
  -- lock. A repeatable snapshot can miss a feeder committed after its start;
  -- locking the target without writing it does not force an MVCC conflict.
  -- Admit one explicit isolation contract, including for a target edit whose
  -- old snapshot appears to contain no feeders. Mixed isolation is not safe
  -- merely because one caller requests SERIALIZABLE.
  IF current_setting('transaction_isolation')<>'read committed'
     AND (TG_OP='UPDATE' OR v_target IS NOT NULL) THEN
    RAISE EXCEPTION 'SATELLITE_CONTRACT_REQUIRES_READ_COMMITTED' USING ERRCODE='0A000';
  END IF;
  -- Inspect NEW directly: a lookup by this row's ID in BEFORE UPDATE still
  -- sees the old stored target. The same rule protects an outgoing feeder
  -- and an upstream event that already has live incoming feeders.
  v_structure_supported:=NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE
    AND NEW.is_mystery_bounty IS FALSE AND NEW.is_premium_spin IS FALSE
    AND lower(btrim(COALESCE(NEW.variant,''))) NOT IN
      ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
    AND lower(btrim(COALESCE(NEW.tournament_type,''))) NOT IN
      ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
    AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
  IF TG_OP='UPDATE' AND NOT v_structure_supported AND EXISTS(
    SELECT 1 FROM public.tournaments s
     WHERE COALESCE(s.satellite_target_id,s.satellite_target)=NEW.id
       AND s.id<>NEW.id
       AND upper(COALESCE(s.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
  ) THEN
    RAISE EXCEPTION 'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' USING ERRCODE='22023';
  END IF;
  IF v_target IS NULL AND (
    lower(btrim(COALESCE(NEW.tournament_type,'')))='satellite'
    OR lower(btrim(COALESCE(NEW.variant,'')))='satellite') THEN
    RAISE EXCEPTION 'SATELLITE_NEW_TARGET_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF v_target IS NOT NULL THEN
    IF NOT v_structure_supported THEN
      RAISE EXCEPTION 'SATELLITE_NEW_SOURCE_UNSUPPORTED' USING ERRCODE='22023';
    END IF;
    PERFORM 1 FROM public.tournaments WHERE id=v_target FOR UPDATE;
    IF NOT FOUND OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target) THEN
      RAISE EXCEPTION 'SATELLITE_NEW_TARGET_UNSUPPORTED' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_new_satellite_target() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER a2_tournaments_new_satellite_target
BEFORE INSERT OR UPDATE OF satellite_target_id,satellite_target,
  is_bounty,is_pko,is_mystery_bounty,is_premium_spin,variant,tournament_type,club_id,union_id
ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_new_satellite_target();

CREATE OR REPLACE FUNCTION public.fn_ca_normalize_mtt_entry_capacity()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF public.fn_ca_is_unlimited_mtt(to_jsonb(NEW)) THEN
    NEW.max_players := NULL;
    IF TG_OP='INSERT' THEN
      NEW.min_players := GREATEST(3,COALESCE(NEW.min_players,3));
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_normalize_mtt_entry_capacity() FROM PUBLIC,anon,authenticated;

-- New/configuration-edited rows persist NULL. Old rows need no bulk rewrite:
-- registration and satellite readers below classify them before consulting cap.
ALTER TABLE public.tournaments ALTER COLUMN max_players DROP NOT NULL;
-- NULL is an MTT contract, never an escape from a fixed game's entry cap.
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_fixed_entry_capacity_positive CHECK (
  public.fn_ca_is_unlimited_mtt(jsonb_build_object(
    'tournament_type',tournament_type,'variant',variant,
    'satellite_target_id',satellite_target_id,'satellite_target',satellite_target))
  OR COALESCE(max_players>0,false)
);
CREATE TRIGGER a0_tournaments_unlimited_entry_capacity
BEFORE INSERT OR UPDATE OF max_players,tournament_type,variant,satellite_target_id,satellite_target
ON public.tournaments FOR EACH ROW
EXECUTE FUNCTION public.fn_ca_normalize_mtt_entry_capacity();

-- Registration cannot be diverted to a capacity waitlist by an old client.
-- Existing queue owners may still leave; no registrations or refunds are made.
CREATE FUNCTION public.fn_ca_fixed_tournament_waitlist_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF public.fn_ca_tournament_is_unlimited(NEW.tournament_id) THEN
    RAISE EXCEPTION 'MTTs and satellites register directly; no entry-cap waitlist'
      USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_fixed_tournament_waitlist_only() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER tournament_waitlists_fixed_format_only
BEFORE INSERT OR UPDATE OF tournament_id ON public.tournament_waitlists
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_fixed_tournament_waitlist_only();

-- Name/start-time uniqueness does not deduplicate two workers restarting the
-- same event: their calculated timestamps can differ, and old indexes exclude
-- satellites. The source event is the durable identity, not a multi-day parent.
ALTER TABLE public.tournaments ADD COLUMN restart_source_id uuid
  REFERENCES public.tournaments(id);
CREATE UNIQUE INDEX tournaments_one_restart_per_source
ON public.tournaments(restart_source_id) WHERE restart_source_id IS NOT NULL;
CREATE FUNCTION public.fn_ca_guard_tournament_restart_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_source public.tournaments%ROWTYPE; v_target_row public.tournaments%ROWTYPE; v_target uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.restart_source_id IS NOT NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_RESTART_HISTORY_IMMUTABLE' USING ERRCODE='22023';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.restart_source_id IS DISTINCT FROM OLD.restart_source_id THEN
      RAISE EXCEPTION 'TOURNAMENT_RESTART_SOURCE_IMMUTABLE' USING ERRCODE='22023';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.restart_source_id IS NULL THEN RETURN NEW; END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required for tournament restart' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'TOURNAMENT_RESTART_PLATFORM_FROZEN' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_source FROM public.tournaments
   WHERE id=NEW.restart_source_id FOR UPDATE;
  IF NOT FOUND OR upper(COALESCE(v_source.status,''))<>'COMPLETED'
     OR v_source.ended_at IS NULL OR v_source.schedule_id IS NOT NULL
     OR COALESCE(v_source.restart_every_minutes,0)<=0
     OR NEW.club_id IS DISTINCT FROM v_source.club_id
     OR NEW.union_id IS DISTINCT FROM v_source.union_id
     OR NEW.game_type IS DISTINCT FROM v_source.game_type
     OR NEW.status IS DISTINCT FROM 'REGISTERING'
     OR NEW.current_players IS DISTINCT FROM 0
     OR NEW.schedule_id IS NOT NULL OR NEW.start_time IS NULL
     OR NOT isfinite(NEW.start_time) OR NEW.start_time<=clock_timestamp() THEN
    RAISE EXCEPTION 'TOURNAMENT_RESTART_INVALID_SOURCE' USING ERRCODE='22023';
  END IF;
  IF (public.fn_ca_is_unlimited_mtt(to_jsonb(v_source))
      AND NOT public.fn_ca_is_unlimited_mtt(to_jsonb(NEW)))
     OR (NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_source)) AND (
       lower(COALESCE(v_source.variant,''))='spin'
       OR upper(COALESCE(v_source.tournament_type,''))='SPIN'
       OR COALESCE(v_source.max_players,0)<=2)) THEN
    RAISE EXCEPTION 'TOURNAMENT_RESTART_FORMAT_MISMATCH' USING ERRCODE='22023';
  END IF;
  v_target:=COALESCE(v_source.satellite_target_id,v_source.satellite_target);
  IF COALESCE(NEW.satellite_target_id,NEW.satellite_target) IS DISTINCT FROM v_target
     OR (v_target IS NULL AND (
       upper(COALESCE(v_source.tournament_type,''))='SATELLITE'
       OR lower(COALESCE(v_source.variant,''))='satellite')) THEN
    RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_MISMATCH' USING ERRCODE='22023';
  END IF;
  IF v_target IS NOT NULL THEN
    SELECT * INTO v_target_row FROM public.tournaments WHERE id=v_target FOR UPDATE;
    IF NOT FOUND OR upper(v_target_row.status) NOT IN ('ANNOUNCED','REGISTERING')
       OR v_target_row.start_time IS NULL OR NOT isfinite(v_target_row.start_time)
       OR v_target_row.start_time<=NEW.start_time
       OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target) THEN
      RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_UNAVAILABLE' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_restart_source() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER a1_tournaments_restart_source
BEFORE INSERT OR UPDATE OF restart_source_id OR DELETE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_tournament_restart_source();

-- Remove only the maximum-entry assumption from versioned prize arithmetic.
-- Do not replace a constraint whose financial definition changed after capture.
DO $constraint_pins$
DECLARE v_actual text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_actual FROM pg_constraint
   WHERE conrelid='public.tournaments'::regclass AND conname='tournament_prize_math_contract_valid';
  IF v_actual IS DISTINCT FROM 'CHECK ((((payout_math_version = 1) AND (payout_unit_cents = 1)) OR ((payout_math_version = 2) AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND (upper(COALESCE(tournament_type, ''''::text)) = ''MTT''::text) AND (COALESCE(max_players, 0) > 2) AND (lower(COALESCE(variant, ''''::text)) <> ALL (ARRAY[''spin''::text, ''sng''::text, ''satellite''::text])) AND (NOT COALESCE(is_premium_spin, false)) AND (satellite_target_id IS NULL) AND (satellite_target IS NULL))))' THEN
    RAISE EXCEPTION 'R46 constraint drift: tournament_prize_math_contract_valid';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_actual FROM pg_constraint
   WHERE conrelid='public.tournaments'::regclass AND conname='tournaments_heads_up_rake_within_5_pct';
  IF v_actual IS DISTINCT FROM 'CHECK (((max_players IS NULL) OR (max_players > 2) OR (COALESCE(buy_in_fee, (0)::numeric) <= (round(((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.05), 2) + 0.005)))) NOT VALID' THEN
    RAISE EXCEPTION 'R46 constraint drift: tournaments_heads_up_rake_within_5_pct';
  END IF;
END;
$constraint_pins$;
-- Denomination, version, event-family and unsupported target exclusions remain.
ALTER TABLE public.tournaments DROP CONSTRAINT tournament_prize_math_contract_valid;
ALTER TABLE public.tournaments ADD CONSTRAINT tournament_prize_math_contract_valid CHECK (
  (payout_math_version=1 AND payout_unit_cents=1)
  OR (payout_math_version=2 AND payout_unit_cents IN (1,100)
    AND upper(COALESCE(tournament_type,''))='MTT'
    AND lower(COALESCE(variant,'')) NOT IN ('spin','sng','satellite')
    AND NOT COALESCE(is_premium_spin,false)
    AND satellite_target_id IS NULL AND satellite_target IS NULL)
);
ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_heads_up_rake_within_5_pct;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_heads_up_rake_within_5_pct CHECK (
  public.fn_ca_is_unlimited_mtt(jsonb_build_object(
    'tournament_type',tournament_type,'variant',variant,
    'satellite_target_id',satellite_target_id,'satellite_target',satellite_target))
  OR max_players IS NULL OR max_players>2
  OR COALESCE(buy_in_fee,0)<=round((COALESCE(buy_in_amount,0)+COALESCE(buy_in_fee,0))*0.05,2)+0.005
) NOT VALID;

-- Exact replacements preserve every unrelated accounting, custody, maintenance,
-- lifecycle and replay branch. Drift refuses the complete transaction.
-- This is an ensure operation: it reports an existing active feeder separately
-- from a new creation. It never promises exact request replay across a finished
-- feeder, whose replacement is a new board operation.
CREATE FUNCTION public.fn_ensure_scheduled_mtt_satellite(p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_row public.tournaments%ROWTYPE;
  v_target public.tournaments%ROWTYPE;
  v_existing_id uuid;
  v_id uuid;
  v_total numeric;
  v_target_total numeric;
  v_scope text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE='42501';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_config) supplied(key)
    WHERE supplied.key NOT IN (
      'club_id','union_id','name','game_type','variant','tournament_type',
      'buy_in_amount','buy_in_fee','guaranteed_prize','starting_chips',
      'max_players','min_players','table_size','current_players','status',
      'blind_structure','blind_speed','is_turbo','payout_structure','start_time',
      'late_reg_levels','late_reg_mins','synchronized_breaks',
      'satellite_target_id','satellite_seats','short_description')) THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_UNKNOWN_CONFIG_KEY' USING ERRCODE='22023';
  END IF;
  -- Ignore obsolete field caps before casting; there is no numeric sentinel.
  SELECT * INTO v_row FROM jsonb_populate_record(NULL::public.tournaments,
    p_config || jsonb_build_object('max_players',NULL));
  IF v_row.club_id IS NULL OR v_row.satellite_target_id IS NULL
     OR (v_row.union_id IS NOT NULL AND v_row.union_id<>v_row.club_id)
     OR NULLIF(btrim(v_row.name),'') IS NULL
     OR v_row.tournament_type IS DISTINCT FROM 'SATELLITE'
     OR v_row.variant IS DISTINCT FROM 'satellite'
     OR v_row.status IS DISTINCT FROM 'REGISTERING'
     OR v_row.current_players IS DISTINCT FROM 0
     OR COALESCE(v_row.min_players,0)<3
     OR COALESCE(v_row.starting_chips,0)<=0
     OR COALESCE(v_row.table_size,0) NOT BETWEEN 2 AND 9
     OR v_row.game_type IS NULL
     OR upper(v_row.game_type) NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8')
     OR (upper(v_row.game_type)='PLO6' AND v_row.table_size>7)
     OR (upper(v_row.game_type)='PLO5' AND v_row.table_size>8)
     OR jsonb_typeof(v_row.blind_structure::jsonb) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_row.payout_structure::jsonb) IS DISTINCT FROM 'array'
     OR v_row.start_time IS NULL
     OR v_row.satellite_seats IS DISTINCT FROM 1
     OR v_row.guaranteed_prize IS DISTINCT FROM 0::numeric
     OR v_row.late_reg_levels IS DISTINCT FROM 0
     OR v_row.late_reg_mins IS DISTINCT FROM 0::numeric
     OR v_row.synchronized_breaks IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_CONFIG' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(v_row.blind_structure::jsonb)=0
     OR v_row.payout_structure::jsonb IS DISTINCT FROM '[{"place":1,"percentage":100}]'::jsonb THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_STRUCTURE' USING ERRCODE='22023';
  END IF;
  v_total:=v_row.buy_in_amount+v_row.buy_in_fee;
  IF v_total IS NULL OR v_total::text IN ('NaN','Infinity','-Infinity')
     OR v_total<1 OR v_total<>round(v_total)
     OR v_row.buy_in_amount<=0 OR v_row.buy_in_fee<0
     OR v_row.buy_in_fee IS DISTINCT FROM trunc(v_total*0.1*100)/100 THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_INVALID_PRICE' USING ERRCODE='22023';
  END IF;
  -- Preserve the established entry-maintenance lock before creation locks.
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;
  v_scope:=CASE WHEN v_row.union_id IS NOT NULL THEN 'union:'||v_row.union_id::text
    ELSE 'club:'||v_row.club_id::text END;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ca:mtt-satellite-board:'||v_scope||':'||v_row.satellite_target_id::text,0));
  SELECT * INTO v_target FROM public.tournaments
   WHERE id=v_row.satellite_target_id FOR UPDATE;
  IF NOT FOUND
     OR (v_row.union_id IS NOT NULL AND v_target.union_id IS DISTINCT FROM v_row.union_id)
     OR (v_row.union_id IS NULL AND (
       v_target.club_id IS DISTINCT FROM v_row.club_id OR v_target.union_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_TARGET_SCOPE_MISMATCH' USING ERRCODE='22023';
  END IF;
  SELECT t.id INTO v_existing_id FROM public.tournaments t
   WHERE ((v_row.union_id IS NOT NULL AND t.union_id=v_row.union_id)
     OR (v_row.union_id IS NULL AND t.club_id=v_row.club_id AND t.union_id IS NULL))
     AND (t.satellite_target_id=v_target.id OR t.satellite_target=v_target.id)
     AND upper(COALESCE(t.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
   ORDER BY t.created_at,t.id LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'outcome','existing_active',
      'tournament_id',v_existing_id,'target_id',v_target.id,
      'club_id',v_row.club_id,'union_id',v_row.union_id);
  END IF;
  IF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_target))
     OR v_target.satellite_target_id IS NOT NULL OR v_target.satellite_target IS NOT NULL
     OR lower(btrim(COALESCE(v_target.variant,'')))='satellite'
     OR upper(btrim(COALESCE(v_target.tournament_type,'')))='SATELLITE'
     OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target.id)
     OR upper(COALESCE(v_target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
     OR v_target.prize_pool_finalized IS TRUE
     OR v_target.start_time IS NULL
     OR v_target.start_time<clock_timestamp()+interval '3 hours'
     OR v_target.start_time>=clock_timestamp()+interval '7 days'
     OR v_row.start_time<=clock_timestamp()
     OR v_row.start_time>=v_target.start_time THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_TARGET_UNAVAILABLE' USING ERRCODE='22023';
  END IF;
  v_target_total:=v_target.buy_in_amount+v_target.buy_in_fee;
  IF v_target_total IS NULL OR v_target_total::text IN ('NaN','Infinity','-Infinity')
     OR v_target_total<20 OR v_target_total<>round(v_target_total,2)
     OR v_row.min_players*v_row.buy_in_amount<v_target_total THEN
    RAISE EXCEPTION 'SATELLITE_CREATE_UNFUNDED_MINIMUM' USING ERRCODE='22023';
  END IF;
  -- The real tournament creation, blind, seat/deck and economic guards run.
  -- No table, registration, wallet movement or ticket is fabricated here.
  INSERT INTO public.tournaments(
    club_id,union_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
    guaranteed_prize,starting_chips,max_players,min_players,table_size,current_players,status,
    blind_structure,blind_speed,is_turbo,payout_structure,start_time,late_reg_levels,late_reg_mins,
    synchronized_breaks,satellite_target_id,satellite_seats,short_description
  ) VALUES(
    v_row.club_id,v_row.union_id,v_row.name,v_row.game_type,'satellite','SATELLITE',
    v_row.buy_in_amount,v_row.buy_in_fee,0,v_row.starting_chips,NULL,v_row.min_players,
    v_row.table_size,0,'REGISTERING',v_row.blind_structure,v_row.blind_speed,v_row.is_turbo,
    v_row.payout_structure,v_row.start_time,0,0,true,v_target.id,1,v_row.short_description
  ) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok',true,'outcome','created',
    'tournament_id',v_id,'target_id',v_target.id,'club_id',v_row.club_id,'union_id',v_row.union_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ensure_scheduled_mtt_satellite(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ensure_scheduled_mtt_satellite(jsonb) TO service_role;

DO $r46$
DECLARE v_oid regprocedure; v_source text; v_definition text; v_before text; v_after text;
BEGIN

  -- fn_tournament_entry_cap_reached
  v_oid := to_regprocedure('public.fn_tournament_entry_cap_reached(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_tournament_entry_cap_reached'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'b3fe14943dd45edcca84f9396034b28c' THEN
    RAISE EXCEPTION 'R46 source drift: fn_tournament_entry_cap_reached, expected %, got %','b3fe14943dd45edcca84f9396034b28c',md5(v_source);
  END IF;
  v_before := $old$IF NOT FOUND OR v_cap IS NULL OR v_cap <= 0 THEN$old$;
  v_after := $new$IF NOT FOUND OR public.fn_ca_tournament_is_unlimited(p_tournament_id)
     OR v_cap IS NULL OR v_cap <= 0 THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_tournament_entry_cap_reached';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_enforce_tournament_capacity
  v_oid := to_regprocedure('public.fn_enforce_tournament_capacity()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_enforce_tournament_capacity'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'002d409f182d90f7e802ca2723d8ec18' THEN
    RAISE EXCEPTION 'R46 source drift: fn_enforce_tournament_capacity, expected %, got %','002d409f182d90f7e802ca2723d8ec18',md5(v_source);
  END IF;
  v_before := $old$IF v_max IS NULL OR v_max <= 0 THEN$old$;
  v_after := $new$IF public.fn_ca_tournament_is_unlimited(NEW.tournament_id)
     OR v_max IS NULL OR v_max <= 0 THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_enforce_tournament_capacity';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_tournament_late_registration_open
  v_oid := to_regprocedure('public.fn_tournament_late_registration_open(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_tournament_late_registration_open'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'ba1c6218246bddd37dc68f746df9e5ef' THEN
    RAISE EXCEPTION 'R46 source drift: fn_tournament_late_registration_open, expected %, got %','ba1c6218246bddd37dc68f746df9e5ef',md5(v_source);
  END IF;
  v_before := $old$t.max_players IS NULL OR t.max_players<=0 OR ($old$;
  v_after := $new$public.fn_ca_is_unlimited_mtt(to_jsonb(t))
         OR t.max_players IS NULL OR t.max_players<=0 OR ($new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_tournament_late_registration_open';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_tournament_atomic_register
  v_oid := to_regprocedure('public.fn_tournament_atomic_register(uuid,uuid,uuid,numeric)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_tournament_atomic_register'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'93009ae524c12102c965f46ef4381e43' THEN
    RAISE EXCEPTION 'R46 source drift: fn_tournament_atomic_register, expected %, got %','93009ae524c12102c965f46ef4381e43',md5(v_source);
  END IF;
  v_before := $old$IF v_tourn.max_players IS NOT NULL AND COALESCE(v_tourn.current_players, 0) >= v_tourn.max_players THEN$old$;
  v_after := $new$IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_tournament_atomic_register';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_award_satellite_seat
  v_oid := to_regprocedure('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_award_satellite_seat'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'2c21c56c6a9d4a2f8ee79082bd4fef57' THEN
    RAISE EXCEPTION 'R46 source drift: fn_award_satellite_seat, expected %, got %','2c21c56c6a9d4a2f8ee79082bd4fef57',md5(v_source);
  END IF;
  v_before := $old$IF v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN$old$;
  v_after := $new$IF public.fn_tournament_entry_cap_reached(p_target_id) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_award_satellite_seat';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_deliver_satellite_ticket_exact
  v_oid := to_regprocedure('public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_deliver_satellite_ticket_exact'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'216b09a2aaf0c60559538ad7caecfbae' THEN
    RAISE EXCEPTION 'R46 source drift: fn_deliver_satellite_ticket_exact, expected %, got %','216b09a2aaf0c60559538ad7caecfbae',md5(v_source);
  END IF;
  v_before := $old$v_open:=v_open AND (v_target.max_players IS NULL OR v_count<v_target.max_players);$old$;
  v_after := $new$v_open:=v_open AND NOT public.fn_tournament_entry_cap_reached(p_target_id);$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_deliver_satellite_ticket_exact';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_settle_satellite_tournament_pre_money_path_gate
  v_oid := to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_settle_satellite_tournament_pre_money_path_gate'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'83bf8b297d07bbae671707f24afec271' THEN
    RAISE EXCEPTION 'R46 source drift: fn_settle_satellite_tournament_pre_money_path_gate, expected %, got %','83bf8b297d07bbae671707f24afec271',md5(v_source);
  END IF;
  v_before := $old$IF COALESCE(v_target.max_players, 0) < 0$old$;
  v_after := $new$IF (NOT public.fn_ca_tournament_is_unlimited(v_target_id)
      AND COALESCE(v_target.max_players, 0) < 0)$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_settle_satellite_tournament_pre_money_path_gate';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN$old$;
  v_after := $new$IF public.fn_tournament_entry_cap_reached(v_target_id) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_settle_satellite_tournament_pre_money_path_gate';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$WHEN v_target.max_players IS NULL OR v_target.max_players = 0$old$;
  v_after := $new$WHEN public.fn_ca_tournament_is_unlimited(v_target_id)
        OR v_target.max_players IS NULL OR v_target.max_players = 0$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 3 drift: fn_settle_satellite_tournament_pre_money_path_gate';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_register_for_tournament_before_atomic_capacity_20260907
  v_oid := to_regprocedure('public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_register_for_tournament_before_atomic_capacity_20260907'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'fa10ae12b0b1882c497377ec1f3d36b9' THEN
    RAISE EXCEPTION 'R46 source drift: fn_register_for_tournament_before_atomic_capacity_20260907, expected %, got %','fa10ae12b0b1882c497377ec1f3d36b9',md5(v_source);
  END IF;
  v_before := $old$IF NOT p_seat_first_internal
     AND (lower$old$;
  v_after := $new$IF NOT p_seat_first_internal
     AND NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND (lower$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_register_for_tournament_before_atomic_capacity_20260907';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$IF v_t.max_players IS NOT NULL AND v_t.max_players > 0
     AND v_players_before >= v_t.max_players THEN$old$;
  v_after := $new$IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND v_t.max_players IS NOT NULL AND v_t.max_players > 0
     AND v_players_before >= v_t.max_players THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_register_for_tournament_before_atomic_capacity_20260907';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_ca_register_for_tournament_with_ticket_for
  v_oid := to_regprocedure('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_ca_register_for_tournament_with_ticket_for'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'b274c4f4e192e0b404397db939476284' THEN
    RAISE EXCEPTION 'R46 source drift: fn_ca_register_for_tournament_with_ticket_for, expected %, got %','b274c4f4e192e0b404397db939476284',md5(v_source);
  END IF;
  v_before := $old$IF lower(COALESCE(v_t.variant,''))='spin'
     OR (v_t.max_players IS NOT NULL
       AND v_t.max_players>0 AND v_t.max_players<=2) THEN$old$;
  v_after := $new$IF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
     AND (lower(COALESCE(v_t.variant,''))='spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players>0 AND v_t.max_players<=2)) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_ca_register_for_tournament_with_ticket_for';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_tournaments_creation_guard
  v_oid := to_regprocedure('public.fn_tournaments_creation_guard()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_tournaments_creation_guard'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'c57c2c577f32e61ad10088e2b34ea3b9' THEN
    RAISE EXCEPTION 'R46 source drift: fn_tournaments_creation_guard, expected %, got %','c57c2c577f32e61ad10088e2b34ea3b9',md5(v_source);
  END IF;
  v_before := $old$BEGIN
  IF COALESCE$old$;
  v_after := $new$BEGIN
  IF public.fn_ca_is_unlimited_mtt(to_jsonb(NEW)) THEN
    NEW.max_players := NULL;
    RETURN NEW;
  END IF;
  IF COALESCE$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_tournaments_creation_guard';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_create_tournament_governed_legacy
  v_oid := to_regprocedure('public.fn_create_tournament_governed_legacy(uuid,jsonb)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_create_tournament_governed_legacy'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'d00caa094f988ca352b6f7038f660c19' THEN
    RAISE EXCEPTION 'R46 source drift: fn_create_tournament_governed_legacy, expected %, got %','d00caa094f988ca352b6f7038f660c19',md5(v_source);
  END IF;
  v_before := $old$  v_fee    := LEAST(v_total,$old$;
  v_after := $new$  -- MTT entry capacity is not a fee tier or a required creator input.
  IF public.fn_ca_is_unlimited_mtt(p_config || jsonb_build_object(
       'tournament_type',COALESCE(p_config->>'type','mtt'))) THEN
    p_config := jsonb_set(p_config,'{maxPlayers}','null'::jsonb,true);
  END IF;
  v_fee    := LEAST(v_total,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_create_tournament_governed_legacy';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$v_max_players := COALESCE((p_config->>'maxPlayers')::int, 0);
  IF v_max_players <= 0 THEN$old$;
  v_after := $new$v_max_players := (p_config->>'maxPlayers')::int;
  IF NOT public.fn_ca_is_unlimited_mtt(p_config || jsonb_build_object(
       'tournament_type',COALESCE(p_config->>'type','mtt')))
     AND COALESCE(v_max_players,0) <= 0 THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_create_tournament_governed_legacy';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$  p_config := jsonb_set(COALESCE(p_config, '{}'::jsonb), '{gameVariant}',$old$;
  v_after := $new$  -- Normalize every supported satellite target spelling before format and
  -- capacity validation; a linked satellite is never created as a fixed SNG.
  v_sat_target := COALESCE(
    NULLIF(btrim(p_config->>'satelliteTargetId'),''),
    NULLIF(btrim(p_config->>'satellite_target_id'),''),
    CASE jsonb_typeof(p_config->'satelliteTarget')
      WHEN 'string' THEN NULLIF(btrim(p_config->>'satelliteTarget'),'')
      WHEN 'object' THEN COALESCE(
        NULLIF(btrim(p_config->'satelliteTarget'->>'tournamentId'),''),
        NULLIF(btrim(p_config->'satelliteTarget'->>'tournament_id'),'')) END,
    CASE jsonb_typeof(p_config->'satellite_target')
      WHEN 'string' THEN NULLIF(btrim(p_config->>'satellite_target'),'')
      WHEN 'object' THEN COALESCE(
        NULLIF(btrim(p_config->'satellite_target'->>'tournamentId'),''),
        NULLIF(btrim(p_config->'satellite_target'->>'tournament_id'),'')) END
  )::uuid;
  IF v_sat_target IS NOT NULL THEN
    p_config := COALESCE(p_config,'{}'::jsonb)
      || jsonb_build_object('satelliteTargetId',v_sat_target);
    IF lower(btrim(COALESCE(p_config->>'type','mtt')))
       IN ('sng','spin','hu_sng','heads_up') THEN
      p_config := p_config || jsonb_build_object('type','satellite');
    END IF;
  END IF;
  p_config := jsonb_set(COALESCE(p_config, '{}'::jsonb), '{gameVariant}',$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 3 drift: fn_create_tournament_governed_legacy';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$v_min_players := GREATEST(COALESCE((p_config->>'minPlayers')::int, 3), 2);$old$;
  v_after := $new$v_min_players := GREATEST(COALESCE((p_config->>'minPlayers')::int, 3),
    CASE WHEN public.fn_ca_is_unlimited_mtt(p_config || jsonb_build_object(
      'tournament_type',COALESCE(p_config->>'type','mtt'))) THEN 3 ELSE 2 END);$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 4 drift: fn_create_tournament_governed_legacy';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_poker_diamond_create_tournament
  v_oid := to_regprocedure('public.fn_poker_diamond_create_tournament(jsonb)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_poker_diamond_create_tournament'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'9fded7b537c67fffe5e7e5090d004aeb' THEN
    RAISE EXCEPTION 'R46 source drift: fn_poker_diamond_create_tournament, expected %, got %','9fded7b537c67fffe5e7e5090d004aeb',md5(v_source);
  END IF;
  v_before := $old$v_max := COALESCE((p_config->>'maxPlayers')::int,0);
  IF v_max<2 OR v_max>10000 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;$old$;
  v_after := $new$v_max := CASE WHEN public.fn_ca_is_unlimited_mtt(
    jsonb_build_object('tournament_type',v_type)) THEN NULL
    ELSE COALESCE((p_config->>'maxPlayers')::int,0) END;
  IF v_type='sng' AND (v_max<2 OR v_max>10000) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023';
  END IF;$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_poker_diamond_create_tournament';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$v_buy_in, v_fee, 0, v_chips, v_max, LEAST(9, GREATEST(2, v_max)), v_min,$old$;
  v_after := $new$v_buy_in, v_fee, 0, v_chips, v_max,
    CASE WHEN v_type='sng' THEN LEAST(9,GREATEST(2,v_max))
         ELSE LEAST(9,GREATEST(2,COALESCE((p_config->>'tableSize')::int,9))) END, v_min,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_poker_diamond_create_tournament';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),2);$old$;
  v_after := $new$v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),
    CASE WHEN v_type='sng' THEN 2 ELSE 3 END);$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 3 drift: fn_poker_diamond_create_tournament';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_tournament_management_readiness_for_row
  v_oid := to_regprocedure('public.fn_tournament_management_readiness_for_row(jsonb)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_tournament_management_readiness_for_row'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'5e94202dfa8e694fb012dbe25abfdf27' THEN
    RAISE EXCEPTION 'R46 source drift: fn_tournament_management_readiness_for_row, expected %, got %','5e94202dfa8e694fb012dbe25abfdf27',md5(v_source);
  END IF;
  v_before := $old$AND COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2$old$;
  v_after := $new$AND (public.fn_ca_is_unlimited_mtt(p_row)
      OR COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2)$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_tournament_management_readiness_for_row';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_guard_new_mtt_blind_contract
  v_oid := to_regprocedure('public.fn_guard_new_mtt_blind_contract()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_guard_new_mtt_blind_contract'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'9b8471c860ac00afa814a6553135c95b' THEN
    RAISE EXCEPTION 'R46 source drift: fn_guard_new_mtt_blind_contract, expected %, got %','9b8471c860ac00afa814a6553135c95b',md5(v_source);
  END IF;
  v_before := $old$IF upper(COALESCE(NEW.tournament_type,''))<>'MTT'
     OR lower(COALESCE(NEW.variant,'')) IN ('spin','sng')
     OR COALESCE(NEW.max_players,0)<=2 THEN RETURN NEW; END IF;$old$;
  v_after := $new$IF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(NEW)) THEN RETURN NEW; END IF;$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_guard_new_mtt_blind_contract';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$AND upper(COALESCE(OLD.tournament_type,''))='MTT'
     AND lower(COALESCE(OLD.variant,'')) NOT IN ('spin','sng')
     AND COALESCE(OLD.max_players,0)>2 THEN RETURN NEW; END IF;$old$;
  v_after := $new$AND public.fn_ca_is_unlimited_mtt(to_jsonb(OLD)) THEN RETURN NEW; END IF;$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_guard_new_mtt_blind_contract';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_short_formats_never_break
  v_oid := to_regprocedure('public.fn_short_formats_never_break()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_short_formats_never_break'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'541f6bd03a10c456f237d1e9c6be91d4' THEN
    RAISE EXCEPTION 'R46 source drift: fn_short_formats_never_break, expected %, got %','541f6bd03a10c456f237d1e9c6be91d4',md5(v_source);
  END IF;
  v_before := $old$IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng')$old$;
  v_after := $new$IF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(NEW))
     AND (upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')
       OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng'))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_short_formats_never_break';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_ca_tournament_seat_cap
  v_oid := to_regprocedure('public.fn_ca_tournament_seat_cap(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_ca_tournament_seat_cap'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'177e2e82ef01b126d16e7706f9d29e12' THEN
    RAISE EXCEPTION 'R46 source drift: fn_ca_tournament_seat_cap, expected %, got %','177e2e82ef01b126d16e7706f9d29e12',md5(v_source);
  END IF;
  v_before := $old$WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'$old$;
  v_after := $new$WHEN NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
      AND (v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_ca_tournament_seat_cap';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'$old$;
  v_after := $new$WHEN NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
      AND (v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_ca_tournament_seat_cap';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_ensure_late_registration_capacity
  v_oid := to_regprocedure('public.fn_ensure_late_registration_capacity(uuid,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_ensure_late_registration_capacity'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'b36dd36a9348d29be1092c7d42954c03' THEN
    RAISE EXCEPTION 'R46 source drift: fn_ensure_late_registration_capacity, expected %, got %','b36dd36a9348d29be1092c7d42954c03',md5(v_source);
  END IF;
  v_before := $old$WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'$old$;
  v_after := $new$WHEN NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
      AND (v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_ensure_late_registration_capacity';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'$old$;
  v_after := $new$WHEN NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
      AND (v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_ensure_late_registration_capacity';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_sync_seat_first_player_count
  v_oid := to_regprocedure('public.fn_sync_seat_first_player_count(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_sync_seat_first_player_count'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'609983772f8468d96b7b3d8dcfeafaea' THEN
    RAISE EXCEPTION 'R46 source drift: fn_sync_seat_first_player_count, expected %, got %','609983772f8468d96b7b3d8dcfeafaea',md5(v_source);
  END IF;
  v_before := $old$SELECT (lower(COALESCE(t.variant, '')) = 'spin'
          OR COALESCE(t.max_players, 0) <= 2),
         lower(COALESCE(t.variant, '')) = 'spin',$old$;
  v_after := $new$SELECT (NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
          AND (lower(COALESCE(t.variant, '')) = 'spin'
            OR COALESCE(t.max_players, 0) <= 2)),
         (NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
          AND lower(COALESCE(t.variant, '')) = 'spin'),$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_sync_seat_first_player_count';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_seat_change_syncs_seat_first_count
  v_oid := to_regprocedure('public.fn_seat_change_syncs_seat_first_count()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_seat_change_syncs_seat_first_count'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'d105db62a249ba49b267d8d28bb55b2f' THEN
    RAISE EXCEPTION 'R46 source drift: fn_seat_change_syncs_seat_first_count, expected %, got %','d105db62a249ba49b267d8d28bb55b2f',md5(v_source);
  END IF;
  v_before := $old$AND (lower(COALESCE(t.variant,'')) = 'spin'$old$;
  v_after := $new$AND NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
       AND (lower(COALESCE(t.variant,'')) = 'spin'$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_seat_change_syncs_seat_first_count';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_seat_first_boards_ready
  v_oid := to_regprocedure('public.fn_seat_first_boards_ready()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_seat_first_boards_ready'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'822966ea0bf2979145c10a1c4e010399' THEN
    RAISE EXCEPTION 'R46 source drift: fn_seat_first_boards_ready, expected %, got %','822966ea0bf2979145c10a1c4e010399',md5(v_source);
  END IF;
  v_before := $old$AND (t.variant = 'spin'$old$;
  v_after := $new$AND NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
    AND (t.variant = 'spin'$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_seat_first_boards_ready';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_take_seat_and_buy_in_before_maintenance_announcement_gate
  v_oid := to_regprocedure('public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_take_seat_and_buy_in_before_maintenance_announcement_gate'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'a4b73120eb5bad86eba900abec29b60a' THEN
    RAISE EXCEPTION 'R46 source drift: fn_take_seat_and_buy_in_before_maintenance_announcement_gate, expected %, got %','a4b73120eb5bad86eba900abec29b60a',md5(v_source);
  END IF;
  v_before := $old$IF NOT (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN$old$;
  v_after := $new$IF public.fn_ca_tournament_is_unlimited(v_t.id)
     OR NOT (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_take_seat_and_buy_in_before_maintenance_announcement_gate';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_seat_horse_in_seat_first_game_before_maintenance_gate
  v_oid := to_regprocedure('public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_seat_horse_in_seat_first_game_before_maintenance_gate'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'f99ebe17189d4b1efef52336cef69715' THEN
    RAISE EXCEPTION 'R46 source drift: fn_seat_horse_in_seat_first_game_before_maintenance_gate, expected %, got %','f99ebe17189d4b1efef52336cef69715',md5(v_source);
  END IF;
  v_before := $old$IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN$old$;
  v_after := $new$IF public.fn_ca_tournament_is_unlimited(p_tournament_id)
     OR NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_seat_horse_in_seat_first_game_before_maintenance_gate';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_reconcile_tournament_denormals
  v_oid := to_regprocedure('public.fn_reconcile_tournament_denormals()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_reconcile_tournament_denormals'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'88897bba83dd2194f4d7b009b8b5b0c1' THEN
    RAISE EXCEPTION 'R46 source drift: fn_reconcile_tournament_denormals, expected %, got %','88897bba83dd2194f4d7b009b8b5b0c1',md5(v_source);
  END IF;
  v_before := $old$AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2)$old$;
  v_after := $new$AND NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
       AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2)$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_reconcile_tournament_denormals';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$(lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2) AS is_seat_first$old$;
  v_after := $new$(NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
            AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
              OR COALESCE(t.max_players, 0) <= 2)) AS is_seat_first$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_reconcile_tournament_denormals';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$WHEN lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
                  OR COALESCE(t.max_players, 0) <= 2$old$;
  v_after := $new$WHEN NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
                  AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
                    OR COALESCE(t.max_players, 0) <= 2)$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 3 drift: fn_reconcile_tournament_denormals';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_create_seat_first_game_atomic
  v_oid := to_regprocedure('public.fn_create_seat_first_game_atomic(uuid,jsonb)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_create_seat_first_game_atomic'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'b40dd95b7a87019070a8abf0fcc4fff3' THEN
    RAISE EXCEPTION 'R46 source drift: fn_create_seat_first_game_atomic, expected %, got %','b40dd95b7a87019070a8abf0fcc4fff3',md5(v_source);
  END IF;
  v_before := $old$OR v_tournament_type NOT IN ('SPIN', 'SNG', 'SATELLITE')$old$;
  v_after := $new$OR public.fn_ca_is_unlimited_mtt(p_config)
     OR v_tournament_type NOT IN ('SPIN', 'SNG')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_create_seat_first_game_atomic';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_tournament_progress_metrics
  v_oid := to_regprocedure('public.fn_tournament_progress_metrics(integer,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_tournament_progress_metrics'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'2f2aa9b7f1647d3840c78475ea9616b5' THEN
    RAISE EXCEPTION 'R46 source drift: fn_tournament_progress_metrics, expected %, got %','2f2aa9b7f1647d3840c78475ea9616b5',md5(v_source);
  END IF;
  v_before := $old$AND upper(COALESCE(t.tournament_type,'')) IN ('MTT','SATELLITE')
    -- Heads-up satellites use the seat-first product, not the scheduled MTT.
    AND COALESCE(t.max_players,0)>2$old$;
  v_after := $new$AND public.fn_ca_is_unlimited_mtt(to_jsonb(t))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_tournament_progress_metrics';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_managed_game_contract_document
  v_oid := to_regprocedure('public.fn_managed_game_contract_document(text,jsonb)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_managed_game_contract_document'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'e691ed61c33d5b6b91045a6575245b70' THEN
    RAISE EXCEPTION 'R46 source drift: fn_managed_game_contract_document, expected %, got %','e691ed61c33d5b6b91045a6575245b70',md5(v_source);
  END IF;
  v_before := $old$'max_players', p_row -> 'max_players',$old$;
  v_after := $new$'max_players', CASE WHEN public.fn_ca_is_unlimited_mtt(p_row)
          THEN NULL ELSE p_row -> 'max_players' END,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_managed_game_contract_document';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_guard_managed_game_lifecycle
  v_oid := to_regprocedure('public.fn_guard_managed_game_lifecycle()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_guard_managed_game_lifecycle'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'7f2ba185a5714534dff4e4c01d07466e' THEN
    RAISE EXCEPTION 'R46 source drift: fn_guard_managed_game_lifecycle, expected %, got %','7f2ba185a5714534dff4e4c01d07466e',md5(v_source);
  END IF;
  v_before := $old$FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF$old$;
  v_after := $new$FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        CONTINUE WHEN v_key='max_players'
          AND public.fn_ca_is_unlimited_mtt(to_jsonb(OLD))
          AND public.fn_ca_is_unlimited_mtt(to_jsonb(NEW));
        IF$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_guard_managed_game_lifecycle';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_overlay_at_risk: NULL projects uncapped funding demand to the existing RPC shape.
  v_oid := to_regprocedure('public.fn_overlay_at_risk(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_overlay_at_risk'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'5ccfc992bb8c775dd528843a71b52fdc' THEN
    RAISE EXCEPTION 'R46 source drift: fn_overlay_at_risk, expected %, got %','5ccfc992bb8c775dd528843a71b52fdc',md5(v_source);
  END IF;
  v_before := $old$coalesce(t.max_players, 0),$old$;
  v_after := $new$CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t)) THEN NULL ELSE t.max_players END,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_overlay_at_risk';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$coalesce(t.max_players, 0) - coalesce(t.current_players, 0)$old$;
  v_after := $new$CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t)) THEN NULL
                  ELSE coalesce(t.max_players, 0) - coalesce(t.current_players, 0) END$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_overlay_at_risk';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_freeroll_fill_targets: NULL projects uncapped funding demand to the existing RPC shape.
  v_oid := to_regprocedure('public.fn_freeroll_fill_targets(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_freeroll_fill_targets'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'ed7ffb085c67cbe299dd754738ae279f' THEN
    RAISE EXCEPTION 'R46 source drift: fn_freeroll_fill_targets, expected %, got %','ed7ffb085c67cbe299dd754738ae279f',md5(v_source);
  END IF;
  v_before := $old$coalesce(t.max_players, 0),$old$;
  v_after := $new$CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t)) THEN NULL ELSE t.max_players END,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_freeroll_fill_targets';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$and coalesce(t.max_players, 0) > coalesce(t.current_players, 0)$old$;
  v_after := $new$and (public.fn_ca_is_unlimited_mtt(to_jsonb(t))
      or coalesce(t.max_players, 0) > coalesce(t.current_players, 0))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_freeroll_fill_targets';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_update_managed_game
  v_oid := to_regprocedure('public.fn_update_managed_game(text,uuid,jsonb)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_update_managed_game'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'d85ca8d75218cdc0911c2fbdb1e73ff9' THEN
    RAISE EXCEPTION 'R46 source drift: fn_update_managed_game, expected %, got %','d85ca8d75218cdc0911c2fbdb1e73ff9',md5(v_source);
  END IF;
  v_before := $old$max_players = GREATEST(
             2,
             COALESCE((p_patch ->> 'max_players')::integer, max_players)
           ),$old$;
  v_after := $new$max_players = CASE WHEN public.fn_ca_tournament_is_unlimited(p_game_id)
             THEN NULL ELSE GREATEST(
               2,COALESCE((p_patch ->> 'max_players')::integer, max_players)
             ) END,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_update_managed_game';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_list_managed_games
  v_oid := to_regprocedure('public.fn_list_managed_games(text,uuid,timestamp with time zone,text,uuid,integer,integer,integer,text,uuid,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_list_managed_games'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'d7ef96526d76c5b26cf89653d0fe9771' THEN
    RAISE EXCEPTION 'R46 source drift: fn_list_managed_games, expected %, got %','d7ef96526d76c5b26cf89653d0fe9771',md5(v_source);
  END IF;
  v_before := $old$COALESCE(t.current_players,0),COALESCE(t.max_players,0),t.start_time,$old$;
  v_after := $new$COALESCE(t.current_players,0),
      CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t)) THEN NULL ELSE t.max_players END,t.start_time,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_list_managed_games';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$COALESCE(t.max_buy_in,0) max_buy_in,0::numeric buy_in,$old$;
  v_after := $new$COALESCE(t.max_buy_in,0) max_buy_in,0::numeric buy_in,
      NULL::text tournament_type,NULL::uuid satellite_target_id,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_list_managed_games';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$COALESCE(t.buy_in_amount,0),
      CASE WHEN$old$;
  v_after := $new$COALESCE(t.buy_in_amount,0),
      t.tournament_type,COALESCE(t.satellite_target_id,t.satellite_target),
      CASE WHEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 3 drift: fn_list_managed_games';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_ca_guard_seat_creation
  v_oid := to_regprocedure('public.fn_ca_guard_seat_creation()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_ca_guard_seat_creation'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'534207f17003588a6ada8b6ea894442d' THEN
    RAISE EXCEPTION 'R46 source drift: fn_ca_guard_seat_creation, expected %, got %','534207f17003588a6ada8b6ea894442d',md5(v_source);
  END IF;
  v_before := $old$IF lower(COALESCE(v_variant,'')) = 'spin'
       OR COALESCE(v_max_players,0) <= 2 THEN$old$;
  v_after := $new$IF NOT public.fn_ca_tournament_is_unlimited(v_tournament_id)
       AND (lower(COALESCE(v_variant,'')) = 'spin'
         OR COALESCE(v_max_players,0) <= 2) THEN$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_ca_guard_seat_creation';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_release_phantom_seat_claims
  v_oid := to_regprocedure('public.fn_release_phantom_seat_claims()');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_release_phantom_seat_claims'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'2153075f26134fa1092bddab64218620' THEN
    RAISE EXCEPTION 'R46 source drift: fn_release_phantom_seat_claims, expected %, got %','2153075f26134fa1092bddab64218620',md5(v_source);
  END IF;
  v_before := $old$AND (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)$old$;
  v_after := $new$AND NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
       AND (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_release_phantom_seat_claims';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_complete_tournament_launch_before_lease_generation
  v_oid := to_regprocedure('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_complete_tournament_launch_before_lease_generation'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'3666a6fb50cc8bbea728dd7c861ad915' THEN
    RAISE EXCEPTION 'R46 source drift: fn_complete_tournament_launch_before_lease_generation, expected %, got %','3666a6fb50cc8bbea728dd7c861ad915',md5(v_source);
  END IF;
  v_before := $old$CASE WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))$old$;
  v_after := $new$CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t)) THEN 3
              WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_complete_tournament_launch_before_lease_generation';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$((lower(COALESCE(t.variant, '')) = 'spin'$old$;
  v_after := $new$(NOT public.fn_ca_is_unlimited_mtt(to_jsonb(t))
          AND (lower(COALESCE(t.variant, '')) = 'spin'$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_complete_tournament_launch_before_lease_generation';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_ca_unregister_tournament_player_exact
  v_oid := to_regprocedure('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_ca_unregister_tournament_player_exact'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'e37cab626ca4bdd3c84c8acec8d9dba3' THEN
    RAISE EXCEPTION 'R46 source drift: fn_ca_unregister_tournament_player_exact, expected %, got %','e37cab626ca4bdd3c84c8acec8d9dba3',md5(v_source);
  END IF;
  v_before := $old$
  IF v_t.satellite_target_id IS NULL$old$;
  v_after := $new$
  IF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
     AND v_t.satellite_target_id IS NULL$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_ca_unregister_tournament_player_exact';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$ELSIF v_t.satellite_target_id IS NULL$old$;
  v_after := $new$ELSIF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
     AND v_t.satellite_target_id IS NULL$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_ca_unregister_tournament_player_exact';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_poker_diamond_tournament_unregister
  v_oid := to_regprocedure('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_poker_diamond_tournament_unregister'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'b208b04fce4a32f5273119bcf2d25450' THEN
    RAISE EXCEPTION 'R46 source drift: fn_poker_diamond_tournament_unregister, expected %, got %','b208b04fce4a32f5273119bcf2d25450',md5(v_source);
  END IF;
  v_before := $old$
  IF v_t.satellite_target_id IS NULL$old$;
  v_after := $new$
  IF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
     AND v_t.satellite_target_id IS NULL$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_poker_diamond_tournament_unregister';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$ELSIF v_t.satellite_target_id IS NULL$old$;
  v_after := $new$ELSIF NOT public.fn_ca_is_unlimited_mtt(to_jsonb(v_t))
     AND v_t.satellite_target_id IS NULL$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_poker_diamond_tournament_unregister';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;
  -- ca_club_tournaments: return authoritative format identity and capacity.
  -- Both the live rows and their count must accept canonical uppercase states.
  v_oid := to_regprocedure('public.ca_club_tournaments(uuid,integer,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: ca_club_tournaments'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'5eada3db23363039e83ebbfe361a009e' THEN
    RAISE EXCEPTION 'R46 source drift: ca_club_tournaments, expected %, got %','5eada3db23363039e83ebbfe361a009e',md5(v_source);
  END IF;
  v_before := $old$t.max_players, t.start_time$old$;
  v_after := $new$CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t))
                THEN NULL ELSE t.max_players END AS max_players,
           t.tournament_type,
           COALESCE(t.satellite_target_id,t.satellite_target) AS satellite_target_id,
           t.start_time$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: ca_club_tournaments';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$t.status IN ('running', 'registering', 'late_reg', 'starting', 'scheduled')$old$;
  v_after := $new$upper(t.status) IN ('RUNNING','REGISTERING','LATE_REG','STARTING','SCHEDULED','ANNOUNCED')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: ca_club_tournaments';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$t.status IN ('running','registering','late_reg','starting','scheduled')$old$;
  v_after := $new$upper(t.status) IN ('RUNNING','REGISTERING','LATE_REG','STARTING','SCHEDULED','ANNOUNCED')$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 3 drift: ca_club_tournaments';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- fn_community_search
  v_oid := to_regprocedure('public.fn_community_search(text,text,integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: fn_community_search'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'1c28e2d0bd58880ccadc90fb1f3dda5a' THEN
    RAISE EXCEPTION 'R46 source drift: fn_community_search, expected %, got %','1c28e2d0bd58880ccadc90fb1f3dda5a',md5(v_source);
  END IF;
  v_before := $old$t.current_players, t.max_players, t.start_time, t.club_id, t.union_id,$old$;
  v_after := $new$t.current_players,
             CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(t)) THEN NULL ELSE t.max_players END AS max_players,
             COALESCE(t.satellite_target_id,t.satellite_target) AS satellite_target_id,
             t.start_time, t.club_id, t.union_id,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: fn_community_search';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old$'max_players', r.max_players,$old$;
  v_after := $new$'max_players', r.max_players,
              'satellite_target_id', r.satellite_target_id,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 2 drift: fn_community_search';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;

  -- get_club_home
  v_oid := to_regprocedure('public.get_club_home(text)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'R46 missing function: get_club_home'; END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO v_source,v_definition FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'b40b6cc79c482925ab7a9b46c0bdf3be' THEN
    RAISE EXCEPTION 'R46 source drift: get_club_home, expected %, got %','b40b6cc79c482925ab7a9b46c0bdf3be',md5(v_source);
  END IF;
  v_before := $old$guaranteed_prize, start_time, status, current_players, max_players,$old$;
  v_after := $new$guaranteed_prize, start_time, status, current_players,
           CASE WHEN public.fn_ca_is_unlimited_mtt(to_jsonb(tournaments)) THEN NULL ELSE max_players END AS max_players,
           tournament_type, satellite_target_id, satellite_target,$new$;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'R46 replacement 1 drift: get_club_home';
  END IF;
  v_definition := replace(v_definition,v_before,v_after);
  EXECUTE v_definition;
END;
$r46$;

-- Declare the reviewed money-table guards in the same atomic migration that
-- installs them. These guards validate configuration and identity; they do
-- not settle, refund, or reinterpret an accepted tournament payment.
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES
  ('tournaments','a0_tournaments_unlimited_entry_capacity',
   'Normalize new MTT and satellite field capacity to NULL and preserve fixed-format entry limits without changing accepted payment terms.'),
  ('tournaments','a1_tournaments_restart_source',
   'Serialize restart-source identity and reject incompatible or duplicate successor configuration without posting or replaying any payment.'),
  ('tournaments','a2_tournaments_new_satellite_target',
   'Lock and validate satellite target contracts at the owning write, preserving accepted prize and ticket terms without settling or refunding funds.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=excluded.note;

COMMIT;
