\set ON_ERROR_STOP on

-- Read-only post-deploy canary. It verifies the contracts the browser depends
-- on, not merely that similarly named objects exist.
BEGIN;
SET TRANSACTION READ ONLY;

DO $cashier_contract$
DECLARE
  v_contract jsonb;
  v_item jsonb;
  v_oid oid;
  v_actual_hash text;
  v_missing text;
  v_request_source text;
  v_telemetry_source text;
  v_telemetry_oid oid;
BEGIN
  SELECT string_agg(required.version, ', ' ORDER BY required.version)
  INTO v_missing
  FROM (
    VALUES
      ('20260830235990'),
      ('20260831235990'),
      ('20260831235991'),
      ('20260831235992'),
      ('20260906093024')
  ) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations applied
    WHERE applied.version = required.version
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'cashier migration versions missing: %', v_missing;
  END IF;

  v_contract := jsonb_build_array(
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)',
      'hash', '31d05a227849bda2a1195594c57b90eb'
    ),
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      'hash', '0214036f29a6d121842496c91c7912af'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)',
      'hash', '0252faecc9c3e8dd506ccd00061243cb'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_cashier_can_transact(uuid,uuid,uuid)',
      -- The Realtime WAL repair converts this read-only helper from PL/pgSQL
      -- to equivalent SQL so its scope is resolved once. Production may move
      -- before the application bundle while deploys converge, so both audited
      -- definitions are valid; an unknown third body must still fail closed.
      'hash', '6e02bd4dcb663130bedb41816968350e',
      'replacement_hash', 'a812c44870554f37cddb36edf600e386'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer)',
      -- Re-pinned 2026-09-03. The body changed for a REASON, not by drift:
      -- 20260903035252 wrapped the flag as
      --   (public.fn_can_see_horse_flag(p_club_id) AND COALESCE(m.is_horse,false))
      -- because v2 masked the horse flag and this paged v3, written after it,
      -- did not - so the same data leaked through the newer door to anyone
      -- ca_can_view_club_finances admits, SUPER_AGENT included.
      -- The migration was applied to production but never committed, so this
      -- pin was left naming a body that no longer existed and Post-Deploy E2E
      -- failed on it every run. The migration is committed alongside this.
      -- Every OTHER hash in this file was re-checked against production at the
      -- same time and all five still match.
      'hash', '69233cd46670fbc2989173f6ba9f4328'
    ),
    jsonb_build_object(
      'signature', 'public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text)',
      'hash', 'a8a8a18f4ee84e0b2e147ebdc380e5d1'
    )
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_contract)
  LOOP
    v_oid := to_regprocedure(v_item ->> 'signature');
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'cashier function missing: %', v_item ->> 'signature';
    END IF;
    SELECT md5(pg_get_functiondef(v_oid)) INTO v_actual_hash;
    IF v_actual_hash <> v_item ->> 'hash'
       AND v_actual_hash <> coalesce(v_item ->> 'replacement_hash', '') THEN
      RAISE EXCEPTION 'cashier function drift: % expected %, got %',
        v_item ->> 'signature',
        CASE
          WHEN v_item ? 'replacement_hash'
            THEN concat(v_item ->> 'hash', ' or ', v_item ->> 'replacement_hash')
          ELSE v_item ->> 'hash'
        END,
        v_actual_hash;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'cashier function is not SECURITY DEFINER: %', v_item ->> 'signature';
    END IF;
    IF NOT coalesce((SELECT proconfig @> ARRAY['search_path=public, pg_temp']
                     FROM pg_proc WHERE oid = v_oid), false) THEN
      RAISE EXCEPTION 'cashier function search_path is not pinned: %', v_item ->> 'signature';
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'cashier function ACL drift: %', v_item ->> 'signature';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'club_members'
      AND policyname = 'cashier_downline_read' AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']::name[]
      AND qual LIKE '%fn_club_cashier_can_transact%'
  ) THEN
    RAISE EXCEPTION 'club_members cashier_downline_read policy drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agents'
      AND policyname = 'agents_cashier_scoped_read' AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']::name[]
      AND qual LIKE '%fn_club_cashier_can_transact%'
  ) THEN
    RAISE EXCEPTION 'agents cashier-scoped policy drift';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgenabled <> 'D'
        AND tgname IN (
          'trg_block_browser_balance_inserts',
          'trg_block_browser_balance_writes',
          'trg_block_browser_treasury_writes'
        )) <> 3 THEN
    RAISE EXCEPTION 'browser balance trigger contract drift';
  END IF;

  IF (SELECT count(*) FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indisvalid AND i.indisready
        AND c.relname IN (
          'club_members_cashier_tree_idx',
          'chip_transactions_club_from_created_idx',
          'chip_transactions_club_to_created_idx'
        )) <> 3 THEN
    RAISE EXCEPTION 'cashier performance index contract drift';
  END IF;

  SELECT lower(prosrc)
    INTO v_request_source
    FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_request_chips(uuid,numeric,text,uuid)');
  IF v_request_source IS NULL OR v_request_source NOT LIKE '%if p_op_id is null then%' THEN
    RAISE EXCEPTION 'cashier request idempotency contract drift';
  END IF;

  v_telemetry_oid := to_regprocedure(
    'public.fn_record_cashier_operation(uuid,text,text,integer,integer,integer,integer,integer,text)'
  );
  IF v_telemetry_oid IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_telemetry_oid)
     OR NOT coalesce((SELECT proconfig @> ARRAY['search_path=public, pg_temp']
                      FROM pg_proc WHERE oid = v_telemetry_oid), false)
     OR has_function_privilege('anon', v_telemetry_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_telemetry_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_telemetry_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'cashier telemetry RPC contract drift';
  END IF;
  SELECT lower(prosrc) INTO v_telemetry_source FROM pg_proc WHERE oid = v_telemetry_oid;
  IF v_telemetry_source NOT LIKE '%auth.uid()%'
     OR v_telemetry_source NOT LIKE '%fn_club_cashier_scope%'
     OR v_telemetry_source NOT LIKE '%cashier_operation%' THEN
    RAISE EXCEPTION 'cashier telemetry identity/scope/rate contract drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.cashier_operations'::regclass AND relrowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cashier_operations'
      AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'cashier telemetry RLS contract drift';
  END IF;

  IF has_table_privilege('authenticated', 'public.cashier_operations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cashier_operations', 'SELECT')
     OR has_sequence_privilege('authenticated', 'public.cashier_operations_id_seq', 'USAGE')
     OR NOT has_table_privilege('service_role', 'public.v_cashier_health_hourly', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_cashier_health_hourly', 'SELECT') THEN
    RAISE EXCEPTION 'cashier telemetry ACL drift';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rate_limits'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ) OR has_table_privilege('anon', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('anon', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('anon', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('anon', 'public.rate_limits', 'DELETE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'DELETE') THEN
    RAISE EXCEPTION 'cashier limiter access boundary drift';
  END IF;
END;
$cashier_contract$;

SELECT 'cashier release contract: versions, hashes, ACLs, RLS, triggers and indexes verified' AS result;
ROLLBACK;
