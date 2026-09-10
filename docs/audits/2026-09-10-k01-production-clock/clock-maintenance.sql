-- Prospective maintenance composition component. NO public clock activation.
-- Requires clock-duration.sql and clock-epochs.sql. All SQL remains outside
-- migrations until the complete transition/member/paid-capacity owner is proved.
CREATE TABLE smarter_private.ca_clock_heads(
 tournament_id uuid PRIMARY KEY,
 epoch_id uuid NOT NULL REFERENCES smarter_private.ca_clock_epochs(epoch_id),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 current_anchor timestamptz NOT NULL CHECK(isfinite(current_anchor)));
CREATE TABLE smarter_private.ca_clock_epoch_coverage(
 epoch_id uuid PRIMARY KEY REFERENCES smarter_private.ca_clock_epochs(epoch_id),
 covered tstzmultirange NOT NULL DEFAULT '{}');
CREATE TABLE smarter_private.ca_clock_maintenance_bindings(
 freeze_started_at timestamptz NOT NULL,
 step text NOT NULL CHECK(step IN ('level_started_at','addon_period_ends_at')),
 tournament_id uuid NOT NULL,
 epoch_id uuid NOT NULL REFERENCES smarter_private.ca_clock_epochs(epoch_id),
 credited_seconds numeric NOT NULL DEFAULT 0 CHECK(credited_seconds>=0),
 applied_micros bigint NOT NULL DEFAULT 0 CHECK(applied_micros>=0),
 PRIMARY KEY(freeze_started_at,step,tournament_id),
 FOREIGN KEY(freeze_started_at,step,tournament_id) REFERENCES
 public.engine_maintenance_thaw_targets(freeze_started_at,step,target_id));
CREATE TABLE smarter_private.ca_clock_thaw_context(
 backend_pid integer NOT NULL,
 transaction_id xid8 NOT NULL,
 announced_at timestamptz NOT NULL,
 freeze_started_at timestamptz NOT NULL,
 ownership_token uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('owner','snapshot','checkpoint','suffix')),
 target_seconds numeric,
 PRIMARY KEY(backend_pid,transaction_id));
ALTER TABLE smarter_private.ca_clock_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.ca_clock_epoch_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.ca_clock_maintenance_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.ca_clock_thaw_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.ca_clock_heads,smarter_private.ca_clock_epoch_coverage,
 smarter_private.ca_clock_maintenance_bindings,smarter_private.ca_clock_thaw_context
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.fn_ca_clock_credit_interval(p_epoch uuid,p_start timestamptz,p_end timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private SET timezone='UTC' AS $fn$
DECLARE e smarter_private.ca_clock_epochs%ROWTYPE;v_old tstzmultirange;v_new tstzmultirange;v_extra tstzmultirange;v_delta numeric;
BEGIN
 SELECT * INTO e FROM smarter_private.ca_clock_epochs WHERE epoch_id=p_epoch;
 IF NOT FOUND OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<p_start THEN
 RAISE EXCEPTION 'CLOCK_CREDIT_INTERVAL_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.ca_clock_epoch_coverage(epoch_id) VALUES(p_epoch) ON CONFLICT DO NOTHING;
 SELECT covered INTO v_old FROM smarter_private.ca_clock_epoch_coverage WHERE epoch_id=p_epoch FOR UPDATE;
 IF p_end<=GREATEST(e.epoch_started_at,p_start) THEN RETURN 0;END IF;
 v_new:=tstzmultirange(tstzrange(GREATEST(e.epoch_started_at,p_start),p_end,'[)'));
 v_extra:=v_new-v_old;
 SELECT COALESCE(sum(extract(epoch FROM (upper(x)-lower(x)))*1000000),0) INTO v_delta FROM unnest(v_extra) x;
 IF v_delta<0 OR v_delta>9007199254740991 OR trunc(v_delta)<>v_delta THEN
 RAISE EXCEPTION 'CLOCK_CREDIT_SAFE_MICROSECONDS_REQUIRED' USING ERRCODE='55000';END IF;
 UPDATE smarter_private.ca_clock_epoch_coverage SET covered=v_old+v_new WHERE epoch_id=p_epoch;
 RETURN v_delta::bigint;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_credit_interval(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Copy exact current private workers and five/three argument owners. Their
-- prosrc must remain byte-identical. Only their schema/name headers differ.
DO $capture$
DECLARE r record;d text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('fn_snapshot_maintenance_thaw_targets(timestamp with time zone,numeric)','fn_ca_clock_base_snapshot','43455b0ff86f51f524b6190fc6bf7dd2'),
 ('fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)','fn_ca_clock_base_suffix','c12308b00489adce1376ba1c1e4ea9d5'),
 ('fn_thaw_platform_checkpointed(timestamp with time zone,numeric,text)','fn_ca_clock_base_checkpoint','8390ea3b5e92685cc29c806c494a680a'),
 ('fn_thaw_platform(timestamp with time zone,timestamp with time zone,numeric,uuid,text)','fn_ca_clock_base_owner_v3','071941c4f82d9f676622dc671fb0db40'),
 ('fn_thaw_platform(timestamp with time zone,numeric,text)','fn_ca_clock_base_owner_legacy','f058bfbb8fb26b8412868fc9a2cbf900')
 ) q(signature,new_name,body_md5) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=('public.'||r.signature)::regprocedure
   AND md5(p.prosrc)=r.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef
   AND p.proacl::text=CASE WHEN r.new_name IN ('fn_ca_clock_base_owner_v3','fn_ca_clock_base_owner_legacy')
    THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END
   AND p.proconfig=CASE WHEN r.new_name='fn_ca_clock_base_owner_v3'
    THEN ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']::text[]
    ELSE ARRAY['search_path=public, pg_temp']::text[] END) THEN
   RAISE EXCEPTION 'CLOCK_MAINTENANCE_SOURCE_DRIFT %',r.signature USING ERRCODE='55000';END IF;
  SELECT pg_get_functiondef(('public.'||r.signature)::regprocedure) INTO d;
  d:=regexp_replace(d,'CREATE OR REPLACE FUNCTION public\.[^(]+','CREATE OR REPLACE FUNCTION smarter_private.'||r.new_name);
  EXECUTE d;
  EXECUTE format('REVOKE ALL ON FUNCTION smarter_private.%s(%s) FROM PUBLIC,anon,authenticated,service_role',
   r.new_name,substring(r.signature FROM '\((.*)\)'));
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=('smarter_private.'||r.new_name||substring(r.signature FROM '\(.*'))::regprocedure
   AND md5(p.prosrc)=r.body_md5) THEN RAISE EXCEPTION 'CLOCK_MAINTENANCE_COPY_CHANGED';END IF;
 END LOOP;
END $capture$;

CREATE FUNCTION smarter_private.fn_ca_clock_require_thaw(p_freeze timestamptz)
RETURNS smarter_private.ca_clock_thaw_context LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE c smarter_private.ca_clock_thaw_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM smarter_private.ca_clock_thaw_context
 WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND freeze_started_at=p_freeze;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.engine_maintenance_break b WHERE b.id
   AND b.ownership_token=c.ownership_token AND b.announced_at=c.announced_at
   AND COALESCE(b.break_started_at,b.announced_at+interval '2 minutes')=c.freeze_started_at
   AND clock_timestamp()>=COALESCE(b.break_ends_at,b.announced_at+interval '7 minutes')) THEN
 RAISE EXCEPTION 'CLOCK_VERIFIED_THAW_OWNER_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN c;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_require_thaw(timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_snapshot_maintenance_thaw_targets(p_freeze_started timestamptz,p_initial_seconds numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE r jsonb;c smarter_private.ca_clock_thaw_context%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads) THEN
 RETURN smarter_private.fn_ca_clock_base_snapshot(p_freeze_started,p_initial_seconds);END IF;
 c:=smarter_private.fn_ca_clock_require_thaw(p_freeze_started);
 r:=smarter_private.fn_ca_clock_base_snapshot(p_freeze_started,p_initial_seconds);
 INSERT INTO smarter_private.ca_clock_maintenance_bindings(freeze_started_at,step,tournament_id,epoch_id)
 SELECT x.freeze_started_at,x.step,x.target_id,h.epoch_id
 FROM public.engine_maintenance_thaw_targets x JOIN smarter_private.ca_clock_heads h ON h.tournament_id=x.target_id
 WHERE x.freeze_started_at=p_freeze_started AND x.step IN ('level_started_at','addon_period_ends_at')
 AND x.credited_seconds=0
 ON CONFLICT DO NOTHING;
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_thaw_platform_checkpointed(p_freeze_started timestamptz,p_frozen_seconds numeric,p_thawed_by text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE r jsonb;c smarter_private.ca_clock_thaw_context%ROWTYPE;v_target numeric;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads) THEN
 RETURN smarter_private.fn_ca_clock_base_checkpoint(p_freeze_started,p_frozen_seconds,p_thawed_by);END IF;
 c:=smarter_private.fn_ca_clock_require_thaw(p_freeze_started);
 SELECT frozen_seconds INTO v_target FROM public.engine_maintenance_thaws WHERE freeze_started_at=p_freeze_started;
 UPDATE smarter_private.ca_clock_thaw_context SET phase='checkpoint',target_seconds=v_target
 WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
 r:=smarter_private.fn_ca_clock_base_checkpoint(p_freeze_started,p_frozen_seconds,p_thawed_by);
 UPDATE smarter_private.ca_clock_thaw_context SET phase=c.phase,target_seconds=c.target_seconds
 WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_credit_maintenance_thaw_targets(p_freeze_started timestamptz,p_target_seconds numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE r jsonb;c smarter_private.ca_clock_thaw_context%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads) THEN
 RETURN smarter_private.fn_ca_clock_base_suffix(p_freeze_started,p_target_seconds);END IF;
 c:=smarter_private.fn_ca_clock_require_thaw(p_freeze_started);
 IF NOT EXISTS(SELECT 1 FROM public.engine_maintenance_thaws WHERE freeze_started_at=p_freeze_started AND frozen_seconds=p_target_seconds) THEN
 RAISE EXCEPTION 'CLOCK_THAW_TARGET_MISMATCH' USING ERRCODE='55000';END IF;
 UPDATE smarter_private.ca_clock_thaw_context SET phase='suffix',target_seconds=p_target_seconds
 WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
 r:=smarter_private.fn_ca_clock_base_suffix(p_freeze_started,p_target_seconds);
 UPDATE smarter_private.ca_clock_thaw_context SET phase=c.phase,target_seconds=c.target_seconds
 WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_credit_maintenance_thaw_targets(timestamptz,numeric) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_announced_at timestamptz,p_freeze_started timestamptz,p_frozen_seconds numeric,p_ownership_token uuid,p_thawed_by text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' SET statement_timeout='35s' SET lock_timeout='32s' AS $fn$
DECLARE r jsonb;v_verified boolean:=false;
BEGIN
 PERFORM pg_advisory_xact_lock(530090,1);
 IF EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads) THEN
  SELECT EXISTS(SELECT 1 FROM public.engine_maintenance_break b WHERE b.id
   AND b.ownership_token=p_ownership_token AND b.announced_at=p_announced_at
   AND COALESCE(b.break_started_at,b.announced_at+interval '2 minutes')=p_freeze_started
   AND clock_timestamp()>=COALESCE(b.break_ends_at,b.announced_at+interval '7 minutes')) INTO v_verified;
  IF v_verified THEN
   INSERT INTO smarter_private.ca_clock_thaw_context VALUES(pg_backend_pid(),pg_current_xact_id(),
   p_announced_at,p_freeze_started,p_ownership_token,'owner',NULL);
  END IF;
 END IF;
 r:=smarter_private.fn_ca_clock_base_owner_v3(p_announced_at,p_freeze_started,p_frozen_seconds,p_ownership_token,p_thawed_by);
 IF v_verified THEN
  IF EXISTS(SELECT 1 FROM smarter_private.ca_clock_maintenance_bindings b
   JOIN public.engine_maintenance_thaw_targets x ON (x.freeze_started_at,x.step,x.target_id)=(b.freeze_started_at,b.step,b.tournament_id)
   JOIN smarter_private.ca_clock_heads h ON h.tournament_id=b.tournament_id
   WHERE b.freeze_started_at=p_freeze_started AND (b.credited_seconds<>x.credited_seconds OR b.epoch_id<>h.epoch_id)) THEN
   RAISE EXCEPTION 'CLOCK_THAW_RECEIPT_DIVERGED' USING ERRCODE='40001';END IF;
  DELETE FROM smarter_private.ca_clock_thaw_context WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
 END IF;
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_freeze_started timestamptz,p_frozen_seconds numeric,p_thawed_by text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads) THEN
 RAISE EXCEPTION 'CLOCK_V3_MAINTENANCE_OWNER_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN smarter_private.fn_ca_clock_base_owner_legacy(p_freeze_started,p_frozen_seconds,p_thawed_by);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) TO service_role;

-- First parent trigger: UPDATE already holds the physical parent row. Both
-- maintenance and event gates must use try-lock before any blocking old guard.
CREATE FUNCTION smarter_private.fn_ca_clock_parent_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE tid uuid;h smarter_private.ca_clock_heads%ROWTYPE;e smarter_private.ca_clock_epochs%ROWTYPE;
 c smarter_private.ca_clock_thaw_context%ROWTYPE;b smarter_private.ca_clock_maintenance_bindings%ROWTYPE;
 v_step text;v_old timestamptz;v_new timestamptz;v_delta numeric;v_micros bigint;v_end timestamptz;
BEGIN
 tid:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) OR NOT pg_try_advisory_xact_lock(hashtextextended('smarter:club-arena:clock-event:'||tid::text,0)) THEN
 RAISE EXCEPTION 'CLOCK_PARENT_BOUNDARY_RETRY' USING ERRCODE='40001';END IF;
 SELECT * INTO h FROM smarter_private.ca_clock_heads WHERE tournament_id=tid FOR UPDATE;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLOCK_ACTIVE_PARENT_DELETE_REFUSED' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT' THEN RAISE EXCEPTION 'CLOCK_ACTIVE_PARENT_ID_REUSED' USING ERRCODE='55000';END IF;
 IF ROW(NEW.current_level,NEW.level_started_at,NEW.on_break,NEW.break_ends_at,NEW.addon_period_ends_at)
 IS NOT DISTINCT FROM ROW(OLD.current_level,OLD.level_started_at,OLD.on_break,OLD.break_ends_at,OLD.addon_period_ends_at) THEN RETURN NEW;END IF;
 SELECT * INTO c FROM smarter_private.ca_clock_thaw_context WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
 IF NOT FOUND OR c.phase NOT IN ('checkpoint','suffix') THEN RAISE EXCEPTION 'CLOCK_CANONICAL_OWNER_REQUIRED' USING ERRCODE='55000';END IF;
 PERFORM smarter_private.fn_ca_clock_require_thaw(c.freeze_started_at);
 IF ROW(NEW.current_level,NEW.on_break,NEW.break_ends_at) IS DISTINCT FROM ROW(OLD.current_level,OLD.on_break,OLD.break_ends_at) THEN
 RAISE EXCEPTION 'CLOCK_THAW_CHANGED_LEVEL_OR_PAUSE' USING ERRCODE='55000';END IF;
 IF NEW.level_started_at IS DISTINCT FROM OLD.level_started_at THEN
  IF NEW.addon_period_ends_at IS DISTINCT FROM OLD.addon_period_ends_at THEN RAISE EXCEPTION 'CLOCK_THAW_MULTI_STEP_WRITE' USING ERRCODE='55000';END IF;
  v_step:='level_started_at';v_old:=OLD.level_started_at;v_new:=NEW.level_started_at;
 ELSE v_step:='addon_period_ends_at';v_old:=OLD.addon_period_ends_at;v_new:=NEW.addon_period_ends_at;END IF;
 SELECT * INTO b FROM smarter_private.ca_clock_maintenance_bindings
 WHERE freeze_started_at=c.freeze_started_at AND step=v_step AND tournament_id=tid FOR UPDATE;
 IF NOT FOUND OR b.epoch_id<>h.epoch_id THEN RAISE EXCEPTION 'CLOCK_THAW_EPOCH_BINDING_REQUIRED' USING ERRCODE='55000';END IF;
 SELECT * INTO e FROM smarter_private.ca_clock_epochs WHERE epoch_id=h.epoch_id;
 IF e.tournament_id<>tid OR e.level_index<>OLD.current_level OR h.current_anchor IS DISTINCT FROM OLD.level_started_at THEN
 RAISE EXCEPTION 'CLOCK_THAW_CANONICAL_STATE_CHANGED' USING ERRCODE='40001';END IF;
 v_delta:=c.target_seconds-b.credited_seconds;
 IF v_delta IS NULL OR v_delta<=0 OR v_delta::text IN ('NaN','Infinity','-Infinity')
 OR v_old IS NULL OR v_new IS NULL OR v_new IS DISTINCT FROM v_old+make_interval(secs=>v_delta)
 OR NOT EXISTS(SELECT 1 FROM public.engine_maintenance_thaw_targets x
 WHERE (x.freeze_started_at,x.step,x.target_id)=(b.freeze_started_at,b.step,b.tournament_id)
 AND x.credited_seconds IN (b.credited_seconds,c.target_seconds)) THEN
 RAISE EXCEPTION 'CLOCK_THAW_SHIFT_NOT_NATIVE_RECEIPT' USING ERRCODE='40001';END IF;
 v_micros:=0;
 IF v_step='level_started_at' THEN
  v_end:=c.freeze_started_at+smarter_private.fn_ca_clock_interval((c.target_seconds*1000000)::bigint);
  v_micros:=smarter_private.fn_ca_clock_credit_interval(h.epoch_id,
   c.freeze_started_at+CASE WHEN b.credited_seconds=0 THEN interval '0' ELSE smarter_private.fn_ca_clock_interval((b.credited_seconds*1000000)::bigint) END,v_end);
  NEW.level_started_at:=OLD.level_started_at+CASE WHEN v_micros=0 THEN interval '0' ELSE smarter_private.fn_ca_clock_interval(v_micros) END;
  UPDATE smarter_private.ca_clock_heads SET current_anchor=NEW.level_started_at,revision=revision+1 WHERE tournament_id=tid;
 END IF;
 UPDATE smarter_private.ca_clock_maintenance_bindings SET credited_seconds=c.target_seconds,applied_micros=applied_micros+v_micros
 WHERE (freeze_started_at,step,tournament_id)=(b.freeze_started_at,b.step,b.tournament_id);
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_parent_gate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a00_ca_clock_parent_gate BEFORE INSERT OR UPDATE OR DELETE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION smarter_private.fn_ca_clock_parent_gate();

-- Candidate private authority must run as the captured database owner, never
-- as a disposable fixture's local superuser.
DO $owners$
DECLARE r record;
BEGIN
 FOR r IN SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='smarter_private' AND p.proname IN ('fn_ca_clock_admit_epoch','fn_ca_clock_base_checkpoint','fn_ca_clock_base_owner_legacy','fn_ca_clock_base_owner_v3','fn_ca_clock_base_snapshot','fn_ca_clock_base_suffix','fn_ca_clock_credit_interval','fn_ca_clock_due_transition','fn_ca_clock_duration','fn_ca_clock_duration_micros','fn_ca_clock_duration_number','fn_ca_clock_epoch_immutable','fn_ca_clock_epoch_seconds','fn_ca_clock_epoch_state','fn_ca_clock_instant','fn_ca_clock_interval','fn_ca_clock_parent_gate','fn_ca_clock_require_thaw') LOOP
 EXECUTE 'ALTER FUNCTION '||r.signature||' OWNER TO postgres';END LOOP;
END $owners$;
ALTER TABLE smarter_private.ca_clock_epochs OWNER TO postgres;
ALTER TABLE smarter_private.ca_clock_heads OWNER TO postgres;
ALTER TABLE smarter_private.ca_clock_epoch_coverage OWNER TO postgres;
ALTER TABLE smarter_private.ca_clock_maintenance_bindings OWNER TO postgres;
ALTER TABLE smarter_private.ca_clock_thaw_context OWNER TO postgres;
