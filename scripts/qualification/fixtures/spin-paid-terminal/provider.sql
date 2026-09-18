-- Captured current functions in one empty private allocation only. Never a migration.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='1s'; SET LOCAL search_path=public,pg_temp;
\ir ../spin-receipt-lane/boundary.sql
CREATE FUNCTION pg_temp.paid_terminal_function(sig text) RETURNS jsonb LANGUAGE sql STABLE AS $reader$
SELECT jsonb_build_object('signature',sig,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
 'config',p.proconfig,'definition_md5',md5(pg_get_functiondef(p.oid)),
 'volatility',p.provolatile::text,'security_definer',p.prosecdef)
FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||sig) AND p.prokind='f'
$reader$;
CREATE FUNCTION pg_temp.paid_terminal_relation(n text) RETURNS jsonb LANGUAGE sql STABLE AS $reader$
SELECT jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,
 'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
  'default',pg_get_expr(d.adbin,d.adrelid),'notnull',a.attnotnull) ORDER BY a.attnum)
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(x.indexrelid) ORDER BY x.indexrelid::regclass::text) FROM pg_index x WHERE x.indrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles::text,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid))
FROM pg_class c WHERE c.oid=to_regclass('public.'||n)
$reader$;
DO $pre$ DECLARE f jsonb; r jsonb; occupied boolean; BEGIN
IF to_regprocedure('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)'; END IF;
IF to_regprocedure('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)'; END IF;
IF to_regprocedure('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone)'; END IF;
IF to_regprocedure('public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)'; END IF;
IF pg_temp.paid_terminal_function('fn_claim_tournament_finish(uuid,uuid,text)') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_claim_tournament_finish(uuid,uuid,text)","volatility":"v","definition_md5":"9c60ce0e2be89a658fb361713ba6400b","security_definer":true}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: fn_claim_tournament_finish(uuid,uuid,text)'; END IF;
IF to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)'; END IF;
IF to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'; END IF;
IF to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_complete_tournament_launch_atomic(uuid,uuid)'; END IF;
IF to_regprocedure('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'; END IF;
IF to_regprocedure('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'; END IF;
IF to_regprocedure('public.fn_spin_draw_and_settle(uuid,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_spin_draw_and_settle(uuid,jsonb)'; END IF;
IF to_regprocedure('public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)'; END IF;
IF to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: claim_tournament_lease_v2(uuid,text,text,uuid,integer)'; END IF;
IF pg_temp.paid_terminal_function('fn_entry_purchases_frozen()') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_entry_purchases_frozen()","volatility":"v","definition_md5":"0b05e2e7905caf71f14c8327a172cea0","security_definer":false}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: fn_entry_purchases_frozen()'; END IF;
IF pg_temp.paid_terminal_function('fn_lock_tournament_launch_proof_parents(uuid[])') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_lock_tournament_launch_proof_parents(uuid[])","volatility":"v","definition_md5":"77e46e6a692bfadfa5537fe634791b9f","security_definer":true}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: fn_lock_tournament_launch_proof_parents(uuid[])'; END IF;
IF to_regprocedure('public.fn_prove_played_launch_recovery(uuid,timestamp with time zone)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_prove_played_launch_recovery(uuid,timestamp with time zone)'; END IF;
IF to_regprocedure('public.fn_prove_played_spin_launch_recovery(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_prove_played_spin_launch_recovery(uuid)'; END IF;
IF to_regprocedure('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'; END IF;
IF pg_temp.paid_terminal_function('fn_tournament_finish_kind(uuid)') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_tournament_finish_kind(uuid)","volatility":"s","definition_md5":"d1639c3dbf37ecea874c2feea027a0e6","security_definer":true}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: fn_tournament_finish_kind(uuid)'; END IF;
IF pg_temp.paid_terminal_function('trg_spin_draw_receipt_is_immutable()') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_spin_draw_receipt_is_immutable()","volatility":"v","definition_md5":"b3e3935c8d7461f8116aedc11338a92d","security_definer":false}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: trg_spin_draw_receipt_is_immutable()'; END IF;
IF pg_temp.paid_terminal_function('trg_tournament_launch_receipt_is_immutable()') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_tournament_launch_receipt_is_immutable()","volatility":"v","definition_md5":"358ac44d59d7c70a2aa40c73e138d4f5","security_definer":false}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: trg_tournament_launch_receipt_is_immutable()'; END IF;
IF pg_temp.paid_terminal_function('fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"signature":"fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])","volatility":"v","definition_md5":"1991d9f52317f33a4b9cf560d6fc91d5","security_definer":false}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'; END IF;
IF pg_temp.paid_terminal_function('fn_spin_move_owner_wallet(uuid,text,text,numeric)') IS DISTINCT FROM $capture${"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_spin_move_owner_wallet(uuid,text,text,numeric)","volatility":"v","definition_md5":"a15c8e34a74125cb46406bc6ebb4ba42","security_definer":true}$capture$::jsonb THEN RAISE EXCEPTION 'modern launch preimage differs: fn_spin_move_owner_wallet(uuid,text,text,numeric)'; END IF;
IF to_regprocedure('public.fn_spin_seed_instalment(numeric,numeric,numeric)') IS NOT NULL THEN RAISE EXCEPTION 'modern launch preimage differs: fn_spin_seed_instalment(numeric,numeric,numeric)'; END IF;
FOR r IN SELECT value FROM jsonb_array_elements($capture$[{"acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"name":"engine_tournament_leases","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"instance_id","type":"text","default":null,"notnull":true},{"name":"engine_version","type":"text","default":null,"notnull":false},{"name":"acquired_at","type":"timestamp with time zone","default":"now()","notnull":true},{"name":"heartbeat_at","type":"timestamp with time zone","default":"now()","notnull":true},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true},{"name":"protocol_version","type":"integer","default":"1","notnull":true}],"indexes":["CREATE UNIQUE INDEX engine_tournament_leases_pkey ON public.engine_tournament_leases USING btree (tournament_id)","CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at)"],"policies":null,"force_rls":false,"constraints":[{"name":"engine_tournament_leases_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"engine_tournament_leases_protocol_version_check","definition":"CHECK ((protocol_version = ANY (ARRAY[1, 2])))"},{"name":"engine_tournament_leases_tournament_id_fkey","definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"spin_draw_receipts","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"launch_id","type":"uuid","default":null,"notnull":true},{"name":"lease_generation","type":"uuid","default":null,"notnull":true},{"name":"rule_manifest","type":"jsonb","default":null,"notnull":true},{"name":"rule_sha256","type":"text","default":null,"notnull":true},{"name":"entrants","type":"jsonb","default":null,"notnull":true},{"name":"receipt","type":"jsonb","default":null,"notnull":true},{"name":"created_at","type":"timestamp with time zone","default":"transaction_timestamp()","notnull":true}],"indexes":["CREATE UNIQUE INDEX spin_draw_receipts_pkey ON public.spin_draw_receipts USING btree (tournament_id)"],"policies":null,"force_rls":false,"constraints":[{"name":"spin_draw_receipts_entrants_check","definition":"CHECK ((jsonb_array_length(entrants) = 3))"},{"name":"spin_draw_receipts_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"spin_draw_receipts_rule_sha256_check","definition":"CHECK ((rule_sha256 ~ '^[0-9a-f]{64}$'::text))"}]},{"acl":"{postgres=arwdDxtm/postgres}","rls":true,"name":"tournament_launch_receipts","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"launch_id","type":"uuid","default":null,"notnull":true},{"name":"started_at","type":"timestamp with time zone","default":null,"notnull":true},{"name":"claimed_at","type":"timestamp with time zone","default":"transaction_timestamp()","notnull":true},{"name":"completed_at","type":"timestamp with time zone","default":null,"notnull":false},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true},{"name":"supply_version","type":"smallint","default":"0","notnull":true}],"indexes":["CREATE UNIQUE INDEX tournament_launch_receipts_launch_id_key ON public.tournament_launch_receipts USING btree (launch_id)","CREATE UNIQUE INDEX tournament_launch_receipts_pkey ON public.tournament_launch_receipts USING btree (tournament_id)"],"policies":null,"force_rls":false,"constraints":[{"name":"tournament_launch_receipts_launch_id_key","definition":"UNIQUE (launch_id)"},{"name":"tournament_launch_receipts_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"tournament_launch_receipts_supply_version_check","definition":"CHECK ((supply_version = 0))"},{"name":"tournament_launch_receipts_tournament_id_fkey","definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT"}]}]$capture$::jsonb) LOOP
 -- The original isolated snapshot lacks this one captured ordinary index.
 -- Match the entire exact preimage before restoring it; the postcheck below
 -- still requires every captured production index and all original metadata.
 IF r->>'name'='engine_tournament_leases' THEN
  r := jsonb_set(r,'{indexes}',r->'indexes' - 'CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at)');
  IF to_regclass('public.idx_engine_tournament_leases_heartbeat') IS NOT NULL THEN
   RAISE EXCEPTION 'modern launch index preimage differs'; END IF;
 END IF;
 IF pg_temp.paid_terminal_relation(r->>'name') IS DISTINCT FROM r THEN RAISE EXCEPTION 'modern launch relation differs: %',r->>'name' USING DETAIL=jsonb_build_object('expected',r,'actual',pg_temp.paid_terminal_relation(r->>'name'))::text; END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',r->>'name') INTO occupied;
 IF occupied THEN RAISE EXCEPTION 'modern launch requires empty relation: %',r->>'name'; END IF; END LOOP;
END $pre$;
CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at);
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone, p_lease_generation uuid, p_expected_format text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF p_expected_format IS DISTINCT FROM v_format THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_mismatch','format_contract',v_format);
  END IF;

  v_result := public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false)
     AND NOT COALESCE((v_result ->> 'completed')::boolean, false) THEN
    SELECT r.lease_generation INTO STRICT v_receipt_generation
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = p_tournament_id
     FOR UPDATE;
    IF v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config(
        'app.atomic_tournament_launch_lease_adoption',
        p_tournament_id::text || ':' || v_receipt_generation::text || ':' || p_lease_generation::text,
        true
      );
      UPDATE public.tournament_launch_receipts r
         SET lease_generation = p_lease_generation
       WHERE r.tournament_id = p_tournament_id
         AND r.completed_at IS NULL
         AND r.lease_generation = v_receipt_generation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;
ALTER FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  v_result := public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false)
     AND NOT COALESCE((v_result ->> 'completed')::boolean, false) THEN
    SELECT r.lease_generation INTO STRICT v_receipt_generation
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = p_tournament_id
     FOR UPDATE;
    IF v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config(
        'app.atomic_tournament_launch_lease_adoption',
        p_tournament_id::text || ':' || v_receipt_generation::text || ':' || p_lease_generation::text,
        true
      );
      UPDATE public.tournament_launch_receipts r
         SET lease_generation = p_lease_generation
       WHERE r.tournament_id = p_tournament_id
         AND r.completed_at IS NULL
         AND r.lease_generation = v_receipt_generation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;
ALTER FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_protocol_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  SELECT l.protocol_version INTO v_protocol_version
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_launch_protocol_closed');
  END IF;
  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  RETURN (public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  )) || jsonb_build_object('format_contract',v_format);
END;
$function$;
ALTER FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_before_lease_generation(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_existing public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_tournament_started_at timestamptz;
  v_requested_started_at timestamptz := COALESCE(p_started_at, transaction_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_tournament_id IS NULL OR p_launch_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT * INTO v_existing
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    IF p_started_at IS NOT NULL
       AND v_existing.launch_id = p_launch_id
       AND v_existing.started_at IS DISTINCT FROM p_started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_request_mismatch');
    END IF;
    SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND
       OR (v_existing.completed_at IS NULL AND v_status <> 'REGISTERING')
       OR (v_existing.completed_at IS NOT NULL
           AND (v_status <> 'RUNNING'
                OR v_tournament_started_at IS DISTINCT FROM v_existing.started_at)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', true,
      'launch_id', v_existing.launch_id,
      'replay', true,
      'started_at', v_existing.started_at,
      'completed', v_existing.completed_at IS NOT NULL,
      'status', v_status
    );
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_status <> 'REGISTERING' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_status_changed',
      'status', v_status
    );
  END IF;
  IF v_tournament_started_at IS NOT NULL
     AND v_tournament_started_at IS DISTINCT FROM v_requested_started_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_started_at_mismatch');
  END IF;

  INSERT INTO public.tournament_launch_receipts (
    tournament_id, launch_id, started_at
  ) VALUES (
    p_tournament_id, p_launch_id, v_requested_started_at
  );

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'launch_id', p_launch_id,
    'replay', false,
    'started_at', v_requested_started_at,
    'completed', false
  );
END;
$function$;
ALTER FUNCTION public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone) TO postgres;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_expected_format text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_receipt_launch_id uuid;
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  SELECT r.launch_id, r.lease_generation
    INTO v_receipt_launch_id, v_receipt_generation
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_receipt_launch_id IS DISTINCT FROM p_launch_id
     OR v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF p_expected_format IS DISTINCT FROM v_format THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_mismatch','format_contract',v_format);
  END IF;

  v_result := public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;
ALTER FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_receipt_launch_id uuid;
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  SELECT r.launch_id, r.lease_generation
    INTO v_receipt_launch_id, v_receipt_generation
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_receipt_launch_id IS DISTINCT FROM p_launch_id
     OR v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  v_result := public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;
ALTER FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_protocol_version integer;
BEGIN
  SELECT l.protocol_version INTO v_protocol_version
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_launch_protocol_closed');
  END IF;
  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  RETURN (public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  )) || jsonb_build_object('format_contract',v_format);
END;
$function$;
ALTER FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_before_lease_generation(p_tournament_id uuid, p_launch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_receipt public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_started_at timestamptz;
  v_completed_at timestamptz := transaction_timestamp();
  v_required_field integer;
  v_active_count bigint;
  v_bad_roster_count bigint;
  v_live_seat_count bigint;
  v_bad_live_seat_count bigint;
  v_distinct_live_users bigint;
  v_distinct_live_coordinates bigint;
  v_matching_roster_seats bigint;
  v_bad_table_count bigint;
  v_live_table_count bigint;
  v_is_paid_spin boolean;
  v_spin_multiplier numeric;
  v_spin_ledger_count bigint;
  v_spin_ledger_multiplier numeric;
BEGIN
  SELECT * INTO v_receipt
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_receipt.launch_id <> p_launch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;
  IF v_receipt.completed_at IS NOT NULL THEN
    SELECT t.status, t.started_at INTO v_status, v_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id;
    IF NOT FOUND OR v_status <> 'RUNNING'
       OR v_started_at IS DISTINCT FROM v_receipt.started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'completed', true,
      'replay', true,
      'status', v_status,
      'started_at', v_started_at,
      'completed_at', v_receipt.completed_at
    );
  END IF;

  SELECT t.status,
         t.started_at,
         CASE WHEN t.format_contract='mtt-v1' THEN GREATEST(2,COALESCE(t.min_players,2))
              WHEN t.format_contract='mtt-v2' THEN GREATEST(3,COALESCE(t.min_players,3))
              WHEN COALESCE(t.max_players,0)>0 THEN GREATEST(2,LEAST(3,t.max_players))
              ELSE 3 END,
         ((lower(COALESCE(t.variant, '')) = 'spin'
           OR upper(COALESCE(t.tournament_type, '')) = 'SPIN')
          AND COALESCE(t.buy_in_amount, 0) > 0),
         t.spin_multiplier
    INTO v_status, v_started_at, v_required_field,
         v_is_paid_spin, v_spin_multiplier
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_status <> 'REGISTERING'
     OR (v_started_at IS NOT NULL AND v_started_at IS DISTINCT FROM v_receipt.started_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;

  /* Completion is the status transaction, so it owns the final database
     proof too. Every registration/admission path locks this tournament row:
     one that committed first is visible here and makes completion refuse;
     one waiting behind us observes RUNNING and rolls back. This removes the
     proof-to-complete race that no sequence of client reads can close. */
  SELECT count(*),
         count(*) FILTER (
           WHERE p.status <> 'playing'
              OR p.user_id IS NULL
              OR COALESCE(p.chips, 0) < 0
              OR p.table_id IS NULL
              OR p.seat_number IS NULL
              OR p.seat_number <= 0
         )
    INTO v_active_count, v_bad_roster_count
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');

  IF (SELECT COALESCE(sum(p2.chips), 0)
         FROM public.tournament_players p2
        WHERE p2.tournament_id = p_tournament_id
          AND p2.status IN ('registered', 'playing'))
      < v_active_count * COALESCE(
          (SELECT t2.starting_chips FROM public.tournaments t2
            WHERE t2.id = p_tournament_id), 0)
     OR (SELECT COALESCE(sum(s2.stack), 0)
           FROM public.table_seats s2
           JOIN public.tables t3 ON t3.id = s2.table_id
          WHERE t3.tournament_id = p_tournament_id
            AND s2.left_at IS NULL)
        < v_active_count * COALESCE(
            (SELECT t2.starting_chips FROM public.tournaments t2
              WHERE t2.id = p_tournament_id), 0) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_stacks_uncredited',
      'active_players', v_active_count
    );
  END IF;

  IF v_is_paid_spin AND v_active_count = 2
     AND COALESCE(
       (public.fn_prove_played_spin_launch_recovery(p_tournament_id)->>'ok')::boolean,
       false
     ) THEN
    v_required_field := 2;
  END IF;

  /* A GAME THAT WAS DEALT FINISHES WITH THE FIELD IT HAS (2026-09-11). The
     narrow escape above covers a paid spin with exactly two survivors. Forty
     games dealt on 2026-09-08 lost their engine before this commit and have
     been stuck in REGISTERING since, decided, winners unpaid, because the
     field they now hold can never satisfy a proof written for a field that has
     not played yet. fn_prove_played_launch_recovery generalises the same
     evidence: the pool is finalized, hands were dealt, THIS receipt's
     started_at is the moment of the first one, nobody is sitting in a pre-deal
     status, the field that was dealt met the requirement, and every survivor
     holds a live seat. A fresh under-filled game has no hand and is refused at
     the second check, so this can never open the door early. */
  IF v_active_count < v_required_field
     AND COALESCE(
       (public.fn_prove_played_launch_recovery(
          p_tournament_id, v_receipt.started_at)->>'ok')::boolean,
       false
     ) THEN
    v_required_field := v_active_count;
  END IF;

  IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_roster_unproven',
      'active_players', v_active_count,
      'required_players', v_required_field,
      'invalid_players', v_bad_roster_count
    );
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE s.user_id IS NULL
              OR COALESCE(s.stack, 0) < 0
              OR s.seat_number IS NULL
              OR s.seat_number <= 0
              OR s.seat_number > COALESCE(t.max_players, 0)
         ),
         count(DISTINCT s.user_id),
         count(DISTINCT (s.table_id, s.seat_number))
    INTO v_live_seat_count, v_bad_live_seat_count,
         v_distinct_live_users, v_distinct_live_coordinates
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id
   WHERE t.tournament_id = p_tournament_id
     AND s.left_at IS NULL;

  SELECT count(*) INTO v_matching_roster_seats
    FROM public.tournament_players p
    JOIN public.table_seats s
      ON s.user_id = p.user_id
     AND s.table_id = p.table_id
     AND s.seat_number = p.seat_number
     AND s.left_at IS NULL
    JOIN public.tables t
      ON t.id = s.table_id
     AND t.tournament_id = p_tournament_id
   WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');

  IF v_live_seat_count <> v_active_count
     OR v_bad_live_seat_count <> 0
     OR v_distinct_live_users <> v_active_count
     OR v_distinct_live_coordinates <> v_active_count
     OR v_matching_roster_seats <> v_active_count THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_seats_unproven',
      'active_players', v_active_count,
      'live_seats', v_live_seat_count,
      'matching_seats', v_matching_roster_seats
    );
  END IF;

  /* A CLOSED TABLE IS HISTORY, NOT A BROKEN ONE (2026-09-11). This scan had no
     status filter, so every table a multi-table event had already broken and
     closed - empty by definition, and 'closed' by definition - counted as an
     invalid table and refused the completion. A fresh launch has no closed
     table, so nothing about a first launch changes; what changes is that an
     event which has been playing and consolidating can complete a launch its
     engine never committed. Measured on "Breakfast Turbo" (2026-09-08): tables
     1, 2 and 4 closed with 58, 27 and 49 hands behind them, table 3 running
     with 2 seats and current_players 2, and the whole completion refused for
     the three that had done their job. The live table count is asserted
     separately below so an event whose tables are ALL closed cannot pass this
     vacuously; the seat proof above is independent of both. */
  SELECT count(*) FILTER (
           WHERE seats.table_id IS NULL
              OR t.status NOT IN ('running', 'waiting')
              OR t.current_players IS DISTINCT FROM seats.live_count
         ),
         count(*)
    INTO v_bad_table_count, v_live_table_count
    FROM public.tables t
    LEFT JOIN (
      SELECT s.table_id, count(*) AS live_count
        FROM public.table_seats s
       WHERE s.left_at IS NULL
       GROUP BY s.table_id
    ) seats ON seats.table_id = t.id
   WHERE t.tournament_id = p_tournament_id
     AND t.status <> 'closed';

  IF v_bad_table_count <> 0 OR v_live_table_count < 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_tables_unproven',
      'invalid_tables', v_bad_table_count,
      'live_tables', v_live_table_count
    );
  END IF;

  IF v_is_paid_spin THEN
    SELECT count(*), min(l.multiplier)
      INTO v_spin_ledger_count, v_spin_ledger_multiplier
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind = 'jackpot_draw';
    IF v_spin_ledger_count <> 1
       OR COALESCE(v_spin_multiplier, 0) <= 0
       OR v_spin_ledger_multiplier IS DISTINCT FROM v_spin_multiplier THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'launch_spin_settlement_unproven',
        'draw_rows', v_spin_ledger_count
      );
    END IF;
  END IF;

  PERFORM set_config(
    'app.atomic_tournament_launch',
    p_tournament_id::text || ':' || p_launch_id::text,
    true
  );
  UPDATE public.tournaments
     SET status = 'RUNNING',
         started_at = v_receipt.started_at
   WHERE id = p_tournament_id
     AND status = 'REGISTERING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament launch status changed inside its completion transaction'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tournament_launch_receipts
     SET completed_at = v_completed_at
   WHERE tournament_id = p_tournament_id
     AND launch_id = p_launch_id
     AND completed_at IS NULL;
  RETURN jsonb_build_object(
    'ok', true,
    'completed', true,
    'replay', false,
    'status', 'RUNNING',
    'started_at', v_receipt.started_at,
    'completed_at', v_completed_at
  );
END;
$function$;
ALTER FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid) TO postgres;
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_rule_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_lease public.engine_tournament_leases%ROWTYPE;
  v_launch public.tournament_launch_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_saved public.spin_draw_receipts%ROWTYPE;
  v_player record;
  v_entrants jsonb;
  v_paid numeric;
  v_entitled numeric;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_gross numeric;
  v_manifest jsonb;
  v_hash text;
  v_tier jsonb;
  v_draw jsonb;
  v_settle jsonb;
  v_entry jsonb;
  v_receipt jsonb;
  v_multiplier numeric;
  v_prize numeric;
  v_count bigint;
  v_covered numeric;
  v_provenance text := 'at_draw';
  v_blinds jsonb;
  v_payouts jsonb;
  v_locked jsonb;
  v_freq numeric;
  v_weight numeric;
  v_played_recovery boolean := false;
  v_recovery jsonb;
  v_stamped integer;                                                  -- D2
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  SELECT * INTO v_lease FROM public.engine_tournament_leases
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_lease.protocol_version IS DISTINCT FROM 2
     OR v_lease.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_lease.heartbeat_at IS NULL
     OR v_lease.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  -- Same receipt -> parent order as registration, launch and cancellation.
  PERFORM * FROM public.fn_lock_tournament_launch_proof_parents(ARRAY[p_tournament_id]);
  SELECT * INTO v_launch FROM public.tournament_launch_receipts
   WHERE tournament_id = p_tournament_id;
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF v_launch.launch_id IS DISTINCT FROM p_launch_id
     OR v_launch.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_launch.completed_at IS NOT NULL
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_purchases_frozen');
  END IF;
  IF v_t.variant IS DISTINCT FROM 'spin' OR v_t.max_players IS DISTINCT FROM 3
     OR COALESCE(v_t.buy_in_amount, 0) <= 0
     OR COALESCE(v_t.buy_in_fee, 0) <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_spin_contract');
  END IF;

  SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
           'user_id', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_entrants
    FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');

  -- A dealt Spin may have one proven busted/vacated original seat. This does
  -- not lower the fresh-launch field: the proof requires the original three
  -- paid identities, immutable money journals, a persisted hand, two exact
  -- live seats and conservation of all three bought starting stacks.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>'ok')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
               'user_id', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id
         AND p.status IN ('playing', 'eliminated');
    END IF;
  END IF;

  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND (p.status IN ('registered', 'playing')
            OR (v_played_recovery AND p.status = 'eliminated'))) <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_field_unproven');
  END IF;

  -- Spin admission proves net paid entries directly. The generic refund
  -- planner compares advertised entry fees with escrow.fee_entries_in, but
  -- Spin escrow records its embedded 8% rake there despite buy_in_fee=0.
  -- A payout/refund policy comparison cannot stand in for this payment proof.
  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  SELECT COALESCE(sum(w.amount), 0) INTO v_wallet_gross
    FROM public.wallet_transactions w WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit' AND lower(w.category) = 'tournament_buyin';
  IF v_escrow.tournament_id IS NULL OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_entry_escrow_unproven');
  END IF;
  FOR v_player IN SELECT p.user_id FROM public.tournament_players p
    WHERE p.tournament_id = p_tournament_id
      AND (p.status IN ('registered', 'playing')
           OR (v_played_recovery AND p.status = 'eliminated'))
    ORDER BY p.user_id LOOP
    -- The wallet receipt proves what this player still paid, including any
    -- prior refund. Immutable entitlements independently prove the original
    -- debit's exact wallet -> tournament double-entry leg and its consumption.
    SELECT COALESCE(sum(CASE
      WHEN w.type='debit' AND lower(w.category)='tournament_buyin' THEN w.amount
      WHEN w.type='credit' AND lower(w.category) IN ('refund','tournament_refund') THEN -w.amount
      ELSE 0 END), 0) INTO v_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_player.user_id;
    SELECT COALESCE(sum(e.gross), 0) INTO v_entitled
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
       AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross
       AND l.tournament_id=e.tournament_id AND l.from_type='player_wallet'
       AND l.from_entity_id=e.user_id AND l.to_type='prize_liability'
       AND l.to_entity_id=e.tournament_id AND lower(l.category)=e.charge_category
     WHERE e.tournament_id=p_tournament_id AND e.user_id=v_player.user_id
       AND e.entitlement_kind='wallet_charge' AND e.charge_category='tournament_buyin'
       AND e.refund_fee=0 AND e.refund_bounty=0
       AND NOT EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=e.id);
    IF v_paid IS DISTINCT FROM v_t.buy_in_amount OR v_entitled IS DISTINCT FROM v_paid THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
  END LOOP;

  SELECT * INTO v_saved FROM public.spin_draw_receipts WHERE tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_saved.launch_id IS DISTINCT FROM p_launch_id
       OR v_saved.entrants IS DISTINCT FROM v_entrants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_receipt_roster_mismatch');
    END IF;
    -- A new owner or newer rules cannot reroll or rewrite a committed result.
    RETURN v_saved.receipt || jsonb_build_object('replay', true);
  END IF;

  SELECT count(*), min(l.multiplier), min(-l.amount)
    INTO v_count, v_multiplier, v_covered FROM public.spin_reserve_ledger l
   WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw';
  IF v_count > 0 THEN
    -- Cutover recovery uses the already projected rules. It does not pretend
    -- that a historical probability snapshot exists or replace it with today's.
    v_prize := round(v_t.buy_in_amount * v_multiplier, 2);
    IF v_count <> 1 OR v_multiplier IS DISTINCT FROM v_t.spin_multiplier
       OR v_covered IS DISTINCT FROM v_prize OR COALESCE(v_multiplier, 0) <= 0
       OR jsonb_typeof(v_t.blind_structure::jsonb) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_t.blind_structure::jsonb) = 0
       OR jsonb_typeof(v_t.payout_structure::jsonb) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_t.payout_structure::jsonb) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'legacy_spin_rules_unproven');
    END IF;
    v_provenance := 'legacy_projection';
    v_blinds := v_t.blind_structure::jsonb;
    v_payouts := v_t.payout_structure::jsonb;
    v_locked := COALESCE(v_t.spin_locked_tiers::jsonb, '[]'::jsonb);
    v_manifest := jsonb_build_object('version', 1, 'probability_snapshot', NULL,
      'buy_in', v_t.buy_in_amount, 'seats', 3, 'starting_chips', v_t.starting_chips,
      'multiplier', v_multiplier, 'blind_structure', v_blinds, 'payout_structure', v_payouts);
    v_settle := jsonb_build_object('pool_covered', v_covered, 'operator_shortfall', 0);
  ELSE
    -- D1 (C-stuck-spins): tournaments.spin_multiplier has DEFAULT 0 and the
    -- seat-first creator omits the column, so 0 is "undrawn" exactly as NULL
    -- is. Every other reader on the platform already uses COALESCE(...,0).
    -- A drawn multiplier is never 0 (all tiers >= 2; fn_spin_settle_game
    -- rejects <= 0). Only a POSITIVE projection without a funded draw is the
    -- case this refusal exists for.
    IF COALESCE(v_t.spin_multiplier, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'projected_spin_draw_has_no_funding_proof');
    END IF;
    v_manifest := p_rule_manifest;
    IF v_manifest IS NULL OR (v_manifest->>'version')::int IS DISTINCT FROM 1
       OR (v_manifest->>'buy_in')::numeric IS DISTINCT FROM v_t.buy_in_amount
       OR (v_manifest->>'seats')::int IS DISTINCT FROM 3
       OR (v_manifest->>'starting_chips')::int IS DISTINCT FROM v_t.starting_chips
       OR (v_manifest->>'rake_rate')::numeric IS DISTINCT FROM public.fn_spin_rake_rate(v_t.buy_in_amount)
       OR jsonb_typeof(v_manifest->'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_manifest->'tiers') = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
    END IF;
    v_manifest := v_manifest || jsonb_build_object('draw_function_md5',
      md5(pg_get_functiondef('public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)'::regprocedure)));
    v_freq := 0; v_weight := 0;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_manifest->'tiers') LOOP
      IF jsonb_typeof(v_tier->'freq') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_tier->'multiplier') IS DISTINCT FROM 'number'
         OR COALESCE((v_tier->>'freq')::numeric, 0) <= 0
         OR COALESCE((v_tier->>'multiplier')::numeric, 0) <= 0
         OR COALESCE((v_tier->>'reserveThresholdX')::numeric, -1) < 0
         OR jsonb_typeof(v_tier->'blind_structure') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_tier->'blind_structure') <> 12
         OR (v_tier#>>'{blind_structure,11,spinContinuation,version}')::int IS DISTINCT FROM 1
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,anchorLevel}')::numeric, 0) <= 0
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,anchorBigBlind}')::numeric, 0) <= 0
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,growth}')::numeric, 0) <= 1
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,roundBigTo}')::numeric, 0) <= 0
         OR jsonb_typeof(v_tier->'payout_structure') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_tier->'payout_structure') NOT BETWEEN 1 AND 3
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_tier->'blind_structure') WITH ORDINALITY b(value, ordinal)
            WHERE (b.value->>'level')::numeric IS DISTINCT FROM b.ordinal::numeric
               OR COALESCE((b.value->>'smallBlind')::numeric, 0) <= 0
               OR COALESCE((b.value->>'bigBlind')::numeric, 0) < (b.value->>'smallBlind')::numeric
               OR COALESCE((b.value->>'duration')::numeric, 0) <= 0
               OR (b.value->>'ante')::numeric IS DISTINCT FROM 0::numeric)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_tier->'payout_structure') WITH ORDINALITY p(value, ordinal)
            WHERE (p.value->>'place')::numeric IS DISTINCT FROM p.ordinal::numeric
               OR COALESCE((p.value->>'percentage')::numeric, 0) <= 0)
         OR (SELECT sum((x->>'percentage')::numeric)
               FROM jsonb_array_elements(v_tier->'payout_structure') x) IS DISTINCT FROM 100::numeric THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
      END IF;
      v_freq := v_freq + (v_tier->>'freq')::numeric;
      v_weight := v_weight + (v_tier->>'freq')::numeric * (v_tier->>'multiplier')::numeric;
    END LOOP;
    IF v_weight <> v_freq * 3 * (1 - (v_manifest->>'rake_rate')::numeric)
       OR (SELECT count(DISTINCT x->>'multiplier') FROM jsonb_array_elements(v_manifest->'tiers') x)
           <> jsonb_array_length(v_manifest->'tiers') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
    END IF;

    -- Entry owns escrow -> entry advisory -> reserve locks. Its committed net
    -- contribution must be present before the affordability gate is evaluated.
    v_entry := public.fn_spin_book_entry(p_tournament_id);
    IF NOT COALESCE((v_entry->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin entry booking failed: %', v_entry USING ERRCODE = 'P0404';
    END IF;
    IF (SELECT count(*) FROM public.spin_reserve_ledger l
         WHERE l.tournament_id=p_tournament_id AND l.kind='contribution') <> 1
       OR NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
         WHERE l.tournament_id=p_tournament_id AND l.kind='contribution'
           AND l.club_id=public.fn_spin_reserve_pool(v_t.club_id)
           AND l.seats=3 AND l.buy_in=v_t.buy_in_amount
           AND l.house_rake=round(3*v_t.buy_in_amount*(v_manifest->>'rake_rate')::numeric, 2)
           AND l.amount=round(3*v_t.buy_in_amount, 2)-l.house_rake) THEN
      RAISE EXCEPTION 'Spin contribution does not prove the three funded entries' USING ERRCODE = 'P0404';
    END IF;
    -- Zero hypothetical seats: all three paid entries are already in balance.
    -- The draw's pool row lock remains held through settlement and the receipt.
    v_draw := public.fn_spin_draw_multiplier(v_t.club_id, v_t.buy_in_amount,
      v_manifest->'tiers', (v_manifest->>'rake_rate')::numeric, 0);
    IF NOT COALESCE((v_draw->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin funded draw unavailable: %', v_draw USING ERRCODE = 'P0404';
    END IF;
    v_multiplier := (v_draw->>'multiplier')::numeric;
    v_prize := round(v_t.buy_in_amount * v_multiplier, 2);
    SELECT value INTO STRICT v_tier FROM jsonb_array_elements(v_manifest->'tiers')
     WHERE (value->>'multiplier')::numeric = v_multiplier;
    v_blinds := v_tier->'blind_structure';
    v_payouts := v_tier->'payout_structure';
    v_locked := COALESCE(v_draw->'locked', '[]'::jsonb);
    v_settle := public.fn_spin_settle_game(p_tournament_id, v_t.club_id,
      v_t.buy_in_amount, 3, v_multiplier, (v_manifest->>'rake_rate')::numeric);
    IF NOT COALESCE((v_settle->>'ok')::boolean, false)
       OR (v_settle->>'pool_covered')::numeric IS DISTINCT FROM v_prize
       OR COALESCE((v_settle->>'operator_shortfall')::numeric, 0) <> 0
       OR v_settle->>'reason' = 'already_settled' THEN
      -- Raising rolls back entry, draw and any transitive escrow write too.
      RAISE EXCEPTION 'Spin settlement does not prove the selected funded prize: %', v_settle
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_hash := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  v_receipt := v_settle || jsonb_build_object('ok', true, 'replay', false,
    'tournament_id', p_tournament_id, 'launch_id', p_launch_id,
    'multiplier', v_multiplier, 'prize_pool', v_prize, 'buy_in', v_t.buy_in_amount,
    'starting_chips', v_t.starting_chips, 'blind_structure', v_blinds,
    'payout_structure', v_payouts, 'locked', v_locked, 'entrants', v_entrants,
    'rule_manifest', v_manifest, 'rule_sha256', v_hash, 'rule_provenance', v_provenance,
    'draw_inputs', v_draw);
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,
    rule_manifest, rule_sha256, entrants, receipt)
  VALUES (p_tournament_id, p_launch_id, p_lease_generation, v_manifest, v_hash, v_entrants, v_receipt);

  -- D2 (C-stuck-spins): the tournament row is the contract the engine, the
  -- ladder trigger and proveTournamentLaunchSetup read back. The retired
  -- fn_spin_draw_and_settle stamped it; the atomic authority must too, in the
  -- same transaction as the draw. spin_tournament_contract_is_draw proves the
  -- stamp equals the one jackpot_draw; zzz_spin_ladder_is_the_drawn_one proves
  -- it equals the receipt just written. A legacy_projection row is already
  -- stamped (the branch required equality), so this is a no-op there.
  IF v_provenance = 'at_draw' THEN
    UPDATE public.tournaments
       SET spin_multiplier   = v_multiplier,
           prize_pool        = v_prize,
           spin_locked_tiers = v_locked,
           blind_structure   = v_blinds::text,
           payout_structure  = v_payouts::text
     WHERE id = p_tournament_id;
    -- NOT is_premium_spin: fn_satellite_target_contract_is_immutable freezes it
    -- once entry_contract_locked (true on every funded Spin). The engine's own
    -- presentation patch sets it for a 100x draw (TournamentManagerBase.ts:3445)
    -- and would be refused there — a separate, rare (0.01%) defect, out of scope.
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
    IF v_stamped <> 1 OR NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id = p_tournament_id
            AND t.spin_multiplier IS NOT DISTINCT FROM v_multiplier
            AND t.prize_pool IS NOT DISTINCT FROM v_prize
            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked) THEN
      RAISE EXCEPTION 'Spin % tournament contract did not read back exactly', p_tournament_id
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle(p_tournament_id uuid, p_tiers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_table_id uuid;
  v_paid_seats integer;
  v_seat_users integer;
  v_exact_seat_stacks integer;
  v_paid_users integer;
  v_roster_users integer;
  v_exact_roster_stacks integer;
  v_buyin_debits integer;
  v_buyin_total numeric;
  v_book jsonb;
  v_settle jsonb;
  v_owner uuid;
  v_pool_id uuid;
  v_available numeric;
  v_highest_stake numeric;
  v_rake_rate numeric;
  v_reserve_in numeric;
  v_tier jsonb;
  v_multiplier numeric;
  v_frequency numeric;
  v_threshold numeric;
  v_prize numeric;
  v_total numeric := 0;
  v_roll numeric;
  v_acc numeric := 0;
  v_pick numeric := NULL;
  v_eligible jsonb := '[]'::jsonb;
  v_locked jsonb := '[]'::jsonb;
  v_seen numeric[] := ARRAY[]::numeric[];
  v_booked_multiplier numeric;
  v_booked_draw numeric;
  v_leg_count integer;
  v_draw_existed boolean := false;
  v_entry_reserve_id uuid;
  v_entry_journal_id uuid;
  v_draw_reserve_id uuid;
  v_draw_journal_id uuid;
  v_escrow_reserve_out numeric;
  v_escrow_reserve_in numeric;
  v_escrow_prize_balance numeric;
  v_row_count integer;
  v_draw_key text := 'spin:' || p_tournament_id::text || ':draw';
  -- Product economics live inside the money authority. The service still
  -- submits its compiled copy during the rolling cutover, but a drifted or
  -- alternate service caller cannot change RTP, the ladder, or reserve gates.
  v_canonical_tiers constant jsonb := '[
    {"multiplier":2,"freq":4809776,"reserveThresholdX":0},
    {"multiplier":3,"freq":3930716,"reserveThresholdX":0},
    {"multiplier":4,"freq":900000,"reserveThresholdX":0},
    {"multiplier":5,"freq":250000,"reserveThresholdX":0},
    {"multiplier":10,"freq":100000,"reserveThresholdX":0},
    {"multiplier":25,"freq":7500,"reserveThresholdX":0},
    {"multiplier":50,"freq":1000,"reserveThresholdX":0},
    {"multiplier":100,"freq":1008,"reserveThresholdX":1.5}
  ]'::jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Spin draw-and-settle requires a tournament'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant,
         t.tournament_type, t.status, t.spin_multiplier, t.prize_pool,
         t.spin_locked_tiers, t.starting_chips
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spin tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) <> 'spin'
     AND upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN' THEN
    RAISE EXCEPTION 'tournament % is not a Spin', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_t.club_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = '00000000-0000-0000-0000-000000000000'::uuid
     OR COALESCE(v_t.buy_in_amount,0) <= 0
     OR COALESCE(v_t.max_players,0) <> 3
     OR v_t.starting_chips IS NULL
     OR v_t.starting_chips::text IN ('NaN','Infinity','-Infinity')
     OR v_t.starting_chips <= 0 THEN
    RAISE EXCEPTION 'Spin % has invalid club, buy-in, seat or starting-stack contract',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'Spin % cannot draw from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;

  -- Decide admission versus replay while the tournament row is locked. No
  -- other draw authority can cross that row lock. A committed draw is an
  -- immutable money receipt: its replay must not depend on the live stack
  -- distribution or on a busted player's seat still being occupied.
  SELECT r.club_id, r.multiplier, round(-r.amount,2)
    INTO v_owner, v_booked_multiplier, v_booked_draw
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.kind = 'jackpot_draw'
   ORDER BY r.created_at, r.id
   LIMIT 1;
  v_draw_existed := v_booked_multiplier IS NOT NULL;

  -- A committed draw replays from immutable evidence and is deliberately
  -- independent of whatever tier payload a newer, older, or recovering
  -- service happens to carry. Only a brand-new money decision authenticates
  -- the caller's compiled copy against the database-owned product contract.
  IF NOT v_draw_existed AND (
       p_tiers IS NULL
       OR jsonb_typeof(p_tiers) <> 'array'
       OR p_tiers IS DISTINCT FROM v_canonical_tiers
     ) THEN
    RAISE EXCEPTION
      'Spin draw-and-settle tier contract does not match canonical economics v2026-09-05'
      USING ERRCODE = '22023';
  END IF;

  v_table_id := public.fn_tournament_primary_table(p_tournament_id);
  SELECT count(*), count(DISTINCT s.user_id),
         count(*) FILTER (
           WHERE s.stack IS NOT DISTINCT FROM v_t.starting_chips
             AND s.stack::text NOT IN ('NaN','Infinity','-Infinity')
             AND s.stack > 0)
    INTO v_paid_seats, v_seat_users, v_exact_seat_stacks
    FROM public.table_seats s
   WHERE s.table_id = v_table_id AND s.left_at IS NULL;
  SELECT count(DISTINCT tp.user_id),
         count(*) FILTER (
           WHERE tp.status = 'playing'
             AND tp.chips IS NOT DISTINCT FROM v_t.starting_chips
             AND tp.chips::text NOT IN ('NaN','Infinity','-Infinity')
             AND tp.chips > 0
             AND s.user_id IS NOT NULL
             AND tp.table_id IS NOT DISTINCT FROM s.table_id
             AND tp.seat_number IS NOT DISTINCT FROM s.seat_number)
    INTO v_roster_users, v_exact_roster_stacks
    FROM public.tournament_players tp
    LEFT JOIN public.table_seats s
      ON s.table_id = v_table_id
     AND s.user_id = tp.user_id
     AND s.left_at IS NULL
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_paid_users
    FROM (
      SELECT tp.user_id
        FROM public.tournament_players tp
        JOIN public.wallet_transactions w
          ON w.related_entity_id = tp.tournament_id
         AND w.user_id = tp.user_id
         AND w.type = 'debit'
         AND w.category = 'tournament_buyin'
       WHERE tp.tournament_id = p_tournament_id
       GROUP BY tp.user_id
      HAVING round(sum(w.amount),2) = round(v_t.buy_in_amount,2)
    ) paid;
  SELECT count(*), round(COALESCE(sum(w.amount),0),2)
    INTO v_buyin_debits,v_buyin_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin';
  IF v_roster_users <> 3
     OR v_paid_users <> 3
     OR v_buyin_debits <> 3
     OR v_buyin_total <> round(v_t.buy_in_amount * 3,2) THEN
    RAISE EXCEPTION
      'Spin % does not have exactly three immutable paid identities (% roster users, % paid users, % debits, % total)',
      p_tournament_id,v_roster_users,v_paid_users,v_buyin_debits,v_buyin_total
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_draw_existed
     AND (v_table_id IS NULL OR v_paid_seats <> 3 OR v_seat_users <> 3
       OR v_exact_seat_stacks <> 3
       OR v_exact_roster_stacks <> 3
       OR EXISTS (
         SELECT 1
           FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND NOT EXISTS (
              SELECT 1 FROM public.table_seats s
               WHERE s.table_id = v_table_id
                 AND s.left_at IS NULL
                 AND s.user_id = tp.user_id
            )
       )) THEN
    RAISE EXCEPTION
      'Spin % is not exactly three paid rostered starting stacks (% seats, % exact seat stacks, % seat users, % roster users, % exact roster stacks, % paid users, % debits, % total)',
      p_tournament_id, v_paid_seats, v_exact_seat_stacks, v_seat_users,
      v_roster_users, v_exact_roster_stacks, v_paid_users, v_buyin_debits,v_buyin_total
      USING ERRCODE = '55000';
  END IF;

  v_rake_rate := public.fn_spin_rake_rate(v_t.buy_in_amount);
  v_reserve_in := round(v_t.buy_in_amount * 3 * (1 - v_rake_rate), 2);

  IF NOT v_draw_existed THEN
    -- fn_spin_book_entry owns the escrow -> advisory -> reserve lock order.
    -- The outer transaction retains every lock it takes through the new draw.
    v_owner := public.fn_spin_reserve_pool(v_t.club_id);
    v_book := public.fn_spin_book_entry(p_tournament_id);
    IF COALESCE((v_book->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Spin % entry booking refused: %', p_tournament_id, v_book
        USING ERRCODE = 'P0404';
    END IF;
    BEGIN
      v_entry_reserve_id := (v_book->>'entry_reserve_id')::uuid;
      v_entry_journal_id := (v_book->>'entry_journal_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Spin % entry returned no immutable evidence ids: %',
        p_tournament_id,v_book USING ERRCODE = 'P0404';
    END;
  END IF;

  SELECT p.id, p.balance, GREATEST(p.highest_stake, v_t.buy_in_amount)
    INTO v_pool_id, v_available, v_highest_stake
    FROM public.spin_bonus_pools p
   WHERE p.club_id = v_owner
   FOR UPDATE;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'Spin % reserve pool is missing', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draw_existed THEN
    -- Replay is evidence-only. Do not call either lower money primitive after
    -- a draw exists: ownership may have changed since the draw, while the
    -- immutable reserve row and journal still name the exact historical pool.
    SELECT count(*), (array_agg(r.id ORDER BY r.created_at,r.id))[1]
      INTO v_row_count,v_entry_reserve_id
      FROM public.spin_reserve_ledger r
     WHERE r.tournament_id = p_tournament_id
       AND r.kind = 'contribution'
       AND r.club_id = v_owner
       AND r.amount = v_reserve_in
       AND r.buy_in = v_t.buy_in_amount
       AND r.seats = 3
       AND r.house_rake = round(v_t.buy_in_amount * 3 * v_rake_rate,2);
    IF v_row_count <> 1 THEN
      RAISE EXCEPTION 'Spin % replay has % exact entry reserve rows',
        p_tournament_id,v_row_count USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), (array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_leg_count,v_entry_journal_id
      FROM public.chip_ledger l
      JOIN public.spin_reserve_ledger r ON r.id = v_entry_reserve_id
     WHERE l.category = 'spin_entry'
       AND l.from_type = 'prize_liability'
       AND l.from_entity_id = p_tournament_id
       AND l.to_type = 'spin_reserve'
       AND l.to_entity_id = v_pool_id
       AND l.tournament_id = p_tournament_id
       AND l.amount = v_reserve_in
       AND l.post_to_balance IS NOT DISTINCT FROM r.balance_after;
    IF v_leg_count <> 1 THEN
      RAISE EXCEPTION 'Spin % replay entry has % exact journal legs',
        p_tournament_id,v_leg_count USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.tournament_id = p_tournament_id
          AND r.kind = 'contribution'
          AND r.club_id = v_owner
          AND r.amount = v_reserve_in
     )
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.category = 'spin_entry'
            AND l.from_type = 'prize_liability'
            AND l.from_entity_id = p_tournament_id
            AND l.to_type = 'spin_reserve'
            AND l.to_entity_id = v_pool_id
            AND l.amount = v_reserve_in) <> 1 THEN
    RAISE EXCEPTION 'Spin % entry did not produce exact reserve evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_booked_multiplier IS NULL THEN
    IF COALESCE(v_t.spin_multiplier,0) > 0 THEN
      RAISE EXCEPTION
        'Spin % row carries multiplier % without an authoritative reserve draw',
        p_tournament_id, v_t.spin_multiplier USING ERRCODE = 'P0404';
    END IF;

    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_canonical_tiers) LOOP
      BEGIN
        v_multiplier := (v_tier->>'multiplier')::numeric;
        v_frequency := (v_tier->>'freq')::numeric;
        v_threshold := COALESCE((v_tier->>'reserveThresholdX')::numeric,0);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Spin % tier is not numeric: %',
          p_tournament_id, v_tier USING ERRCODE = '22023';
      END;
      IF v_multiplier IS NULL OR v_multiplier <= 0
         OR v_frequency IS NULL OR v_frequency < 0
         OR v_threshold < 0
         OR v_multiplier = ANY(v_seen) THEN
        RAISE EXCEPTION 'Spin % tier is invalid or duplicated: %',
          p_tournament_id, v_tier USING ERRCODE = '23514';
      END IF;
      v_seen := array_append(v_seen, v_multiplier);
      v_prize := round(v_t.buy_in_amount * v_multiplier, 2);

      -- v_available already includes this event's contribution. The retired
      -- draw RPC added v_reserve_in a second time whenever entry was booked.
      IF v_available < v_prize THEN
        v_locked := v_locked || jsonb_build_object(
          'multiplier',v_multiplier,'reason','unaffordable',
          'unlocksAt',round(v_prize,2));
      ELSIF v_threshold > 0
            AND v_available < v_multiplier * v_highest_stake * v_threshold THEN
        v_locked := v_locked || jsonb_build_object(
          'multiplier',v_multiplier,'reason','threshold',
          'unlocksAt',round(v_multiplier * v_highest_stake * v_threshold,2));
      ELSE
        v_eligible := v_eligible || v_tier;
        v_total := v_total + v_frequency;
      END IF;
    END LOOP;

    IF v_total <= 0 OR jsonb_array_length(v_eligible) = 0 THEN
      RAISE EXCEPTION 'Spin % has no eligible funded tier at reserve %',
        p_tournament_id, v_available USING ERRCODE = '55000';
    END IF;

    v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
              / 281474976710656::numeric * v_total;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_eligible) LOOP
      v_acc := v_acc + (v_tier->>'freq')::numeric;
      IF v_roll < v_acc THEN
        v_pick := (v_tier->>'multiplier')::numeric;
        EXIT;
      END IF;
    END LOOP;
    IF v_pick IS NULL THEN
      v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1)
                            ->> 'multiplier')::numeric;
    END IF;

    PERFORM set_config('app.ledger_idempotency_key',v_draw_key,true);
    v_settle := public.fn_spin_settle_game(
      p_tournament_id, v_t.club_id, v_t.buy_in_amount, 3,
      v_pick, v_rake_rate);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    v_booked_multiplier := v_pick;
    v_booked_draw := round(v_t.buy_in_amount * v_pick,2);
  ELSE
    -- The immutable reserve and journal rows are the receipt. Reconstruct only
    -- the return envelope; no lower money function runs on a replay.
    v_settle := jsonb_build_object(
      'ok',true,'reason','already_settled',
      'multiplier',v_booked_multiplier,
      'pool_covered',v_booked_draw,
      'operator_shortfall',0);
    v_locked := COALESCE(v_t.spin_locked_tiers,'[]'::jsonb);
  END IF;

  IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
     OR (v_settle->>'multiplier') IS NOT NULL
        AND (v_settle->>'multiplier')::numeric <> v_booked_multiplier
     OR COALESCE((v_settle->>'pool_covered')::numeric,0) <> v_booked_draw
     OR COALESCE((v_settle->>'operator_shortfall')::numeric,0) <> 0 THEN
    RAISE EXCEPTION 'Spin % did not settle its exact funded draw: %',
      p_tournament_id, v_settle USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), (array_agg(r.id ORDER BY r.created_at,r.id))[1]
    INTO v_row_count,v_draw_reserve_id
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id
     AND r.kind = 'jackpot_draw'
     AND r.club_id = v_owner
     AND r.multiplier = v_booked_multiplier
     AND r.buy_in = v_t.buy_in_amount
     AND r.seats = 3
     AND round(-r.amount,2) = v_booked_draw;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'Spin % draw evidence is not exact after settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), (array_agg(l.id ORDER BY l.created_at,l.id))[1]
    INTO v_leg_count,v_draw_journal_id
    FROM public.chip_ledger l
    JOIN public.spin_reserve_ledger r ON r.id = v_draw_reserve_id
   WHERE l.category = 'spin_prize'
     AND l.from_type = 'spin_reserve'
     AND l.from_entity_id = v_pool_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.tournament_id = p_tournament_id
     AND l.amount = v_booked_draw
     AND l.post_from_balance IS NOT DISTINCT FROM r.balance_after
     AND (v_draw_existed OR l.idempotency_key = v_draw_key);
  IF v_leg_count <> 1 THEN
    RAISE EXCEPTION 'Spin % draw has % exact journal legs',
      p_tournament_id,v_leg_count USING ERRCODE = 'P0404';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
       WHERE r.id = v_entry_reserve_id
          AND r.tournament_id = p_tournament_id
          AND r.kind = 'contribution'
          AND r.club_id = v_owner
          AND r.amount = v_reserve_in
          AND r.buy_in = v_t.buy_in_amount
          AND r.seats = 3
          AND r.house_rake = round(v_t.buy_in_amount * 3 * v_rake_rate,2))
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
       JOIN public.spin_reserve_ledger r ON r.id = v_entry_reserve_id
        WHERE l.id = v_entry_journal_id
          AND l.tournament_id = p_tournament_id
          AND l.category = 'spin_entry'
          AND l.from_type = 'prize_liability'
          AND l.from_entity_id = p_tournament_id
          AND l.to_type = 'spin_reserve'
          AND l.to_entity_id = v_pool_id
          AND l.amount = v_reserve_in
          AND l.post_to_balance IS NOT DISTINCT FROM r.balance_after) THEN
    RAISE EXCEPTION 'Spin % entry receipt ids do not resolve to exact evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT e.reserve_out,e.reserve_in,e.prize_balance
    INTO v_escrow_reserve_out,v_escrow_reserve_in,v_escrow_prize_balance
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_escrow_reserve_out IS DISTINCT FROM v_reserve_in
     OR v_escrow_reserve_in IS DISTINCT FROM v_booked_draw
     OR v_escrow_prize_balance IS DISTINCT FROM v_booked_draw THEN
    RAISE EXCEPTION
      'Spin % escrow does not equal entry %, draw % (out %, in %, prize %)',
      p_tournament_id,v_reserve_in,v_booked_draw,
      v_escrow_reserve_out,v_escrow_reserve_in,v_escrow_prize_balance
      USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.spin_multiplier,0) > 0
     AND v_t.spin_multiplier IS DISTINCT FROM v_booked_multiplier THEN
    RAISE EXCEPTION 'Spin % row multiplier % disagrees with immutable draw %',
      p_tournament_id,v_t.spin_multiplier,v_booked_multiplier
      USING ERRCODE = 'P0404';
  END IF;
  IF COALESCE(v_t.spin_multiplier,0) > 0
     AND v_t.prize_pool IS DISTINCT FROM v_booked_draw THEN
    RAISE EXCEPTION 'Spin % row prize pool % disagrees with immutable draw %',
      p_tournament_id,v_t.prize_pool,v_booked_draw USING ERRCODE = 'P0404';
  END IF;

  -- Stage 2 keys the immutable tournament-contract trigger to this authority.
  -- Stage 1 does not require the marker yet because the still-live old engine
  -- must be able to finish its database-first rolling cutover.
  PERFORM set_config(
    'app.spin_settlement_authority',p_tournament_id::text,true);
  UPDATE public.tournaments
     SET spin_multiplier = v_booked_multiplier,
         prize_pool = v_booked_draw,
         spin_locked_tiers = v_locked
   WHERE id = p_tournament_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  PERFORM set_config('app.spin_settlement_authority','',true);
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'Spin % tournament contract could not be stamped',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = p_tournament_id
          AND t.spin_multiplier IS NOT DISTINCT FROM v_booked_multiplier
          AND t.prize_pool IS NOT DISTINCT FROM v_booked_draw
          AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked
     ) THEN
    RAISE EXCEPTION 'Spin % tournament contract did not read back exactly',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT p.balance INTO v_available
    FROM public.spin_bonus_pools p WHERE p.id = v_pool_id;

  RETURN v_settle || jsonb_build_object(
    'ok',true,
    'money_path','fn_spin_draw_and_settle',
    'tournament_id',p_tournament_id,
    'seats',3,
    'paid_users',v_paid_users,
    'multiplier',v_booked_multiplier,
    'prize_pool',v_booked_draw,
    'pool_covered',v_booked_draw,
    'operator_shortfall',0,
    'draw_amount',v_booked_draw,
    'entry_amount',v_reserve_in,
    'reserve_in',v_reserve_in,
    'house_rake',round(v_t.buy_in_amount * 3 * v_rake_rate,2),
    'reserve_balance',v_available,
    'pool_id',v_pool_id,
    'entry_reserve_id',v_entry_reserve_id,
    'entry_journal_id',v_entry_journal_id,
    'draw_reserve_id',v_draw_reserve_id,
    'draw_journal_id',v_draw_journal_id,
    'escrow_reserve_out',v_escrow_reserve_out,
    'escrow_reserve_in',v_escrow_reserve_in,
    'escrow_prize_balance',v_escrow_prize_balance,
    'tournament_multiplier',v_booked_multiplier,
    'tournament_prize_pool',v_booked_draw,
    'locked',v_locked,
    'eligible_count',jsonb_array_length(v_eligible),
    'owner_id',v_owner);
END;
$function$;
ALTER FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_spin_draw_multiplier(p_club_id uuid, p_buy_in numeric, p_tiers jsonb, p_rake_rate numeric DEFAULT 0.08, p_seats integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_bal numeric := 0; v_stake numeric := 0; v_contrib numeric := 0;
  v_eligible jsonb := '[]'::jsonb; v_tier jsonb;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0;
  v_pick numeric := NULL; v_locked jsonb := '[]'::jsonb;
  v_prize numeric; v_thr numeric; v_owner uuid;
  v_pending numeric := 0;
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);

  -- FOR UPDATE: concurrent draws on the same pool serialize here (and with
  -- fn_spin_settle_game, which locks the same row), so two spins can no
  -- longer pass the affordability gate against the same chips.
  SELECT balance, GREATEST(highest_stake, COALESCE(p_buy_in,0))
    INTO v_bal, v_stake FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- Prizes already drawn against this pool but not yet settled: their spin
  -- rows carry a multiplier while no jackpot_draw ledger row exists yet.
  -- Bounded to 24h; anything older is the sweep's business, and the settle
  -- normally follows its draw within milliseconds.
  SELECT COALESCE(sum(round(t.buy_in_amount * t.spin_multiplier, 2)), 0)
    INTO v_pending
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND t.spin_multiplier IS NOT NULL
     AND t.created_at > now() - interval '24 hours'
     AND t.status NOT IN ('COMPLETED','CANCELLED','CANCELED')
     AND public.fn_spin_reserve_pool(t.club_id) = v_owner
     AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                     WHERE l.tournament_id = t.id AND l.kind = 'jackpot_draw');
  v_bal := v_bal - v_pending;

  v_contrib := round(COALESCE(p_buy_in,0) * COALESCE(p_seats,3)
                     * (1 - COALESCE(p_rake_rate,0.08)), 2);

  FOR v_tier IN SELECT * FROM jsonb_array_elements(p_tiers) LOOP
    v_prize := (v_tier->>'multiplier')::numeric * COALESCE(p_buy_in,0);
    v_thr   := COALESCE((v_tier->>'reserveThresholdX')::numeric, 0);

    IF (v_bal + v_contrib) < v_prize THEN
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'unaffordable',
        'unlocksAt', round(v_prize - v_contrib, 2));
    ELSIF v_thr > 0 AND v_bal < (v_tier->>'multiplier')::numeric * v_stake * v_thr THEN
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'threshold',
        'unlocksAt', round((v_tier->>'multiplier')::numeric * v_stake * v_thr, 2));
    ELSE
      v_eligible := v_eligible || v_tier;
      v_total := v_total + COALESCE((v_tier->>'freq')::numeric, 0);
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_eligible_tiers',
      'reserve_balance', v_bal, 'locked', v_locked, 'owner_id', v_owner);
  END IF;

  v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;

  FOR v_tier IN SELECT * FROM jsonb_array_elements(v_eligible) LOOP
    v_acc := v_acc + COALESCE((v_tier->>'freq')::numeric,0);
    IF v_roll < v_acc THEN v_pick := (v_tier->>'multiplier')::numeric; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1) ->> 'multiplier')::numeric;
  END IF;

  RETURN jsonb_build_object('ok', true, 'multiplier', v_pick,
    'reserve_balance', v_bal, 'highest_stake', v_stake,
    'contribution', v_contrib, 'locked', v_locked, 'owner_id', v_owner,
    'eligible_count', jsonb_array_length(v_eligible));
END; $function$;
ALTER FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(p_tournament_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
BEGIN
  IF p_tournament_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_tournament_lease_v2 requires tournament_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'claim_tournament_lease_v2 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): the takeover waits for
     every in-flight manager transaction (they hold FOR KEY SHARE in the
     PostgREST pre-request hook). The upsert below only takes FOR NO KEY
     UPDATE on its own, which FOR KEY SHARE does not block. */
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;

  INSERT INTO public.engine_tournament_leases AS l (
    tournament_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_tournament_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (tournament_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
           l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
         )
      OR (
           l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
         )
      OR (
           l.heartbeat_at < clock_timestamp() - interval '30 seconds'
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
         )
  RETURNING l.instance_id, l.heartbeat_at, l.lease_generation
       INTO v_holder, v_heartbeat, v_generation;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, 2;
    RETURN;
  END IF;

  SELECT l.instance_id, l.heartbeat_at, l.lease_generation
    INTO v_holder, v_heartbeat, v_generation
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           (SELECT l.protocol_version
              FROM public.engine_tournament_leases l
             WHERE l.tournament_id = p_tournament_id);
END;
$function$;
ALTER FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_prove_played_launch_recovery(p_tournament_id uuid, p_started_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_required int;
  v_finalized boolean;
  v_playing int;
  v_eliminated int;
  v_other int;
  v_hands bigint;
  v_first_hand timestamptz;
  v_seated int;
BEGIN
  SELECT CASE WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))
              ELSE 3 END,
         COALESCE(t.prize_pool_finalized, false)
    INTO v_required, v_finalized
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_required IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF NOT v_finalized THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_finalized');
  END IF;

  SELECT count(*) FILTER (WHERE p.status = 'playing'),
         count(*) FILTER (WHERE p.status = 'eliminated'),
         count(*) FILTER (WHERE p.status NOT IN ('playing', 'eliminated'))
    INTO v_playing, v_eliminated, v_other
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id;

  SELECT count(*), min(h.created_at)
    INTO v_hands, v_first_hand
    FROM public.hand_history h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.tournament_id = p_tournament_id;

  IF COALESCE(v_hands, 0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_hand_was_dealt');
  END IF;

  IF p_started_at IS NULL OR v_first_hand IS DISTINCT FROM p_started_at THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_receipt_is_not_the_deal_that_happened',
      'first_hand_at', v_first_hand,
      'receipt_started_at', p_started_at
    );
  END IF;

  IF v_other <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'an_entrant_was_never_dealt_in',
      'pre_deal_entrants', v_other
    );
  END IF;

  IF v_playing + v_eliminated < v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_field_that_was_dealt_is_short',
      'dealt_field', v_playing + v_eliminated,
      'required_players', v_required
    );
  END IF;

  SELECT count(*)
    INTO v_seated
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.left_at IS NULL;

  IF v_playing < 1 OR v_seated <> v_playing THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_surviving_field_is_not_seated',
      'playing', v_playing,
      'live_seats', v_seated
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'hands_dealt', v_hands,
    'first_hand_at', v_first_hand,
    'dealt_field', v_playing + v_eliminated,
    'required_players', v_required,
    'playing', v_playing,
    'eliminated', v_eliminated
  );
END;
$function$;
ALTER FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamp with time zone) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_prove_played_spin_launch_recovery(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
 SET statement_timeout TO '10s'
AS $function$
WITH contract AS (
  SELECT t.id,
         t.status::text AS status,
         lower(COALESCE(t.variant, '')) AS variant,
         upper(COALESCE(t.tournament_type, '')) AS tournament_type,
         t.max_players,
         t.buy_in_amount AS buy_in,
         t.starting_chips,
         round(t.buy_in_amount * 3 * public.fn_spin_rake_rate(t.buy_in_amount), 2)
           AS expected_house_rake,
         round(t.buy_in_amount * 3
               * (1 - public.fn_spin_rake_rate(t.buy_in_amount)), 2)
           AS expected_reserve_in
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
), roster AS (
  SELECT count(*) AS roster_count,
         count(DISTINCT tp.user_id) AS roster_users,
         count(*) FILTER (WHERE tp.status = 'playing') AS active_players,
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.chips > 0)
           AS positive_active_players,
         count(*) FILTER (WHERE tp.status = 'eliminated') AS eliminated_players,
         count(*) FILTER (WHERE tp.status NOT IN ('playing', 'eliminated')) AS other_players,
         count(*) FILTER (WHERE tp.chips IS NULL OR tp.chips < 0) AS invalid_stacks,
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.chips = 0)
           AS zero_stack_eliminations,
         COALESCE(sum(tp.chips), 0) AS roster_chips,
         COALESCE(
           array_agg(tp.user_id ORDER BY tp.user_id)
             FILTER (WHERE tp.user_id IS NOT NULL),
           ARRAY[]::uuid[]
         ) AS original_player_ids,
         COALESCE(
           array_agg(tp.user_id ORDER BY tp.user_id)
             FILTER (WHERE tp.status = 'playing'),
           ARRAY[]::uuid[]
         ) AS active_player_ids
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
), entitlements AS (
  SELECT count(e.id) AS entitlement_count,
         count(DISTINCT e.user_id) AS entitlement_users,
         count(DISTINCT e.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = e.user_id
           )
         ) AS roster_entitlement_users,
         min(e.gross) AS min_gross,
         max(e.gross) AS max_gross,
         round(COALESCE(sum(e.gross), 0), 2) AS gross_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id = p_tournament_id
     AND e.entitlement_kind = 'wallet_charge'
     AND e.charge_category = 'tournament_buyin'
), payments AS (
  SELECT count(w.id) AS payment_count,
         count(DISTINCT w.user_id) AS paid_users,
         count(DISTINCT w.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = w.user_id
           )
         ) AS roster_paid_users,
         min(w.amount) AS min_amount,
         max(w.amount) AS max_amount,
         round(COALESCE(sum(w.amount), 0), 2) AS payment_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin'
), charge_evidence AS (
  SELECT count(l.id) AS source_charge_count,
         count(l.id) FILTER (
           WHERE l.tournament_id = e.tournament_id
             AND l.club_id = e.refund_wallet_club_id
             AND l.from_type = 'player_wallet'
             AND l.from_entity_id = e.user_id
             AND l.to_type = 'prize_liability'
             AND l.to_entity_id = e.tournament_id
             AND l.category = e.charge_category
             AND l.amount = e.gross
         ) AS exact_source_charges
    FROM public.tournament_refund_entitlements e
    LEFT JOIN public.chip_ledger l ON l.id = e.source_ledger_id
   WHERE e.tournament_id = p_tournament_id
     AND e.entitlement_kind = 'wallet_charge'
     AND e.charge_category = 'tournament_buyin'
), reserve_evidence AS (
  SELECT count(sr.id) FILTER (WHERE sr.kind = 'contribution') AS contribution_count,
         count(sr.id) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_count,
         (array_agg(sr.id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'contribution'))[1] AS contribution_id,
         (array_agg(sr.id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'jackpot_draw'))[1] AS draw_id,
         (array_agg(sr.club_id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'contribution'))[1] AS contribution_owner,
         (array_agg(sr.club_id ORDER BY sr.created_at, sr.id)
           FILTER (WHERE sr.kind = 'jackpot_draw'))[1] AS draw_owner,
         min(sr.amount) FILTER (WHERE sr.kind = 'contribution') AS contribution_amount,
         min(sr.buy_in) FILTER (WHERE sr.kind = 'contribution') AS contribution_buy_in,
         min(sr.seats) FILTER (WHERE sr.kind = 'contribution') AS contribution_seats,
         min(sr.house_rake) FILTER (WHERE sr.kind = 'contribution') AS contribution_rake,
         min(sr.balance_after) FILTER (WHERE sr.kind = 'contribution')
           AS contribution_balance,
         min(sr.amount) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_amount,
         min(sr.buy_in) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_buy_in,
         min(sr.seats) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_seats,
         min(sr.multiplier) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_multiplier,
         min(sr.balance_after) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_balance,
         min(sr.created_at) FILTER (WHERE sr.kind = 'jackpot_draw') AS draw_created_at
    FROM public.spin_reserve_ledger sr
   WHERE sr.tournament_id = p_tournament_id
     AND sr.kind IN ('contribution', 'jackpot_draw')
), reserve_pool AS (
  SELECT count(p.id) AS pool_count,
         (array_agg(p.id ORDER BY p.id))[1] AS pool_id
    FROM public.spin_bonus_pools p
    CROSS JOIN reserve_evidence r
   WHERE p.club_id = r.draw_owner
), journals AS (
  SELECT count(l.id) FILTER (WHERE l.category = 'spin_entry') AS entry_journal_count,
         count(l.id) FILTER (WHERE l.category = 'spin_prize') AS draw_journal_count,
         count(l.id) FILTER (
           WHERE l.category = 'spin_entry'
             AND l.from_type = 'prize_liability'
             AND l.from_entity_id = p_tournament_id
             AND l.to_type = 'spin_reserve'
             AND l.to_entity_id = p.pool_id
             AND l.amount = c.expected_reserve_in
             AND l.post_to_balance IS NOT DISTINCT FROM r.contribution_balance
         ) AS exact_entry_journals,
         count(l.id) FILTER (
           WHERE l.category = 'spin_prize'
             AND l.from_type = 'spin_reserve'
             AND l.from_entity_id = p.pool_id
             AND l.to_type = 'prize_liability'
             AND l.to_entity_id = p_tournament_id
             AND l.amount = round(-r.draw_amount, 2)
             AND l.post_from_balance IS NOT DISTINCT FROM r.draw_balance
         ) AS exact_draw_journals
    FROM contract c
    CROSS JOIN reserve_evidence r
    CROSS JOIN reserve_pool p
    LEFT JOIN public.chip_ledger l
      ON l.tournament_id = p_tournament_id
     AND l.category IN ('spin_entry', 'spin_prize')
   GROUP BY c.expected_reserve_in, r.contribution_balance, r.draw_amount,
            r.draw_balance, p.pool_id
), table_evidence AS (
  SELECT count(t.id) AS table_count,
         count(t.id) FILTER (WHERE t.status IN ('running', 'waiting')) AS open_tables,
         (array_agg(t.id ORDER BY t.created_at, t.id)
           FILTER (WHERE t.status IN ('running', 'waiting')))[1] AS table_id,
         min(t.current_players) FILTER (WHERE t.status IN ('running', 'waiting'))
           AS current_players,
         min(t.max_players) FILTER (WHERE t.status IN ('running', 'waiting'))
           AS table_capacity
    FROM public.tables t
   WHERE t.tournament_id = p_tournament_id
), live_seats AS (
  SELECT count(s.id) AS live_seats,
         count(DISTINCT s.user_id) AS live_users,
         count(DISTINCT (s.table_id, s.seat_number)) AS live_coordinates,
         count(DISTINCT s.table_id) AS live_tables,
         count(s.id) FILTER (
           WHERE s.stack IS NULL
              OR s.stack::text IN ('NaN', 'Infinity', '-Infinity')
              OR s.stack < 0
         ) AS invalid_live_stacks,
         count(s.id) FILTER (WHERE s.stack > 0) AS positive_live_seats,
         count(s.id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = s.user_id
                AND tp.status = 'playing'
                AND tp.table_id = s.table_id
                AND tp.seat_number = s.seat_number
                AND tp.chips IS NOT DISTINCT FROM s.stack
           )
         ) AS matching_active_seats,
         COALESCE(sum(s.stack), 0) AS seat_chips
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id
   WHERE t.tournament_id = p_tournament_id
     AND s.left_at IS NULL
), vacated_seat AS (
  SELECT count(DISTINCT tp.user_id) AS vacated_eliminated_players
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'eliminated'
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = p_tournament_id
          AND s.user_id = tp.user_id
          AND s.left_at IS NOT NULL
     )
), hands AS (
  SELECT count(h.id) FILTER (WHERE h.created_at >= r.draw_created_at) AS hand_count
    FROM reserve_evidence r
    LEFT JOIN public.hand_history h
      ON h.tournament_id = p_tournament_id
    LEFT JOIN public.tables t
      ON t.id = h.table_id
     AND t.tournament_id = p_tournament_id
   WHERE h.id IS NULL OR t.id IS NOT NULL
), escrow AS (
  SELECT count(e.tournament_id) AS escrow_count,
         min(e.reserve_out) AS reserve_out,
         min(e.reserve_in) AS escrow_reserve_in,
         min(e.prize_balance) AS prize_balance
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
), facts AS (
  SELECT c.*,
         r.*,
         e.*,
         pay.*,
         charge.*,
         re.*,
         pool.*,
         j.*,
         te.*,
         ls.*,
         vs.*,
         h.*,
         esc.*,
         (c.starting_chips * 3)::numeric AS funding_floor
    FROM (SELECT 1) seed
    LEFT JOIN contract c ON true
    CROSS JOIN roster r
    CROSS JOIN entitlements e
    CROSS JOIN payments pay
    CROSS JOIN charge_evidence charge
    CROSS JOIN reserve_evidence re
    CROSS JOIN reserve_pool pool
    CROSS JOIN journals j
    CROSS JOIN table_evidence te
    CROSS JOIN live_seats ls
    CROSS JOIN vacated_seat vs
    CROSS JOIN hands h
    CROSS JOIN escrow esc
), verdict AS (
  SELECT f.*,
         (f.id IS NOT NULL
          AND f.status = 'REGISTERING'
          AND (f.variant = 'spin' OR f.tournament_type = 'SPIN')
          AND f.variant <> 'sng'
          AND f.tournament_type <> 'SNG'
          AND f.max_players = 3
          AND f.buy_in IS NOT NULL
          AND f.buy_in::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND f.buy_in > 0
          AND f.starting_chips IS NOT NULL
          AND f.starting_chips > 0
          AND f.roster_count = 3
          AND f.roster_users = 3
          AND f.active_players = 2
          AND f.positive_active_players = 2
          AND f.eliminated_players = 1
          AND f.other_players = 0
          AND f.invalid_stacks = 0
          AND f.zero_stack_eliminations = 1
          AND f.roster_chips = f.funding_floor
          AND f.entitlement_count = 3
          AND f.entitlement_users = 3
          AND f.roster_entitlement_users = 3
          AND f.min_gross = f.buy_in
          AND f.max_gross = f.buy_in
          AND f.gross_total = round(f.buy_in * 3, 2)
          AND f.payment_count = 3
          AND f.paid_users = 3
          AND f.roster_paid_users = 3
          AND f.min_amount = f.buy_in
          AND f.max_amount = f.buy_in
          AND f.payment_total = round(f.buy_in * 3, 2)
          AND f.source_charge_count = 3
          AND f.exact_source_charges = 3
          AND f.contribution_count = 1
          AND f.draw_count = 1
          AND f.contribution_owner IS NOT NULL
          AND f.contribution_owner = f.draw_owner
          AND f.contribution_amount = f.expected_reserve_in
          AND f.contribution_buy_in = f.buy_in
          AND f.contribution_seats = 3
          AND f.contribution_rake = f.expected_house_rake
          AND f.draw_amount IS NOT NULL
          AND round(-f.draw_amount, 2) = round(f.buy_in * f.draw_multiplier, 2)
          AND f.draw_buy_in = f.buy_in
          AND f.draw_seats = 3
          AND f.draw_multiplier > 0
          AND f.pool_count = 1
          AND f.entry_journal_count = 1
          AND f.draw_journal_count = 1
          AND f.exact_entry_journals = 1
          AND f.exact_draw_journals = 1
          AND f.escrow_count = 1
          AND f.reserve_out = f.expected_reserve_in
          AND f.escrow_reserve_in = round(-f.draw_amount, 2)
          AND f.prize_balance = round(-f.draw_amount, 2)
          AND f.table_count = 1
          AND f.open_tables = 1
          AND f.current_players = 2
          AND f.table_capacity = 3
          AND f.live_seats = 2
          AND f.live_users = 2
          AND f.live_coordinates = 2
          AND f.live_tables = 1
          AND f.invalid_live_stacks = 0
          AND f.positive_live_seats = 2
          AND f.matching_active_seats = 2
          AND f.seat_chips = f.funding_floor
          AND f.seat_chips = f.roster_chips
          AND f.vacated_eliminated_players = 1
          AND f.hand_count >= 1) AS ok
    FROM facts f
)
SELECT CASE WHEN v.ok THEN
  jsonb_build_object(
    'ok', true,
    'recovery_mode', 'played_vacated_spin',
    'tournament_id', p_tournament_id,
    'original_field', 3,
    'active_field', 2,
    'eliminated_players', v.eliminated_players,
    'paid_users', v.paid_users,
    'entitlement_users', v.entitlement_users,
    'live_seats', v.live_seats,
    'hand_count', v.hand_count,
    'funding_floor', v.funding_floor,
    'roster_chips', v.roster_chips,
    'seat_chips', v.seat_chips,
    'original_player_ids', to_jsonb(v.original_player_ids),
    'active_player_ids', to_jsonb(v.active_player_ids)
  )
ELSE
  jsonb_build_object(
    'ok', false,
    'reason', 'played_spin_launch_recovery_unproven',
    'tournament_id', p_tournament_id
  )
END
  FROM verdict v;
$function$;
ALTER FUNCTION public.fn_prove_played_spin_launch_recovery(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_prove_played_spin_launch_recovery(uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_spin_launch_recovery(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_spin_launch_recovery(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(p_tournament_id uuid, p_club_id uuid, p_buy_in numeric, p_seats integer, p_multiplier numeric, p_rake_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_floor numeric; v_instalment numeric := 0;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
  v_booked_mult numeric; v_booked_drawn numeric;
  v_entry_booked boolean;
  v_rake_booked boolean;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- THE PRIZE IS WHAT THIS FUNCTION OWNS. A contribution row on its own means
  -- the entry was booked when the last seat was paid and the prize still is
  -- not; only a jackpot_draw row means settled.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind = 'jackpot_draw') THEN
    SELECT l.multiplier, -l.amount INTO v_booked_mult, v_booked_drawn
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw'
     ORDER BY l.created_at ASC LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled',
      'multiplier', v_booked_mult, 'pool_covered', v_booked_drawn);
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_entry_booked := EXISTS (SELECT 1 FROM public.spin_reserve_ledger
                             WHERE tournament_id = p_tournament_id AND kind = 'contribution');
  v_rake_booked  := EXISTS (SELECT 1 FROM public.rake_records
                             WHERE tournament_id = p_tournament_id
                               AND source IN ('fn_spin_book_entry','fn_spin_settle_game'));

  IF NOT v_entry_booked THEN
    -- ZERO-DRIFT phase 2: reserve intake = spin_entry vs the tournament.
    PERFORM set_config('app.ledger_category', 'spin_entry', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    UPDATE public.spin_bonus_pools
       SET balance = balance + v_reserve_in,
           total_deposited = total_deposited + v_reserve_in,
           spin_count = spin_count + 1,
           highest_stake = GREATEST(highest_stake, p_buy_in),
           updated_at = now()
     WHERE club_id = v_owner RETURNING balance INTO v_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
            p_multiplier, p_buy_in, p_seats, v_rake,
            CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
                 ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);
  ELSE
    -- Already funded at entry. Read where the pool actually stands.
    SELECT balance INTO v_available
      FROM public.spin_bonus_pools WHERE club_id = v_owner;
    IF v_available IS NULL THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;
  END IF;

  -- A claimed operator shortfall has no funding debit. Reject it before
  -- writing a draw or escrow credit. The atomic launch caller excludes such
  -- tiers while holding this same pool lock; this also fences older callers.
  IF v_prize > v_available THEN
    RAISE EXCEPTION 'Spin prize % exceeds funded reserve % for tournament %',
      v_prize, v_available, p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_drawn := v_prize;

  -- ZERO-DRIFT phase 2: the draw funds the tournament's prize pool.
  -- CHIP STANDARD 1.3 (2026-09-02): ... and names the tournament it funds. With only
  -- the category set, this leg landed spin_reserve -> settlement_suspense (3,303 rows
  -- / 185,189.00 a day, R9). service_role-only, so the primitive is used.
  PERFORM public.fn_ca_declare_ledger('spin_prize', 'prize_liability', p_tournament_id);

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  IF v_rake > 0 AND p_club_id IS NOT NULL AND NOT v_rake_booked THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- THE REPAYMENT PLAN - one instalment per settle, at most.
  SELECT seeded_amount, seed_source_wallet, owner_kind, required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_floor
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_instalment := public.fn_spin_seed_instalment(v_bal, COALESCE(v_seed,0), COALESCE(v_floor,0));

  IF v_instalment > 0 AND v_wallet IS NOT NULL THEN
    PERFORM set_config('app.ledger_category', 'treasury_transfer', true);
    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
    PERFORM set_config('app.ledger_counterparty_entity', v_owner::text, true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);

    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_instalment);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_instalment,
             seeded_amount        = seeded_amount - v_instalment,
             seed_returned_amount = seed_returned_amount + v_instalment,
             seed_returned_at     = now(),
             required_seed_at_activation =
               CASE WHEN seeded_amount - v_instalment <= 0 THEN 0
                    ELSE required_seed_at_activation END,
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_instalment, v_wallet;
      END IF;

      v_seed_returned := v_instalment;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_instalment, v_bal,
              format('seed instalment to %s %s - 50%% of %s above a floor of %s; %s still owed',
                     v_kind, v_wallet, round(v_bal + v_instalment - v_floor, 2), v_floor,
                     GREATEST(COALESCE(v_seed,0) - v_instalment, 0)));
    END IF;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'entry_booked_at_seat', v_entry_booked,
    'seed_outstanding', GREATEST(COALESCE(v_seed,0) - v_seed_returned, 0),
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$function$;
ALTER FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_spin_seed_instalment(p_balance numeric, p_outstanding numeric, p_floor numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_outstanding,0) <= 0 OR COALESCE(p_floor,0) <= 0 THEN 0
    WHEN COALESCE(p_balance,0) < p_floor * 1.25 THEN 0
    WHEN (p_balance - p_floor) <= 0 THEN 0
    ELSE (
      SELECT CASE WHEN v >= 1 THEN v ELSE 0 END
      FROM (SELECT round(LEAST(p_outstanding, (p_balance - p_floor) * 0.5), 2) AS v) q
    )
  END;
$function$;
ALTER FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric) TO service_role;
DO $post$ DECLARE f jsonb; r jsonb; actual jsonb; BEGIN
FOR f IN SELECT value FROM jsonb_array_elements($capture$[{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)","volatility":"v","definition_md5":"a0718c687780f7cf3ce36f50c558f456","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)","volatility":"v","definition_md5":"acbb83c13660c3eda2d9f52fec0c7bd5","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone)","volatility":"v","definition_md5":"0f362f2b4a55f82d627dddccd1da481e","security_definer":true},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)","volatility":"v","definition_md5":"21effa5740c1288acc3e224ec5f4903b","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_claim_tournament_finish(uuid,uuid,text)","volatility":"v","definition_md5":"9c60ce0e2be89a658fb361713ba6400b","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)","volatility":"v","definition_md5":"faeb38ce1a2e975dc80468abaf74c588","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_complete_tournament_launch_atomic(uuid,uuid,uuid)","volatility":"v","definition_md5":"d300cf2470354e570ebb02fdecff0537","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_complete_tournament_launch_atomic(uuid,uuid)","volatility":"v","definition_md5":"ab0d03139203d89e16a0cfdae4e1e292","security_definer":true},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_complete_tournament_launch_before_lease_generation(uuid,uuid)","volatility":"v","definition_md5":"d1a25ca8de559144fe83b7639634baff","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"signature":"fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)","volatility":"v","definition_md5":"6d2328689637d1d28c9ce9256a0d6252","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"signature":"fn_spin_draw_and_settle(uuid,jsonb)","volatility":"v","definition_md5":"f1f01a7719faac3b426e6358a37c5873","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp"],"signature":"fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)","volatility":"v","definition_md5":"9530aa9c1b2c05604e3af611aa6b7ce8","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"claim_tournament_lease_v2(uuid,text,text,uuid,integer)","volatility":"v","definition_md5":"73abfc4523de42cb4b8bca5443602cbd","security_definer":true},{"acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_entry_purchases_frozen()","volatility":"v","definition_md5":"0b05e2e7905caf71f14c8327a172cea0","security_definer":false},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_lock_tournament_launch_proof_parents(uuid[])","volatility":"v","definition_md5":"77e46e6a692bfadfa5537fe634791b9f","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_prove_played_launch_recovery(uuid,timestamp with time zone)","volatility":"s","definition_md5":"c2fc5742cb5e6596aa7eea1f256d72e6","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","row_security=off","statement_timeout=10s"],"signature":"fn_prove_played_spin_launch_recovery(uuid)","volatility":"s","definition_md5":"8bc978cc105c18b2e3350016b48a50eb","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)","volatility":"v","definition_md5":"366a1981c2ea9f0f54b41fe50a5d19b4","security_definer":true},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_tournament_finish_kind(uuid)","volatility":"s","definition_md5":"d1639c3dbf37ecea874c2feea027a0e6","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_spin_draw_receipt_is_immutable()","volatility":"v","definition_md5":"b3e3935c8d7461f8116aedc11338a92d","security_definer":false},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_tournament_launch_receipt_is_immutable()","volatility":"v","definition_md5":"358ac44d59d7c70a2aa40c73e138d4f5","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"signature":"fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])","volatility":"v","definition_md5":"1991d9f52317f33a4b9cf560d6fc91d5","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_spin_move_owner_wallet(uuid,text,text,numeric)","volatility":"v","definition_md5":"a15c8e34a74125cb46406bc6ebb4ba42","security_definer":true},{"acl":"{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"signature":"fn_spin_seed_instalment(numeric,numeric,numeric)","volatility":"i","definition_md5":"bcccb57e89ab61c1ed77458ece8ff7ec","security_definer":false}]$capture$::jsonb) LOOP IF pg_temp.paid_terminal_function(f->>'signature') IS DISTINCT FROM f THEN RAISE EXCEPTION 'modern launch authority readback differs: %',f->>'signature'; END IF; END LOOP;
FOR r IN SELECT value FROM jsonb_array_elements($capture$[{"acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"name":"engine_tournament_leases","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"instance_id","type":"text","default":null,"notnull":true},{"name":"engine_version","type":"text","default":null,"notnull":false},{"name":"acquired_at","type":"timestamp with time zone","default":"now()","notnull":true},{"name":"heartbeat_at","type":"timestamp with time zone","default":"now()","notnull":true},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true},{"name":"protocol_version","type":"integer","default":"1","notnull":true}],"indexes":["CREATE UNIQUE INDEX engine_tournament_leases_pkey ON public.engine_tournament_leases USING btree (tournament_id)","CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at)"],"policies":null,"force_rls":false,"constraints":[{"name":"engine_tournament_leases_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"engine_tournament_leases_protocol_version_check","definition":"CHECK ((protocol_version = ANY (ARRAY[1, 2])))"},{"name":"engine_tournament_leases_tournament_id_fkey","definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"spin_draw_receipts","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"launch_id","type":"uuid","default":null,"notnull":true},{"name":"lease_generation","type":"uuid","default":null,"notnull":true},{"name":"rule_manifest","type":"jsonb","default":null,"notnull":true},{"name":"rule_sha256","type":"text","default":null,"notnull":true},{"name":"entrants","type":"jsonb","default":null,"notnull":true},{"name":"receipt","type":"jsonb","default":null,"notnull":true},{"name":"created_at","type":"timestamp with time zone","default":"transaction_timestamp()","notnull":true}],"indexes":["CREATE UNIQUE INDEX spin_draw_receipts_pkey ON public.spin_draw_receipts USING btree (tournament_id)"],"policies":null,"force_rls":false,"constraints":[{"name":"spin_draw_receipts_entrants_check","definition":"CHECK ((jsonb_array_length(entrants) = 3))"},{"name":"spin_draw_receipts_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"spin_draw_receipts_rule_sha256_check","definition":"CHECK ((rule_sha256 ~ '^[0-9a-f]{64}$'::text))"}]},{"acl":"{postgres=arwdDxtm/postgres}","rls":true,"name":"tournament_launch_receipts","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"launch_id","type":"uuid","default":null,"notnull":true},{"name":"started_at","type":"timestamp with time zone","default":null,"notnull":true},{"name":"claimed_at","type":"timestamp with time zone","default":"transaction_timestamp()","notnull":true},{"name":"completed_at","type":"timestamp with time zone","default":null,"notnull":false},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true},{"name":"supply_version","type":"smallint","default":"0","notnull":true}],"indexes":["CREATE UNIQUE INDEX tournament_launch_receipts_launch_id_key ON public.tournament_launch_receipts USING btree (launch_id)","CREATE UNIQUE INDEX tournament_launch_receipts_pkey ON public.tournament_launch_receipts USING btree (tournament_id)"],"policies":null,"force_rls":false,"constraints":[{"name":"tournament_launch_receipts_launch_id_key","definition":"UNIQUE (launch_id)"},{"name":"tournament_launch_receipts_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"tournament_launch_receipts_supply_version_check","definition":"CHECK ((supply_version = 0))"},{"name":"tournament_launch_receipts_tournament_id_fkey","definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT"}]}]$capture$::jsonb) LOOP IF pg_temp.paid_terminal_relation(r->>'name') IS DISTINCT FROM r THEN RAISE EXCEPTION 'modern launch changed relation: %',r->>'name'; END IF; END LOOP;
SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'table',c.relname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname) INTO actual FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.oid IN ('public.engine_tournament_leases'::regclass,'public.spin_draw_receipts'::regclass,'public.tournament_launch_receipts'::regclass) AND NOT t.tgisinternal;
IF actual IS DISTINCT FROM $capture$[{"name":"spin_draw_receipt_is_immutable","table":"spin_draw_receipts","enabled":"O","function":"trg_spin_draw_receipt_is_immutable()","definition":"CREATE TRIGGER spin_draw_receipt_is_immutable BEFORE DELETE OR UPDATE ON public.spin_draw_receipts FOR EACH ROW EXECUTE FUNCTION trg_spin_draw_receipt_is_immutable()"},{"name":"tournament_launch_receipt_is_immutable","table":"tournament_launch_receipts","enabled":"O","function":"trg_tournament_launch_receipt_is_immutable()","definition":"CREATE TRIGGER tournament_launch_receipt_is_immutable BEFORE DELETE OR UPDATE ON public.tournament_launch_receipts FOR EACH ROW EXECUTE FUNCTION trg_tournament_launch_receipt_is_immutable()"}]$capture$::jsonb THEN RAISE EXCEPTION 'modern launch immutable trigger binding differs'; END IF;
END $post$;
SELECT jsonb_build_object('stage','modern_launch_provider','execution',current_setting('qualification.execution_uuid'),'functions',(SELECT jsonb_agg(pg_temp.paid_terminal_function(f->>'signature') ORDER BY ord) FROM jsonb_array_elements($capture$[{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)","volatility":"v","definition_md5":"a0718c687780f7cf3ce36f50c558f456","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)","volatility":"v","definition_md5":"acbb83c13660c3eda2d9f52fec0c7bd5","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone)","volatility":"v","definition_md5":"0f362f2b4a55f82d627dddccd1da481e","security_definer":true},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)","volatility":"v","definition_md5":"21effa5740c1288acc3e224ec5f4903b","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_claim_tournament_finish(uuid,uuid,text)","volatility":"v","definition_md5":"9c60ce0e2be89a658fb361713ba6400b","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)","volatility":"v","definition_md5":"faeb38ce1a2e975dc80468abaf74c588","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_complete_tournament_launch_atomic(uuid,uuid,uuid)","volatility":"v","definition_md5":"d300cf2470354e570ebb02fdecff0537","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_complete_tournament_launch_atomic(uuid,uuid)","volatility":"v","definition_md5":"ab0d03139203d89e16a0cfdae4e1e292","security_definer":true},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_complete_tournament_launch_before_lease_generation(uuid,uuid)","volatility":"v","definition_md5":"d1a25ca8de559144fe83b7639634baff","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"signature":"fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)","volatility":"v","definition_md5":"6d2328689637d1d28c9ce9256a0d6252","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"signature":"fn_spin_draw_and_settle(uuid,jsonb)","volatility":"v","definition_md5":"f1f01a7719faac3b426e6358a37c5873","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp"],"signature":"fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)","volatility":"v","definition_md5":"9530aa9c1b2c05604e3af611aa6b7ce8","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"claim_tournament_lease_v2(uuid,text,text,uuid,integer)","volatility":"v","definition_md5":"73abfc4523de42cb4b8bca5443602cbd","security_definer":true},{"acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_entry_purchases_frozen()","volatility":"v","definition_md5":"0b05e2e7905caf71f14c8327a172cea0","security_definer":false},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_lock_tournament_launch_proof_parents(uuid[])","volatility":"v","definition_md5":"77e46e6a692bfadfa5537fe634791b9f","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_prove_played_launch_recovery(uuid,timestamp with time zone)","volatility":"s","definition_md5":"c2fc5742cb5e6596aa7eea1f256d72e6","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","row_security=off","statement_timeout=10s"],"signature":"fn_prove_played_spin_launch_recovery(uuid)","volatility":"s","definition_md5":"8bc978cc105c18b2e3350016b48a50eb","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp","statement_timeout=30s"],"signature":"fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)","volatility":"v","definition_md5":"366a1981c2ea9f0f54b41fe50a5d19b4","security_definer":true},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_tournament_finish_kind(uuid)","volatility":"s","definition_md5":"d1639c3dbf37ecea874c2feea027a0e6","security_definer":true},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_spin_draw_receipt_is_immutable()","volatility":"v","definition_md5":"b3e3935c8d7461f8116aedc11338a92d","security_definer":false},{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_tournament_launch_receipt_is_immutable()","volatility":"v","definition_md5":"358ac44d59d7c70a2aa40c73e138d4f5","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"signature":"fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])","volatility":"v","definition_md5":"1991d9f52317f33a4b9cf560d6fc91d5","security_definer":false},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"fn_spin_move_owner_wallet(uuid,text,text,numeric)","volatility":"v","definition_md5":"a15c8e34a74125cb46406bc6ebb4ba42","security_definer":true},{"acl":"{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public"],"signature":"fn_spin_seed_instalment(numeric,numeric,numeric)","volatility":"i","definition_md5":"bcccb57e89ab61c1ed77458ece8ff7ec","security_definer":false}]$capture$::jsonb) WITH ORDINALITY a(f,ord)),'relations',(SELECT jsonb_agg(pg_temp.paid_terminal_relation(r->>'name') ORDER BY ord) FROM jsonb_array_elements($capture$[{"acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"name":"engine_tournament_leases","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"instance_id","type":"text","default":null,"notnull":true},{"name":"engine_version","type":"text","default":null,"notnull":false},{"name":"acquired_at","type":"timestamp with time zone","default":"now()","notnull":true},{"name":"heartbeat_at","type":"timestamp with time zone","default":"now()","notnull":true},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true},{"name":"protocol_version","type":"integer","default":"1","notnull":true}],"indexes":["CREATE UNIQUE INDEX engine_tournament_leases_pkey ON public.engine_tournament_leases USING btree (tournament_id)","CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at)"],"policies":null,"force_rls":false,"constraints":[{"name":"engine_tournament_leases_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"engine_tournament_leases_protocol_version_check","definition":"CHECK ((protocol_version = ANY (ARRAY[1, 2])))"},{"name":"engine_tournament_leases_tournament_id_fkey","definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"spin_draw_receipts","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"launch_id","type":"uuid","default":null,"notnull":true},{"name":"lease_generation","type":"uuid","default":null,"notnull":true},{"name":"rule_manifest","type":"jsonb","default":null,"notnull":true},{"name":"rule_sha256","type":"text","default":null,"notnull":true},{"name":"entrants","type":"jsonb","default":null,"notnull":true},{"name":"receipt","type":"jsonb","default":null,"notnull":true},{"name":"created_at","type":"timestamp with time zone","default":"transaction_timestamp()","notnull":true}],"indexes":["CREATE UNIQUE INDEX spin_draw_receipts_pkey ON public.spin_draw_receipts USING btree (tournament_id)"],"policies":null,"force_rls":false,"constraints":[{"name":"spin_draw_receipts_entrants_check","definition":"CHECK ((jsonb_array_length(entrants) = 3))"},{"name":"spin_draw_receipts_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"spin_draw_receipts_rule_sha256_check","definition":"CHECK ((rule_sha256 ~ '^[0-9a-f]{64}$'::text))"}]},{"acl":"{postgres=arwdDxtm/postgres}","rls":true,"name":"tournament_launch_receipts","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true},{"name":"launch_id","type":"uuid","default":null,"notnull":true},{"name":"started_at","type":"timestamp with time zone","default":null,"notnull":true},{"name":"claimed_at","type":"timestamp with time zone","default":"transaction_timestamp()","notnull":true},{"name":"completed_at","type":"timestamp with time zone","default":null,"notnull":false},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true},{"name":"supply_version","type":"smallint","default":"0","notnull":true}],"indexes":["CREATE UNIQUE INDEX tournament_launch_receipts_launch_id_key ON public.tournament_launch_receipts USING btree (launch_id)","CREATE UNIQUE INDEX tournament_launch_receipts_pkey ON public.tournament_launch_receipts USING btree (tournament_id)"],"policies":null,"force_rls":false,"constraints":[{"name":"tournament_launch_receipts_launch_id_key","definition":"UNIQUE (launch_id)"},{"name":"tournament_launch_receipts_pkey","definition":"PRIMARY KEY (tournament_id)"},{"name":"tournament_launch_receipts_supply_version_check","definition":"CHECK ((supply_version = 0))"},{"name":"tournament_launch_receipts_tournament_id_fkey","definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT"}]}]$capture$::jsonb) WITH ORDINALITY a(r,ord)),'business_rows_written',false,'production_qualification',false);
COMMIT;
