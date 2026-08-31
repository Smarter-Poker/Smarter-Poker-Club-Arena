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
BEGIN
  SELECT string_agg(required.version, ', ' ORDER BY required.version)
  INTO v_missing
  FROM (
    VALUES
      ('20260830235990'),
      ('20260831235990'),
      ('20260831235991'),
      ('20260831235992')
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
      'hash', '6e02bd4dcb663130bedb41816968350e'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer)',
      'hash', '952e98a237f975ca9bac24251efe6d54'
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
    IF v_actual_hash <> v_item ->> 'hash' THEN
      RAISE EXCEPTION 'cashier function drift: % expected %, got %',
        v_item ->> 'signature', v_item ->> 'hash', v_actual_hash;
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.cashier_operations'::regclass AND relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cashier_operations'
      AND policyname = 'cashier_operations_insert_own' AND cmd = 'INSERT'
      AND with_check LIKE '%auth.uid()%'
  ) THEN
    RAISE EXCEPTION 'cashier telemetry RLS contract drift';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.cashier_operations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cashier_operations', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_cashier_health_hourly', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_cashier_health_hourly', 'SELECT') THEN
    RAISE EXCEPTION 'cashier telemetry ACL drift';
  END IF;
END;
$cashier_contract$;

SELECT 'cashier release contract: versions, hashes, ACLs, RLS, triggers and indexes verified' AS result;
ROLLBACK;
