-- Maintenance drains the existing retention reservation before requesting the global writer lane.
-- Same total32s admission budget; ordinary continuations never queue behind that drain.
-- Raw maintenance-row writes refuse nonqueueing; nested admitted writers remain reentrant.
-- Freeze, ownership/authentication, financial guards, thaws, cron and transport unchanged.
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.maintenance_write_admission()') AND md5(pg_get_functiondef(p.oid))='01ee282547e13d86a28193cbb63ee92b' AND md5(p.prosrc)='9f9944f5658df3e98b0726c119644fb2' AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='35a32eb22120e98228881f67b082e69d' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_clear_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='0f49106f4dbae94f43140ef7a060152d' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='994dbe0efbfab11afb6f9d642370d66f' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_serialize_engine_maintenance_break_write()'::regprocedure AND md5(pg_get_functiondef(p.oid))='6a78481295a690559af0b758472f059a' AND p.proowner='postgres'::regrole AND p.prosecdef=false AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $pre$ BEGIN
 IF to_regprocedure('smarter_private.maintenance_write_admission()') IS NOT NULL THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_ADMISSION_ALREADY_EXISTS'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.certification_retention_admission()'::regprocedure AND md5(pg_get_functiondef(p.oid))='ec27e0ea979243c112522e208cbfde5e' AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=32s']) THEN RAISE EXCEPTION 'MAINTENANCE_RETENTION_RESERVATION_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='f131c5e7fcddd19a584d043b0994d47a' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_PREIMAGE_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_clear_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='24fc97591f5eb361d39f540857791e10' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_PREIMAGE_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='68c3aed2a9601f3d7e05d8331bc8b25e' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_PREIMAGE_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_serialize_engine_maintenance_break_write()'::regprocedure AND md5(pg_get_functiondef(p.oid))='6d62a5f9ad5e8fa615e3eac9396266a3' AND p.proowner='postgres'::regrole AND p.prosecdef=false AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_PREIMAGE_CHANGED'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION smarter_private.maintenance_write_admission()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
 v_deadline timestamptz := clock_timestamp()+interval '32 seconds';
 v_remaining_ms integer;
BEGIN
 -- A thaw or already-admitted writer may invoke a nested maintenance door.
 -- Never invert its held global lane against a reservation waiting for it.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_locks
            WHERE pid=pg_catalog.pg_backend_pid() AND locktype='advisory'
              AND classid=530090 AND objid=1 AND objsubid=2
              AND mode='ExclusiveLock' AND granted) THEN RETURN; END IF;
 -- Reserve only retention's lane. Ordinary hand continuations do not use it.
 PERFORM smarter_private.certification_retention_admission();
 v_remaining_ms := floor(extract(epoch FROM (v_deadline-clock_timestamp()))*1000)::integer;
 IF v_remaining_ms<1 THEN
  RAISE EXCEPTION 'MAINTENANCE_WRITE_ADMISSION_BUDGET_EXHAUSTED' USING ERRCODE='55P03';
 END IF;
 -- One total existing 32-second budget, not 32 seconds for each acquisition.
 -- Function-local configuration restores the caller's lock_timeout on exit.
 PERFORM pg_catalog.set_config('lock_timeout',v_remaining_ms::text||'ms',true);
 PERFORM pg_catalog.pg_advisory_xact_lock(530090,1);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.maintenance_write_admission() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_claim_engine_maintenance_break(p_expected_ownership_token uuid, p_new_ownership_token uuid, p_declared_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  v_row public.engine_maintenance_break%ROWTYPE;
BEGIN
  IF p_expected_ownership_token IS NULL OR p_new_ownership_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_token_required');
  END IF;
  PERFORM smarter_private.maintenance_write_admission();
  SELECT * INTO v_row
    FROM public.engine_maintenance_break b
   WHERE b.id = true
   FOR UPDATE;
  IF NOT FOUND OR v_row.ownership_token <> p_expected_ownership_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_changed');
  END IF;
  UPDATE public.engine_maintenance_break
     SET ownership_token = p_new_ownership_token,
         declared_by = p_declared_by,
         updated_at = clock_timestamp()
   WHERE id = true
     AND ownership_token = p_expected_ownership_token
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_changed');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'phase', v_row.phase,
    'announced_at', v_row.announced_at,
    'break_started_at', v_row.break_started_at,
    'break_ends_at', v_row.break_ends_at,
    'reason', v_row.reason,
    'ownership_token', v_row.ownership_token
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_clear_engine_maintenance_break(p_phase text, p_announced_at timestamp with time zone, p_break_started_at timestamp with time zone, p_break_ends_at timestamp with time zone, p_reason text, p_ownership_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_REQUIRED: a break may only clear its own generation'
      USING ERRCODE = '22023';
  END IF;
  PERFORM smarter_private.maintenance_write_admission();
  DELETE FROM public.engine_maintenance_break b
   WHERE b.id = true
     AND b.phase IS NOT DISTINCT FROM p_phase
     AND b.announced_at IS NOT DISTINCT FROM p_announced_at
     AND b.break_started_at IS NOT DISTINCT FROM p_break_started_at
     AND b.break_ends_at IS NOT DISTINCT FROM p_break_ends_at
     AND b.reason IS NOT DISTINCT FROM p_reason
     AND b.ownership_token = p_ownership_token;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_save_engine_maintenance_break(p_phase text, p_announced_at timestamp with time zone, p_break_started_at timestamp with time zone, p_break_ends_at timestamp with time zone, p_reason text, p_declared_by text, p_ownership_token uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  v_rows integer;
  v_now timestamptz;
BEGIN
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_TOKEN_REQUIRED'
      USING ERRCODE = '22004';
  END IF;

  -- This is also the serialization point for admission. Sample time only after
  -- acquiring it, so a request queued behind an admitted purchase cannot commit
  -- a last-hand row after the fixed boundary and surface a break nobody honors.
  PERFORM smarter_private.maintenance_write_admission();
  v_now := clock_timestamp();

  IF p_phase = 'last_hand' AND (
    p_break_started_at IS NOT NULL
    OR p_break_ends_at IS NOT NULL
    OR p_announced_at > v_now + INTERVAL '5 seconds'
    OR v_now >= p_announced_at + INTERVAL '2 minutes'
  ) THEN
    RAISE EXCEPTION 'MAINTENANCE_LAST_HAND_BOUNDARY_EXPIRED'
      USING ERRCODE = '57014';
  END IF;

  IF p_phase = 'counting_down' AND (
    p_break_started_at IS NULL
    OR p_break_ends_at IS NULL
    OR v_now >= p_break_ends_at
  ) THEN
    RAISE EXCEPTION 'MAINTENANCE_COUNTDOWN_BOUNDARY_EXPIRED'
      USING ERRCODE = '57014';
  END IF;

  INSERT INTO public.engine_maintenance_break (
    id, phase, announced_at, break_started_at, enforce_freeze,
    break_ends_at, reason, declared_by, ownership_token, updated_at
  ) VALUES (
    true, p_phase, p_announced_at, p_break_started_at, true,
    p_break_ends_at, p_reason, p_declared_by, p_ownership_token, v_now
  )
  ON CONFLICT (id) DO UPDATE SET
    phase = EXCLUDED.phase,
    announced_at = EXCLUDED.announced_at,
    break_started_at = EXCLUDED.break_started_at,
    enforce_freeze = EXCLUDED.enforce_freeze,
    break_ends_at = EXCLUDED.break_ends_at,
    reason = EXCLUDED.reason,
    declared_by = EXCLUDED.declared_by,
    ownership_token = EXCLUDED.ownership_token,
    updated_at = EXCLUDED.updated_at
  WHERE public.engine_maintenance_break.ownership_token = EXCLUDED.ownership_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_LOST: save refused'
      USING ERRCODE = '55000';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_serialize_engine_maintenance_break_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* PostgreSQL takes ACCESS EXCLUSIVE before firing a TRUNCATE trigger. Waiting
     for the advisory boundary from there would invert the canonical order
     against an admitted entry that next reads this table. This singleton has
     no legitimate truncate path, so refuse immediately instead of deadlocking. */
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'engine_maintenance_break may not be truncated'
      USING ERRCODE = '0A000';
  END IF;
  /* One exclusive writer boundary. The matching entry paths take this key in
     shared mode, so purchases stay concurrent with each other but can never
     straddle a maintenance-row commit. Transaction scope prevents a pooled
     connection from retaining the lock. */
  IF NOT pg_catalog.pg_try_advisory_xact_lock(530090,1) THEN
    RAISE EXCEPTION 'MAINTENANCE_RAW_WRITE_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  RETURN NULL;
END;
$function$;
DO $post$ BEGIN
 IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.maintenance_write_admission()') AND md5(pg_get_functiondef(p.oid))='01ee282547e13d86a28193cbb63ee92b' AND md5(p.prosrc)='9f9944f5658df3e98b0726c119644fb2' AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='35a32eb22120e98228881f67b082e69d' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_clear_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='0f49106f4dbae94f43140ef7a060152d' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='994dbe0efbfab11afb6f9d642370d66f' AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_serialize_engine_maintenance_break_write()'::regprocedure AND md5(pg_get_functiondef(p.oid))='6a78481295a690559af0b758472f059a' AND p.proowner='postgres'::regrole AND p.prosecdef=false AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_POSTIMAGE_CHANGED'; END IF;
 IF md5(replace(pg_get_functiondef('public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure),'PERFORM smarter_private.maintenance_write_admission();','PERFORM pg_advisory_xact_lock(530090, 1);')) IS DISTINCT FROM 'f131c5e7fcddd19a584d043b0994d47a' THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_UNRELATED_BYTES_CHANGED'; END IF;
 IF md5(replace(pg_get_functiondef('public.fn_clear_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,uuid)'::regprocedure),'PERFORM smarter_private.maintenance_write_admission();','PERFORM pg_advisory_xact_lock(530090, 1);')) IS DISTINCT FROM '24fc97591f5eb361d39f540857791e10' THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_UNRELATED_BYTES_CHANGED'; END IF;
 IF md5(replace(pg_get_functiondef('public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)'::regprocedure),'PERFORM smarter_private.maintenance_write_admission();','PERFORM pg_advisory_xact_lock(530090, 1);')) IS DISTINCT FROM '68c3aed2a9601f3d7e05d8331bc8b25e' THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_UNRELATED_BYTES_CHANGED'; END IF;
 IF md5(replace(pg_get_functiondef('public.fn_serialize_engine_maintenance_break_write()'::regprocedure),'IF NOT pg_catalog.pg_try_advisory_xact_lock(530090,1) THEN
    RAISE EXCEPTION ''MAINTENANCE_RAW_WRITE_ADMISSION_BUSY'' USING ERRCODE=''55P03'';
  END IF;','PERFORM pg_advisory_xact_lock(530090, 1);')) IS DISTINCT FROM '6d62a5f9ad5e8fa615e3eac9396266a3' THEN RAISE EXCEPTION 'MAINTENANCE_WRITE_UNRELATED_BYTES_CHANGED'; END IF;
END $post$;
COMMIT;
