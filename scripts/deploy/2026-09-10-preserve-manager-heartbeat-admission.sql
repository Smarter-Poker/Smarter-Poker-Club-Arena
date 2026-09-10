-- Prepared request-admission upgrade; no financial cutover or deal activation.
-- Requires verified actor-header adoption by all existing engine callers.
-- Exact definitions match the native manager-heartbeat and player-reveal
-- rehearsal. Authenticated reveal retains its own exact identity checks.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';

DO $manager_hook_preflight$
DECLARE
  v_signature text;
  v_expected_md5 text;
  v_expected_config text[];
  v_expected_roles text[];
  v_body_md5 text;
  v_roles text[];
  v_valid boolean;
  v_binding text;
  v_db_oid oid := (SELECT oid FROM pg_database WHERE datname=current_database());
BEGIN
  -- Both the current preimage and this exact postimage are safe re-entry points.
  FOR v_signature,v_expected_md5,v_expected_config,v_expected_roles IN
    SELECT * FROM (VALUES
      ('smarter_private.fn_smarter_data_api_pre_request()',NULL::text,
        ARRAY['search_path=pg_catalog, pg_temp'],ARRAY['anon','authenticated','postgres','service_role']),
      ('public.fn_mystery_bounty_reveal(uuid,uuid,boolean)',
        '5578ec53c8a531eeba47d448ae9af1b1',ARRAY['search_path=public, pg_temp'],ARRAY['authenticated','postgres','service_role']),
      ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
        'd1b5100c2b9f92bec5fd1680b0b4f230',ARRAY['search_path=public, pg_temp'],ARRAY['postgres','service_role']),
      ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
        '5e6c99545e07c21efcb50e5cb3441c14',ARRAY['search_path=public, pg_temp'],ARRAY['postgres','service_role'])
    ) x(signature,body_md5,config,roles)
  LOOP
    SELECT md5(p.prosrc),
      pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
        AND l.lanname='plpgsql' AND p.provolatile='v'
        AND p.proconfig=v_expected_config
        AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantor<>p.proowner OR a.is_grantable),
      (SELECT array_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
          ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE')
      INTO v_body_md5,v_valid,v_roles
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure(v_signature);
    IF v_valid IS DISTINCT FROM true OR v_roles IS DISTINCT FROM v_expected_roles
       OR (v_expected_md5 IS NOT NULL AND v_body_md5 IS DISTINCT FROM v_expected_md5)
       OR (v_expected_md5 IS NULL AND v_body_md5 NOT IN
           ('ab227471f29f2944ebd64909622b6af7','d21a055b448febe83c1637371b150100')) THEN
      RAISE EXCEPTION 'manager-hook prerequisite identity or privileges changed: %',v_signature;
    END IF;
  END LOOP;

  IF to_regprocedure('public.fn_assert_tournament_manager_write_scope(uuid)') IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE
       p.oid=to_regprocedure('public.fn_assert_tournament_manager_write_scope(uuid)')
       AND md5(p.prosrc)='06bb10766a750b370a0ecb26dbdbdbe1'
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND p.proconfig=ARRAY['search_path=public, pg_temp']
       AND p.proacl::text='{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'manager scope helper already exists with an unknown identity';
  END IF;

  SELECT substr(setting,length('pgrst.db_pre_request=')+1) INTO v_binding
    FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole
    CROSS JOIN LATERAL unnest(s.setconfig) setting
    WHERE r.rolname='authenticator' AND s.setdatabase IN (0,v_db_oid)
      AND setting LIKE 'pgrst.db_pre_request=%'
    ORDER BY (s.setdatabase=v_db_oid) DESC LIMIT 1;
  IF v_binding IS DISTINCT FROM 'smarter_private.fn_smarter_data_api_pre_request'
     OR to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'the existing private PostgREST hook binding is not exact';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE
      tgrelid=to_regclass('public.tournament_obligations')
      AND tgname='require_exact_final_deal_proposal' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'isolated manager hook upgrade requires deal activation to remain absent';
  END IF;
  -- Capture only fingerprints, keeping private settings inside the transaction.
  PERFORM set_config('app.ca_manager_hook_role_settings_before',
    (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.setdatabase,s.setrole)::text,'[]'))
      FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole
      WHERE r.rolname='authenticator'),true);
  PERFORM set_config('app.ca_manager_hook_schema_acl_before',
    (SELECT md5(COALESCE(n.nspacl::text,'')) FROM pg_namespace n WHERE n.nspname='smarter_private'),true);
END;
$manager_hook_preflight$;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  v_stale_seconds constant integer := 30;
  v_manager_exclusive_paths constant text[] := ARRAY[
    'rpc/fn_ack_tournament_capacity_tables',
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_bounty_obligation_has_complete_marker',
    'rpc/fn_claim_tournament_bounty_elimination',
    'rpc/fn_close_tournament_addon_period',
    'rpc/fn_close_empty_tournament_table',
    'rpc/fn_close_tournament_entry_window',
    'rpc/fn_collect_bounty',
    'rpc/fn_complete_tournament_entry_reprice',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_complete_tournament_terminal_proposal',
    'rpc/fn_begin_tournament_deal_review',
    'rpc/fn_close_tournament_deal_review',
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_eliminate_tournament_player_atomic',
    'rpc/fn_ensure_late_registration_capacity',
    'rpc/fn_get_tournament_satellite_entitlement_depth',
    'rpc/fn_mystery_bounty_pay',
    'rpc/fn_mystery_bounty_reserve',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/fn_mystery_bounty_seed',
    'rpc/fn_move_tournament_player',
    'rpc/fn_move_tournament_player_atomic',
    'rpc/fn_open_tournament_rebuy_decisions',
    'rpc/fn_settle_final_table_deal_atomic',
    'rpc/fn_spin_draw_and_settle_atomic',
    'rpc/fn_spin_draw_multiplier',
    'rpc/fn_spin_settle_game',
    'rpc/fn_sync_tournament_live_seat_chips',
    'rpc/fn_tournament_has_unsettled_bounties',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/claim_table_lease_v2',
    'rpc/claim_tournament_lease_v2',
    'rpc/fn_ack_tournament_manager_wakes',
    'rpc/fn_apply_prize_guarantee',
    'rpc/fn_ca_commit_hand_settlement',
    'rpc/fn_ca_process_hand_post_commit_obligations',
    'rpc/fn_certify_tournament_finish',
    'rpc/fn_claim_tournament_finish',
    'rpc/fn_finalize_bounty_pool',
    'rpc/fn_mystery_bounty_settle',
    'rpc/fn_normalize_tournament_final_standings',
    'rpc/fn_prepare_tournament_place_obligations',
    'rpc/fn_project_hand_side_effects',
    'rpc/fn_settle_satellite_finish_atomic',
    'rpc/fn_settle_tournament_obligation',
    'rpc/fn_settle_tournament_places_atomic',
    'rpc/fn_settle_tournament_rake',
    'rpc/fn_sweep_pending_tournament_bounties',
    'rpc/fn_sync_seat_first_player_count',
    'rpc/heartbeat_table_leases_v3',
    'rpc/heartbeat_tournament_leases_v3',
    'rpc/heartbeat_tournament_leases_v4',
    'rpc/release_table_leases_v2',
    'rpc/release_tournament_leases_v2'
  ]::text[];
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* SECURITY DEFINER makes current_user the function owner.  The JWT claims
     supplied and verified by PostgREST are the request identity here. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));
  /* Direct PostgREST reports `rpc/name`; Supabase gateways may retain the
     `rest/v1/` prefix. Normalize both shapes before applying the same exact
     route allowlist. Never use a suffix/substring match for authority. */
  IF left(v_path, 8) = 'rest/v1/' THEN
    v_path := substr(v_path, 9);
  END IF;

  /* Transaction-local settings are reset by PostgreSQL at transaction end,
     but clear the proof explicitly before evaluating this request as a
     fail-closed defence against an incorrectly pooled session. */
  PERFORM set_config('app.smarter_manager_request_fenced', '', true);
  PERFORM set_config('app.smarter_manager_deleted_table_ids', '', true);

  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* This hook is shared by the entire estate. Do not turn the shared
     service-role credential into a Club-Arena-only protocol. Restrict only
     the RPC routes whose authority belongs to the engine. Manager-exclusive
     routes fail when a callback loses its bound manager context; recovery and
     lease-coordination routes accept the explicitly marked service actor too.
     Old/headerless engine binaries can use neither family after cutover. */
  -- Rebuy, decline and mystery reveal are shared player/manager RPCs. Their
  -- authenticated callers retain each function's own player/session checks
  -- (reveal uses auth.uid(), never supplied actor/auto) and receive no manager
  -- proof. All server callers still require their exact manager lease.
  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager'
     AND NOT (
       v_request_role = 'authenticated'
       AND v_actor = ''
       AND v_path IN (
         'rpc/process_tournament_rebuy', 'rpc/fn_decline_tournament_rebuy',
         'rpc/fn_mystery_bounty_reveal'
       )
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED: manager RPC requires exact lease authority'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_engine_service_paths)
     AND v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION
      'ENGINE_DATA_AUTHORITY_REQUIRED: engine RPC requires an identified service actor'
      USING ERRCODE = '42501';
  END IF;

  /* Unrelated World Hub/Club Arena service traffic deliberately remains
     compatible when unmarked. Browser traffic keeps its normal unmarked
     shape too. Only the engine-private paths above require identification. */
  IF v_actor = '' THEN
    IF v_request_role = 'service_role' THEN
      PERFORM set_config('app.smarter_data_actor', 'shared-estate-service', true);
    ELSE
      PERFORM set_config('app.smarter_data_actor', 'browser', true);
    END IF;
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
  /* This marker is written last and only after the exact lease row is held
     FOR KEY SHARE. Row triggers can consume this transaction proof without doing
     the same indexed lease read again for every affected row. */
  PERFORM set_config('app.smarter_manager_request_fenced', 'protocol-2', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_lease_generation uuid;
BEGIN
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED: manager actor is absent'
      USING ERRCODE = '42501';
  END IF;

  IF current_setting('app.smarter_manager_request_fenced', true)
       IS DISTINCT FROM 'protocol-2' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_REQUIRED: request lease proof is absent'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_tournament_id :=
      NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_lease_generation :=
      NULLIF(
        current_setting('app.smarter_tournament_lease_generation', true),
        ''
      )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed authority context'
      USING ERRCODE = '22023';
  END;

  IF p_tournament_id IS NULL
     OR v_tournament_id IS NULL
     OR v_lease_generation IS NULL
     OR p_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: row belongs to another tournament'
      USING ERRCODE = '42501';
  END IF;

END;
$function$;

-- The helper is an internal call target for existing DEFINER interfaces.
REVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

DO $manager_hook_postflight$
DECLARE v_valid boolean;
BEGIN
  SELECT bool_and(COALESCE(
    md5(p.prosrc)=e.body_md5 AND pg_get_userbyid(p.proowner)='postgres'
      AND p.prosecdef AND l.lanname='plpgsql' AND p.provolatile='v'
      AND p.proconfig=e.config
      AND (SELECT array_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
          ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE')=e.roles
      AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantor<>p.proowner OR a.is_grantable)
  ,false)) INTO v_valid
  FROM (VALUES
    ('smarter_private.fn_smarter_data_api_pre_request()','d21a055b448febe83c1637371b150100',
      ARRAY['search_path=pg_catalog, pg_temp'],ARRAY['anon','authenticated','postgres','service_role']),
    ('public.fn_assert_tournament_manager_write_scope(uuid)','06bb10766a750b370a0ecb26dbdbdbe1',
      ARRAY['search_path=public, pg_temp'],ARRAY['postgres']),
    ('public.fn_mystery_bounty_reveal(uuid,uuid,boolean)','5578ec53c8a531eeba47d448ae9af1b1',
      ARRAY['search_path=public, pg_temp'],ARRAY['authenticated','postgres','service_role']),
    ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)','d1b5100c2b9f92bec5fd1680b0b4f230',
      ARRAY['search_path=public, pg_temp'],ARRAY['postgres','service_role']),
    ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)','5e6c99545e07c21efcb50e5cb3441c14',
      ARRAY['search_path=public, pg_temp'],ARRAY['postgres','service_role'])
  ) e(signature,body_md5,config,roles)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
  LEFT JOIN pg_language l ON l.oid=p.prolang;
  IF v_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'manager hook or lease authority postcondition differs';
  END IF;
  IF current_setting('app.ca_manager_hook_role_settings_before') IS DISTINCT FROM
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.setdatabase,s.setrole)::text,'[]'))
        FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='authenticator')
     OR current_setting('app.ca_manager_hook_schema_acl_before') IS DISTINCT FROM
      (SELECT md5(COALESCE(n.nspacl::text,'')) FROM pg_namespace n WHERE n.nspname='smarter_private') THEN
    RAISE EXCEPTION 'existing private hook binding or schema ACL changed';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE
      tgrelid=to_regclass('public.tournament_obligations')
      AND tgname='require_exact_final_deal_proposal' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'deal activation changed during isolated hook upgrade';
  END IF;
END;
$manager_hook_postflight$;

NOTIFY pgrst,'reload schema';
COMMIT;
