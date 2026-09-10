-- Prospective immutable epoch storage; no public activation API is installed.
-- Existing tournament level/anchor remain canonical. These facts freeze one
-- admitted epoch's effective duration and cannot be recomputed by a reader.
CREATE TABLE smarter_private.ca_clock_epochs(
 epoch_id uuid PRIMARY KEY,
 tournament_id uuid NOT NULL,
 creation_operation_id uuid NOT NULL UNIQUE,
 creation_lease_generation uuid NOT NULL,
 level_index integer NOT NULL CHECK(level_index>=0),
 epoch_started_at timestamptz NOT NULL CHECK(isfinite(epoch_started_at)),
 raw_duration_micros bigint NOT NULL CHECK(raw_duration_micros BETWEEN 1 AND 9007199254740991),
 duration_micros bigint NOT NULL CHECK(duration_micros BETWEEN 1 AND 9007199254740991),
 accelerated boolean NOT NULL,
 entry_closed boolean NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 entry_facts jsonb NOT NULL,
 UNIQUE(tournament_id,epoch_id)
);
ALTER TABLE smarter_private.ca_clock_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.ca_clock_epochs FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.fn_ca_clock_epoch_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 RAISE EXCEPTION 'CLOCK_EPOCH_IS_IMMUTABLE' USING ERRCODE='55000';
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_epoch_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER clock_epoch_is_immutable BEFORE UPDATE OR DELETE ON smarter_private.ca_clock_epochs
 FOR EACH ROW EXECUTE FUNCTION smarter_private.fn_ca_clock_epoch_immutable();

CREATE FUNCTION smarter_private.fn_ca_clock_epoch_state(p_epoch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,smarter_private SET timezone='UTC' AS $fn$
 SELECT jsonb_build_object('epoch_id',e.epoch_id,'tournament_id',e.tournament_id,
 'creation_operation_id',e.creation_operation_id,'creation_lease_generation',e.creation_lease_generation,
 'level_index',e.level_index,'epoch_started_at',e.epoch_started_at,
 'raw_duration_micros',e.raw_duration_micros,'duration_micros',e.duration_micros,
 'accelerated',e.accelerated,'entry_closed',e.entry_closed,'entry_facts',e.entry_facts,
 'admitted_at',e.admitted_at)
 FROM smarter_private.ca_clock_epochs e WHERE e.epoch_id=p_epoch
$fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_epoch_state(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.fn_ca_clock_admit_epoch(
 p_tournament uuid,p_epoch uuid,p_operation uuid,p_generation uuid,p_level integer,p_anchor timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE v_t public.tournaments%ROWTYPE;v_e smarter_private.ca_clock_epochs%ROWTYPE;
 v_duration jsonb;v_closed boolean;v_short boolean;v_now timestamptz;v_cap integer;v_facts jsonb;
BEGIN
 IF p_tournament IS NULL OR p_epoch IS NULL OR p_operation IS NULL OR p_generation IS NULL
 OR p_level IS NULL OR p_level<0 OR p_anchor IS NULL OR NOT isfinite(p_anchor) THEN
  RAISE EXCEPTION 'CLOCK_EPOCH_IDENTITY_REQUIRED' USING ERRCODE='55000';END IF;
 -- This private helper is used only inside the reviewed clock transition.
 -- It does not publish tables or activate an event by itself.
 PERFORM 1 FROM public.engine_tournament_leases l WHERE l.tournament_id=p_tournament FOR KEY SHARE;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'CLOCK_FROZEN' USING ERRCODE='55000';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('smarter:club-arena:clock-operation:'||p_operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('smarter:club-arena:clock-event:'||p_tournament::text,0));
 SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament FOR UPDATE;
 IF NOT FOUND OR v_t.status<>'RUNNING' THEN RAISE EXCEPTION 'CLOCK_RUNNING_TOURNAMENT_REQUIRED' USING ERRCODE='55000';END IF;
 v_now:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id=p_tournament AND l.lease_generation=p_generation
   AND l.protocol_version=2 AND l.heartbeat_at>=v_now-interval '30 seconds') THEN
  RAISE EXCEPTION 'CLOCK_LEASE_EXPIRED_AFTER_WAIT' USING ERRCODE='40001';END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'CLOCK_FROZEN' USING ERRCODE='55000';END IF;
 SELECT * INTO v_e FROM smarter_private.ca_clock_epochs WHERE epoch_id=p_epoch;
 IF FOUND THEN
  IF v_e.tournament_id<>p_tournament OR v_e.creation_operation_id<>p_operation OR v_e.creation_lease_generation<>p_generation
     OR v_e.level_index<>p_level OR v_e.epoch_started_at<>p_anchor THEN
   RAISE EXCEPTION 'CLOCK_EPOCH_REPLAY_MISMATCH' USING ERRCODE='55000';END IF;
  RETURN smarter_private.fn_ca_clock_epoch_state(p_epoch);
 END IF;
 -- Entry closure is observed once at this admission from actual database
 -- facts and the admitted level. A later closure never reprices this epoch.
 v_cap:=COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0);
 v_closed:=COALESCE(v_t.prize_pool_finalized,false);
 IF NOT v_closed THEN
  IF v_cap>0 THEN v_closed:=p_level>=v_cap;
  ELSIF COALESCE(v_t.late_reg_mins,0)>0 THEN
   IF v_t.started_at IS NULL THEN RAISE EXCEPTION 'CLOCK_ENTRY_START_REQUIRED' USING ERRCODE='55000';END IF;
   v_closed:=v_now>=v_t.started_at+make_interval(mins=>v_t.late_reg_mins);
  ELSE v_closed:=true;
  END IF;
 END IF;
 v_short:=lower(COALESCE(v_t.variant,'')) IN ('sng','spin') OR upper(COALESCE(v_t.tournament_type,'')) IN ('SNG','SPIN');
 v_duration:=smarter_private.fn_ca_clock_duration(public.fn_safe_jsonb_array(v_t.blind_structure),
   p_level,v_short,COALESCE(v_t.accelerated_mtt,false),v_closed);
 v_facts:=jsonb_build_object('observed_at',v_now,'level_cap',v_cap,'minute_cap',v_t.late_reg_mins,
   'started_at_micros',smarter_private.fn_ca_clock_instant(v_t.started_at),
   'prize_pool_finalized',COALESCE(v_t.prize_pool_finalized,false),
   'accelerated_config',COALESCE(v_t.accelerated_mtt,false));
 INSERT INTO smarter_private.ca_clock_epochs(epoch_id,tournament_id,creation_operation_id,creation_lease_generation,
   level_index,epoch_started_at,raw_duration_micros,duration_micros,accelerated,entry_closed,admitted_at,entry_facts)
 VALUES(p_epoch,p_tournament,p_operation,p_generation,p_level,p_anchor,
   (v_duration->>'rawDurationMicros')::bigint,(v_duration->>'durationMicros')::bigint,
   (v_duration->>'accelerated')::boolean,v_closed,v_now,v_facts);
 RETURN smarter_private.fn_ca_clock_epoch_state(p_epoch);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_admit_epoch(uuid,uuid,uuid,uuid,integer,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;
