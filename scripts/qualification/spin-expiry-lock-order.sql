-- SOURCE ONLY / UNRUN. Real-provider catalog qualification, NOT a money/race proof.
-- No provider is created or stubbed. The protected owner must admit these exact
-- sources and the complete current PostgreSQL 17 provider before any execution.
-- The allocation check below is an environment tripwire, not DDL serialization
-- or admission. The owner must independently exclude all concurrent catalog
-- mutation through transaction completion. See the mandatory concurrent-drift
-- case in spin-expiry-lock-order.md; it is not simulated by these drift cases.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
DO $allocation$
DECLARE v_execution text:=current_setting('qualification.execution_uuid',true);
BEGIN
  IF v_execution IS NULL
     OR v_execution !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() IS DISTINCT FROM 'qual_spin_expiry_'||replace(v_execution,'-','')
     OR session_user<>'postgres' OR current_user<>'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR current_setting('port')<>'5432'
     OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
     OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) THEN
    RAISE EXCEPTION 'requires admitted exclusive local PostgreSQL 17 allocation; UUID is not admission';
  END IF;
END;
$allocation$;

CREATE TEMP TABLE qualification_component_sources(name text PRIMARY KEY,sql text NOT NULL);
-- These are exact copies of the two guarded component files, plus exact source
-- images. Regenerate after any edit; native owner independently binds the files.
\ir spin-expiry-lock-order.component-inputs.sql
CREATE TEMP TABLE qualification_catalog_results(label text PRIMARY KEY,scope text NOT NULL);

CREATE FUNCTION pg_temp.assert_true(value boolean,label text) RETURNS void
LANGUAGE plpgsql AS $assert$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'catalog qualification: %',label; END IF; END;
$assert$;

CREATE FUNCTION pg_temp.capture_spin_expiry_catalog() RETURNS jsonb
LANGUAGE sql AS $capture$
  SELECT jsonb_build_object(
    'public_schema_acl',(SELECT n.nspacl::text FROM pg_namespace n WHERE n.nspname='public'),
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p
      WHERE p.oid IN (
        to_regprocedure('public.fn_spin_expire_unfilled(integer)'),
        to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)'),
        to_regprocedure('public.fn_ca_lock_settlement_lane_global()'),
        to_regprocedure('public.fn_sync_seat_first_player_count(uuid)'),
        to_regprocedure('public.fn_ca_guard_watchlist()'))),
    'baseline',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.proname) FROM public.ca_guard_defs d),
    'baseline_history',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.proname,d.def_hash)
      FROM public.ca_guard_def_history d),
    'bindings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgrelid IN (
        'public.tournaments'::regclass,'public.tournament_players'::regclass,
        'public.table_seats'::regclass,'public.spin_draw_receipts'::regclass,
        'public.tournament_cancellation_receipts'::regclass)));
$capture$;

CREATE TEMP TABLE qualification_original_catalog AS SELECT pg_temp.capture_spin_expiry_catalog() value;
-- Pin the exact INSERT prerequisite used by the deliberate baseline drift.
-- Do not silently reinterpret a changed schema or treat setup failure as refusal.
SELECT pg_temp.assert_true((SELECT jsonb_agg(jsonb_build_object(
  'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),
  'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.ca_guard_defs'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  = '[{"type":"text","column":"proname","default":null,"notnull":true},{"type":"text","column":"def_hash","default":null,"notnull":true},{"type":"timestamp with time zone","column":"updated_at","default":"now()","notnull":true},{"type":"text","column":"declared_ref","default":null,"notnull":false},{"type":"timestamp with time zone","column":"declared_at","default":null,"notnull":false}]'::jsonb,
  'exact baseline columns/defaults');
SELECT pg_temp.assert_true((SELECT jsonb_agg(jsonb_build_object(
  'name',c.conname,'definition',pg_get_constraintdef(c.oid,true)) ORDER BY c.conname)
  FROM pg_constraint c WHERE c.conrelid='public.ca_guard_defs'::regclass)
  = '[{"name":"ca_guard_defs_pkey","definition":"PRIMARY KEY (proname)"}]'::jsonb
  AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.ca_guard_defs'::regclass AND NOT t.tgisinternal),
  'exact baseline key and no user trigger setup');
SELECT pg_temp.assert_true(
  pg_get_functiondef('public.fn_spin_expire_unfilled(integer)'::regprocedure)
    =(SELECT sql FROM qualification_component_sources WHERE name='preimage'),
  'start from exact retained installed preimage');

DO $replay$
DECLARE v_forward text; v_rollback text; v_post text; v_saved jsonb;
BEGIN
  SELECT sql INTO STRICT v_forward FROM qualification_component_sources WHERE name='forward';
  SELECT sql INTO STRICT v_rollback FROM qualification_component_sources WHERE name='rollback';
  SELECT sql INTO STRICT v_post FROM qualification_component_sources WHERE name='postimage';
  EXECUTE v_forward;
  PERFORM pg_temp.assert_true(pg_get_functiondef('public.fn_spin_expire_unfilled(integer)'::regprocedure)=v_post,
    'install exact canonical postimage');
  v_saved:=pg_temp.capture_spin_expiry_catalog();
  EXECUTE v_forward;
  PERFORM pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog() IS NOT DISTINCT FROM v_saved,
    'exact forward replay does not alter selected catalog or guard history');
  EXECUTE v_rollback;
  PERFORM pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog()
    IS NOT DISTINCT FROM (SELECT value FROM qualification_original_catalog),
    'rollback restores original selected catalog and guard history');
  EXECUTE v_rollback;
  PERFORM pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog()
    IS NOT DISTINCT FROM (SELECT value FROM qualification_original_catalog),
    'rollback replay is exact');
  INSERT INTO qualification_catalog_results VALUES('install/replay/rollback/replay','selected catalog only');
END;
$replay$;

DO $drift$
DECLARE v_case record; v_forward text; v_before jsonb; v_rejected boolean; v_current text; v_message text;
BEGIN
  SELECT sql INTO STRICT v_forward FROM qualification_component_sources WHERE name='forward';
  FOR v_case IN SELECT * FROM (VALUES
    ('target owner','ALTER FUNCTION public.fn_spin_expire_unfilled(integer) OWNER TO service_role','target authority drift'),
    ('target security','ALTER FUNCTION public.fn_spin_expire_unfilled(integer) SECURITY INVOKER','unsupported target drift'),
    ('target config','ALTER FUNCTION public.fn_spin_expire_unfilled(integer) SET statement_timeout=''1s''','unsupported target drift'),
    ('target ACL','GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer) TO authenticated','target authority drift'),
    ('target strict','ALTER FUNCTION public.fn_spin_expire_unfilled(integer) STRICT','unsupported target drift'),
    ('target volatility','ALTER FUNCTION public.fn_spin_expire_unfilled(integer) STABLE','unsupported target drift'),
    ('target parallel','ALTER FUNCTION public.fn_spin_expire_unfilled(integer) PARALLEL SAFE','unsupported target drift'),
    ('global config','ALTER FUNCTION public.fn_ca_lock_settlement_lane_global() SET search_path=pg_catalog','dependency drift public.fn_ca_lock_settlement_lane_global()'),
    ('global ACL','GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_global() TO authenticated','dependency drift public.fn_ca_lock_settlement_lane_global()'),
    ('cancel security','ALTER FUNCTION public.atomic_cancel_tournament(uuid,uuid) SECURITY INVOKER','dependency drift public.atomic_cancel_tournament(uuid,uuid)'),
    ('cancel ACL','REVOKE EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid) FROM service_role','dependency drift public.atomic_cancel_tournament(uuid,uuid)'),
    ('count sync ACL','GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role','dependency drift public.fn_sync_seat_first_player_count(uuid)'),
    ('watchlist ACL','GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO authenticated','explicit unwatchlisted baseline mode drift'),
    ('unexpected baseline','INSERT INTO public.ca_guard_defs(proname,def_hash) VALUES(''fn_spin_expire_unfilled'',''00000000000000000000000000000000'')','explicit unwatchlisted baseline mode drift'),
    ('binding disabled','ALTER TABLE public.tournaments DISABLE TRIGGER tournaments_cancel_must_refund','critical binding drift tournaments_cancel_must_refund'),
    ('binding removed','DROP TRIGGER spin_draw_receipt_is_immutable ON public.spin_draw_receipts','critical binding drift spin_draw_receipt_is_immutable')
  ) cases(label,mutation,expected_message) LOOP
    BEGIN
      -- Drift is introduced only to prove component refusal. No gameplay,
      -- cancellation, draw or seat authority executes with a changed guard.
      IF v_case.label='target owner' THEN
        -- Ownership transfer requires CREATE in the containing schema. Grant
        -- only inside this drift subtransaction; its rollback and exact ACL
        -- capture below must prove the original schema authority is restored.
        GRANT CREATE ON SCHEMA public TO service_role;
      END IF;
      EXECUTE v_case.mutation;
      v_before:=pg_temp.capture_spin_expiry_catalog();
      v_rejected:=false;
      v_message:=NULL;
      BEGIN
        EXECUTE v_forward;
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
        v_rejected:=v_message IS NOT DISTINCT FROM 'spin expiry lock order: '||v_case.expected_message;
      END;
      PERFORM pg_temp.assert_true(v_rejected,'exact refusal for '||v_case.label||'; received '||COALESCE(v_message,'<none>'));
      PERFORM pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog() IS NOT DISTINCT FROM v_before,
        'transactional refusal with owned DDL exclusion after '||v_case.label);
      -- Roll back the deliberate drift after validating it, retaining no
      -- disabled guard or synthetic financial/provider authority.
      RAISE EXCEPTION 'rollback deliberate catalog drift' USING ERRCODE='PZ001';
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
    END;
    PERFORM pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog()
      IS NOT DISTINCT FROM (SELECT value FROM qualification_original_catalog),
      'restore after '||v_case.label);
    INSERT INTO qualification_catalog_results VALUES(v_case.label,'drift refusal; selected catalog only');
  END LOOP;

  -- A changed body with identical signature/config/ACL must not pass.
  BEGIN
    v_current:=pg_get_functiondef('public.fn_spin_expire_unfilled(integer)'::regprocedure);
    EXECUTE replace(v_current,'AS $function$','AS $function$'||E'\n-- deliberate source drift');
    v_before:=pg_temp.capture_spin_expiry_catalog(); v_rejected:=false; v_message:=NULL;
    BEGIN EXECUTE v_forward;
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
      v_rejected:=v_message IS NOT DISTINCT FROM 'spin expiry lock order: unsupported target drift';
    END;
    PERFORM pg_temp.assert_true(v_rejected,'reject exact-body drift');
    PERFORM pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog() IS NOT DISTINCT FROM v_before,
      'body drift refusal retains source under owned DDL exclusion');
    RAISE EXCEPTION 'rollback deliberate source drift' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
  END;
  INSERT INTO qualification_catalog_results VALUES('target body','drift refusal; selected catalog only');
END;
$drift$;

SELECT pg_temp.assert_true(pg_temp.capture_spin_expiry_catalog()
  IS NOT DISTINCT FROM (SELECT value FROM qualification_original_catalog),'exact final selected catalog');
SELECT label,scope FROM qualification_catalog_results ORDER BY label;
-- This transaction never invokes the business expiry/cancellation authority.
-- Required native race, business rollback, contention and provider controls in
-- the companion design remain unproved even if these catalog checks later pass.
ROLLBACK;
