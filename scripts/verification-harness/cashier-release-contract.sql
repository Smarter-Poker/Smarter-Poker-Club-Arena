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
  v_private_contract jsonb;
  v_actual_owner text;
  v_security_definer boolean;
  v_search_path_pinned boolean;
  v_columns text[];
BEGIN
  SELECT string_agg(required.version, ', ' ORDER BY required.version)
  INTO v_missing
  FROM (
    VALUES
      ('20260830235990'),
      ('20260831235990'),
      ('20260831235991'),
      ('20260831235992'),
      ('20260906093024'),
      ('20260923150831'),
      ('20261004124327')
  ) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations applied
    WHERE applied.version = required.version
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'cashier migration versions missing: %', v_missing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261004124327'
       AND name = 'cashier_authority_and_retry_keys_are_exact'
  ) THEN
    RAISE EXCEPTION 'cashier authority migration history name drift';
  END IF;

  v_contract := jsonb_build_array(
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)',
      'hash', '85976e86092390fb1950b8ed31c36c0d'
    ),
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      -- The launch hardening wrapper claims the global exact-intent lock before
      -- entering the retained agreement, hierarchy and money-row lock order.
      'hash', 'c6c14eb18feb9a645a7aa2ffad3cf6f1'
    ),
    jsonb_build_object(
      'signature', 'public.fn_request_chips(uuid,numeric,text,uuid)',
      'hash', '1ec88991eae29ca25812490c742ae906'
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
    ),
    -- Active Cashier authority and globally exact retry keys.
    jsonb_build_object(
      'signature', 'public.fn_club_bank_role(uuid,uuid)',
      'hash', '36d48c9e935b77e4410075a482194dab'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_is_in_downline(uuid,uuid,uuid)',
      'hash', '038be1f54953d43ce7dc02be6fc3015c'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_cashier_members(uuid)',
      'hash', '052a7ade475196368af0e465417f23eb'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_trade_ledger(uuid,integer,integer)',
      'hash', '49797528c3b5ddfcd2ccbaa01f8a1bd3'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'd858bb9dbc4c2657c940c99f0c03b015'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_claim_back(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'a5849400f773e9ea87713e028bf9da1f'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_reverse(uuid,text,uuid)',
      'hash', '57316a8063bd10da0c74dc3cbba4a5c4'
    ),
    jsonb_build_object(
      'signature', 'public.fn_admin_remove_player_chips(uuid,uuid,numeric,text,uuid)',
      'hash', 'cbbd3827fc223013334d6e3aea86262b'
    ),
    jsonb_build_object(
      'signature', 'public.fn_promo_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      'hash', '3ca226aa6fa735dd123c68ceaa98dda3'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_promo_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'b616cd82da2a682fcdf8b8b366872eda'
    ),
    -- Phase 5 cross-wallet statement doors, recorded version 20260923150831
    -- (file 20260923131325_cashier_statements_read_every_wallet_in_one_keyset).
    -- The private row query fn_cashier_statement_rows (md5
    -- d6152f4bb944489aa4e1dfaf5417fc00) is not listed: this loop requires
    -- browser EXECUTE, which that owner-only helper must never have.
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_scope(uuid)',
      'hash', 'c8137ef74e0e7ccfb05b94697b3fb122'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)',
      'hash', '06493bb58a2199b8aaed0f950bafe2c2'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)',
      'hash', '5e50033127ded658f0bb4de87e0a10e6'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_export_start(uuid,timestamptz,timestamptz,jsonb,uuid)',
      'hash', '64d8ce9fac09f83bb04105cded1e6177'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_export_page(uuid,integer,integer)',
      'hash', '3ab1d903bbd15f1b8c97e6bc168bc466'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_export_cancel(uuid)',
      'hash', '7772e8238e42f490c20e2235d1358ce2'
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

  -- Private helpers are source-pinned separately because they must not satisfy
  -- the browser EXECUTE contract above. Only the two pure read helpers remain
  -- callable by service_role; every mutating/actor primitive is owner-only.
  v_private_contract := jsonb_build_array(
    jsonb_build_object('signature', 'public.fn_cashier_member_is_active(uuid,uuid)',
      'hash', 'b8fa4b50580e379dadc17afca61cdfe8', 'service_execute', true),
    jsonb_build_object('signature', 'public.fn_club_active_cashier_edges(uuid)',
      'hash', '7811cf9a95d7bc76037158c1285d4069', 'service_execute', true),
    jsonb_build_object('signature', 'public.fn_cashier_assert_active_actor(uuid)',
      'hash', 'fa89e518a9b123a7f3108a664f3a18dc', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_agent_status_mutex()',
      'hash', '5dee0639a212697d55abd89d9222ca9c', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_balance_actor_guard()',
      'hash', 'c40945eaa2dc22f9c12cf41a41583982', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_operation_mutex_guard()',
      'hash', '57750a582bad567907f62a2460cfc8c1', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_operation_intent_guard()',
      'hash', '40132499b244772fe6820efb3217fccd', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb)',
      'hash', '910f8859d4c683aafd4403c4f386772b', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_exact_intent_finish(uuid,jsonb)',
      'hash', 'cc05789c598b9b889a04f726b9b1e2ea', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_statement_downline(uuid,uuid)',
      'hash', 'bf72f0b13f26bf93b6a12aae579aa7d3', 'service_execute', false)
  );
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_private_contract)
  LOOP
    v_oid := to_regprocedure(v_item ->> 'signature');
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'private cashier function missing: %', v_item ->> 'signature';
    END IF;
    SELECT md5(prosrc) INTO v_actual_hash FROM pg_proc WHERE oid = v_oid;
    IF v_actual_hash <> v_item ->> 'hash' THEN
      RAISE EXCEPTION 'private cashier function drift: % expected %, got %',
        v_item ->> 'signature', v_item ->> 'hash', v_actual_hash;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
          <> (v_item ->> 'service_execute')::boolean THEN
      RAISE EXCEPTION 'private cashier function ACL drift: %', v_item ->> 'signature';
    END IF;
  END LOOP;

  -- Renaming keeps the audited production bodies intact. Certify each private
  -- core by exact source, owner, definer/search-path posture and denied caller
  -- ACLs so a same-name replacement cannot hide behind the public wrapper.
  v_private_contract := jsonb_build_array(
    jsonb_build_object('signature', 'public.fn_club_bank_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'fd7ee70c034f97894cedc51e1b413182'),
    jsonb_build_object('signature', 'public.fn_club_bank_claim_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'e9e3e8b0fef662612d4cedb68fee6c6c'),
    jsonb_build_object('signature', 'public.fn_club_bank_reverse_core_20261004(uuid,text,uuid)',
      'hash', '371e4f56185eb90bbf43b6967d61ea55'),
    jsonb_build_object('signature', 'public.fn_admin_remove_chips_core_20261004(uuid,uuid,numeric,text,uuid)',
      'hash', 'ac293c1623da0db62d74f5e888c1011a'),
    jsonb_build_object('signature', 'public.fn_promo_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'b101fc1f3280218d04d7addd155ed4ea'),
    jsonb_build_object('signature', 'public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', '69c5974c384146ed8bccc666123153a1'),
    jsonb_build_object('signature', 'public.fn_agent_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', '38d088732280d8b2cb605c87eda4af3f'),
    jsonb_build_object('signature', 'public.fn_agent_wallet_claim_back_core_20261004(uuid,uuid,numeric,text,uuid)',
      'hash', 'cf7af5fd327c68c935a58e864537cc7a'),
    jsonb_build_object('signature', 'public.fn_request_chips_core_20261004(uuid,numeric,text,uuid)',
      'hash', '7e5233ef53474fdf4f79ec8a64d6c064')
  );
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_private_contract)
  LOOP
    v_oid := to_regprocedure(v_item ->> 'signature');
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'private cashier core missing: %', v_item ->> 'signature';
    END IF;
    SELECT md5(prosrc), pg_get_userbyid(proowner), prosecdef,
           coalesce(proconfig @> ARRAY['search_path=public, pg_temp'], false)
      INTO v_actual_hash, v_actual_owner, v_security_definer, v_search_path_pinned
      FROM pg_proc WHERE oid = v_oid;
    IF v_actual_hash IS DISTINCT FROM v_item ->> 'hash'
       OR v_actual_owner IS DISTINCT FROM 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_search_path_pinned IS DISTINCT FROM true
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'private cashier core contract drift: % hash=% owner=% definer=% pinned=%',
        v_item ->> 'signature', v_actual_hash, v_actual_owner,
        v_security_definer, v_search_path_pinned;
    END IF;
  END LOOP;

  IF to_regclass('public.cashier_rpc_operation_intents') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class
              WHERE oid = 'public.cashier_rpc_operation_intents'::regclass)
     OR has_table_privilege('anon', 'public.cashier_rpc_operation_intents', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'DELETE') THEN
    RAISE EXCEPTION 'cashier exact-intent table RLS/ACL drift';
  END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.cashier_rpc_operation_intents'::regclass
     AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM ARRAY[
    'operation_id','actor_user_id','action','club_id','operation_intent',
    'intent_fingerprint','receipt','created_at','completed_at'
  ]::text[] THEN
    RAISE EXCEPTION 'cashier exact-intent table columns drift: %', v_columns;
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND p.proname = 'fn_cashier_balance_actor_guard'
        AND (c.relname, t.tgname) IN (
          ('clubs', 'cashier_club_balance_actor_guard'),
          ('club_members', 'cashier_member_balance_actor_guard'),
          ('agents', 'cashier_agent_balance_actor_guard')
        )) <> 3 THEN
    RAISE EXCEPTION 'cashier active-actor balance trigger drift';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND (
          (p.proname = 'fn_cashier_operation_mutex_guard' AND
            (c.relname, t.tgname) IN (
              ('clubs', 'cashier_club_operation_mutex'),
              ('club_members', 'cashier_member_operation_mutex'),
              ('agents', 'cashier_agent_operation_mutex')
            ))
          OR (p.proname = 'fn_cashier_agent_status_mutex' AND
            (c.relname, t.tgname) IN (
              ('agents', 'cashier_agent_status_mutex_update'),
              ('agents', 'cashier_agent_status_mutex_delete')
            ))
          OR (p.proname = 'fn_cashier_operation_intent_guard'
              AND c.relname = 'chip_transactions'
              AND t.tgname = 'cashier_operation_intent_guard')
        )) <> 6 THEN
    RAISE EXCEPTION 'cashier authority/retry serialization trigger drift';
  END IF;

  IF (SELECT count(*) FROM public.ca_declared_money_triggers d
      WHERE (d.table_name, d.trigger_name) IN (
        ('club_members', 'cashier_member_balance_actor_guard'),
        ('club_members', 'cashier_member_operation_mutex')
      )) <> 2 THEN
    RAISE EXCEPTION 'cashier club_members money-trigger declarations missing';
  END IF;

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
