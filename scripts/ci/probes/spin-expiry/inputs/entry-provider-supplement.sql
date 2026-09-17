-- SOURCE ONLY / UNRUN. Isolated FIFO5 funded-fixture provider supplement.
-- Not a production migration, fixture admission, financial seed or business call.
-- Restore only absent captured objects; refuse replay/drift in one transaction.
-- Existing11 captured functions are checked, never replaced. No trigger is altered.
-- Current policy shape is restored EMPTY; an approved positive fixture policy belongs
-- to the separately owned fixture. No clocks, seats, balances or histories change here.
-- Apply after notification0013 schema/access/policies/provider supplement and the
-- accepted Spin catalog supplement, before any genuine funded fixture operation.
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL statement_timeout='15s';
DO $boundary$
DECLARE v_signature text;
BEGIN
  IF current_user <> 'fixture_bootstrap' OR session_user <> 'fixture_bootstrap'
     OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
     OR current_database() <> 'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid'),'-','')
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR to_regclass('public.spin_fill_policy') IS NOT NULL
  THEN RAISE EXCEPTION 'entry supplement requires exact isolated empty-object boundary'; END IF;
  FOREACH v_signature IN ARRAY ARRAY['public.fn_create_seat_first_game_atomic(uuid,jsonb)','public.fn_ensure_agent_row(uuid,uuid,text)','public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)','public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)','public.fn_take_seat_and_buy_in(uuid,integer)','public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)'] LOOP
    IF to_regprocedure(v_signature) IS NOT NULL THEN
      RAISE EXCEPTION 'entry supplement refuses existing object: %',v_signature;
    END IF;
  END LOOP;
  IF to_regclass('auth.sessions_not_after_idx') IS NOT NULL THEN RAISE EXCEPTION 'entry supplement refuses existing index: auth.sessions_not_after_idx'; END IF;
  IF to_regclass('auth.sessions_oauth_client_id_idx') IS NOT NULL THEN RAISE EXCEPTION 'entry supplement refuses existing index: auth.sessions_oauth_client_id_idx'; END IF;
  IF to_regclass('auth.sessions_user_id_idx') IS NOT NULL THEN RAISE EXCEPTION 'entry supplement refuses existing index: auth.sessions_user_id_idx'; END IF;
  IF to_regclass('auth.user_id_created_at_idx') IS NOT NULL THEN RAISE EXCEPTION 'entry supplement refuses existing index: auth.user_id_created_at_idx'; END IF;
END $boundary$;

DO $existing_functions_before$
DECLARE v_expected jsonb; v_actual jsonb;
BEGIN
  FOR v_expected IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"24fc93502f66beb34c31e1a16c87a147"},{"signature":"fn_entry_purchases_frozen()","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":false,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"sql","prokind":"f","full_definition_md5":"0b05e2e7905caf71f14c8327a172cea0"},{"signature":"fn_register_for_tournament(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"0f3b104a1bf9431d70053c656fedc081"},{"signature":"fn_register_for_tournament(uuid)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"sql","prokind":"f","full_definition_md5":"52ae0199d26af5deeaa5d865ef178c39"},{"signature":"fn_sync_seat_first_player_count(uuid)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"6ca19586d771591fb674d07e4b0c323c"},{"signature":"fn_caller_is_engine()","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=pg_catalog, public, auth"],"prosecdef":false,"provolatile":"s","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"sql","prokind":"f","full_definition_md5":"d9a70f1d932538025e656bfe2b4d091d"},{"signature":"fn_caller_session_is_live()","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=pg_catalog, public, auth"],"prosecdef":true,"provolatile":"s","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"23ffeea99f9d9e76102ecbf6185222c0"},{"signature":"fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"2f1b8cafdab8cb2249bdcdd0d12e36c2"},{"signature":"fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"1f5b646bfa52cafa0c3a678324cf3e56"},{"signature":"fn_register_for_tournament_before_maintenance_announcement_gate(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"8f5f2fb6976198a19f0a79fbcde4559b"},{"signature":"fn_register_for_tournament_before_terminal_seat_gate(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"e65fe889128c1ce4306b1236cb44484a"}]$expected$::jsonb) LOOP
    SELECT jsonb_build_object('signature',v_expected->>'signature',
      'owner',pg_get_userbyid(p.proowner),'proacl',p.proacl::text,
      'proconfig',to_jsonb(p.proconfig),'prosecdef',p.prosecdef,
      'provolatile',p.provolatile,'proparallel',p.proparallel,
      'proisstrict',p.proisstrict,'proleakproof',p.proleakproof,
      'prokind',p.prokind,'language',l.lanname,
      'full_definition_md5',md5(pg_get_functiondef(p.oid))) INTO v_actual
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid=to_regprocedure('public.'||(v_expected->>'signature'));
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'entry provider function authority differs: %',v_expected->>'signature';
    END IF;
  END LOOP;
END $existing_functions_before$;

DO $auth_sessions_before$
DECLARE v_expected jsonb; v_actual jsonb;
BEGIN
  FOR v_expected IN SELECT value FROM jsonb_array_elements($expected$[{"ns":"auth","name":"sessions","relkind":"r","relpersistence":"p","owner":"supabase_auth_admin","relacl":"{postgres=ar*wdDxtm/supabase_auth_admin,supabase_auth_admin=arwdDxtm/supabase_auth_admin,dashboard_user=arwdDxtm/supabase_auth_admin}","relrowsecurity":true,"relforcerowsecurity":false,"columns":[{"acl":null,"name":"id","type":"uuid","attnum":1,"default":null,"notnull":true,"identity":"","generated":""},{"acl":null,"name":"user_id","type":"uuid","attnum":2,"default":null,"notnull":true,"identity":"","generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","attnum":3,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","attnum":4,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"factor_id","type":"uuid","attnum":5,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"aal","type":"auth.aal_level","attnum":6,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"not_after","type":"timestamp with time zone","attnum":7,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"refreshed_at","type":"timestamp without time zone","attnum":8,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"user_agent","type":"text","attnum":9,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"ip","type":"inet","attnum":10,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"tag","type":"text","attnum":11,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"oauth_client_id","type":"uuid","attnum":12,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"refresh_token_hmac_key","type":"text","attnum":13,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"refresh_token_counter","type":"bigint","attnum":14,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"scopes","type":"text","attnum":15,"default":null,"notnull":false,"identity":"","generated":""}],"constraints":[{"name":"sessions_oauth_client_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE"},{"name":"sessions_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"sessions_scopes_length","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((char_length(scopes) <= 4096))"},{"name":"sessions_user_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"}],"indexes":[{"name":"auth.sessions_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX sessions_pkey ON auth.sessions USING btree (id)"}],"triggers":null,"policies":null}]$expected$::jsonb) LOOP
    SELECT to_jsonb(q)-'observed_at' INTO v_actual FROM (
      WITH wanted(ns,name) AS (VALUES (v_expected->>'ns',v_expected->>'name')) SELECT clock_timestamp() observed_at,w.ns,w.name,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) owner,c.relacl::text relacl,c.relrowsecurity,c.relforcerowsecurity,(SELECT jsonb_agg(jsonb_build_object('attnum',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,'definition',pg_get_constraintdef(k.oid)) ORDER BY k.conname)FROM pg_constraint k WHERE k.conrelid=c.oid) constraints,(SELECT jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,'primary',i.indisprimary,'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text)FROM pg_index i WHERE i.indrelid=c.oid) indexes,(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname)FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers,(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles::text,'permissive',p.polpermissive,'cmd',p.polcmd,'qual',pg_get_expr(p.polqual,p.polrelid),'with_check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)FROM pg_policy p WHERE p.polrelid=c.oid) policies FROM wanted w JOIN pg_namespace n ON n.nspname=w.ns JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=w.name ORDER BY w.ns,w.name
    ) q;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'entry provider relation authority differs: %.%',v_expected->>'ns',v_expected->>'name';
    END IF;
  END LOOP;
END $auth_sessions_before$;

-- The authentic auth.sessions table is unchanged; restore its four absent
-- standalone indexes under the bootstrap owner authority. PostgreSQL binds each
-- index owner to the existing supabase_auth_admin-owned table.
CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC);
CREATE INDEX sessions_oauth_client_id_idx ON auth.sessions USING btree (oauth_client_id);
CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id);
CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at);

SET LOCAL ROLE postgres;
CREATE TABLE public.spin_fill_policy (
  id boolean DEFAULT true NOT NULL,
  unfilled_timeout_minutes integer DEFAULT 30 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT spin_fill_policy_id_check CHECK (id),
  CONSTRAINT spin_fill_policy_pkey PRIMARY KEY (id),
  CONSTRAINT spin_fill_policy_sane CHECK (((unfilled_timeout_minutes >= 0) AND (unfilled_timeout_minutes <= 10080)))
);
ALTER TABLE public.spin_fill_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.spin_fill_policy FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT ALL ON TABLE public.spin_fill_policy TO postgres, service_role;

-- Captured full-definition MD5 92cbf5680d78bdbaa4309412b3d19dfd
CREATE OR REPLACE FUNCTION public.fn_create_seat_first_game_atomic(p_tournament_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_existing public.tournaments%ROWTYPE;
  v_existing_table public.tables%ROWTYPE;
  v_existing_table_count integer;
  v_created public.tournaments%ROWTYPE;
  v_table_id uuid;
  v_club_id uuid;
  v_union_id uuid;
  v_name text;
  v_game_type text;
  v_table_variant text;
  v_variant text;
  v_tournament_type text;
  v_buy_in numeric;
  v_buy_in_fee numeric;
  v_guarantee numeric;
  v_starting_chips integer;
  v_max_players integer;
  v_min_players integer;
  v_table_size integer;
  v_blinds jsonb;
  v_payouts jsonb;
  v_start_time timestamptz;
  v_late_reg_levels integer;
  v_late_reg_mins integer;
  v_satellite_target_id uuid;
  v_satellite_seats integer;
  v_short_description text;
  v_requested_current_players integer;
  v_requested_status text;
  v_first_level jsonb;
  v_small_blind numeric;
  v_big_blind numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_REQUEST'
      USING ERRCODE = '22023';
  END IF;

  /* Every accepted request key must be represented by the durable pair below.
     Rejecting unknown keys prevents an idempotent replay from appearing exact
     after a caller adds configuration this creator silently ignores. */
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_config) AS supplied(key)
     WHERE supplied.key NOT IN (
       'club_id', 'union_id', 'name', 'game_type', 'variant',
       'tournament_type', 'buy_in_amount', 'buy_in_fee', 'guaranteed_prize',
       'starting_chips', 'max_players', 'min_players', 'table_size',
       'current_players', 'status', 'blind_structure', 'payout_structure',
       'start_time', 'late_reg_levels', 'late_reg_mins',
       'satellite_target_id', 'satellite_seats', 'short_description',
       'spin_multiplier', 'spin_locked_tiers'
     )
  ) THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY'
      USING ERRCODE = '22023';
  END IF;

  /* This is an entry-producing transaction. It takes the same first lock as
     every purchase path, before the idempotency key or either game row. */
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:seat-first-create:' || p_tournament_id::text, 0)
  );

  v_club_id := NULLIF(p_config->>'club_id', '')::uuid;
  v_union_id := NULLIF(p_config->>'union_id', '')::uuid;
  v_name := NULLIF(btrim(p_config->>'name'), '');
  v_game_type := NULLIF(btrim(p_config->>'game_type'), '');
  v_table_variant := lower(v_game_type);
  v_variant := lower(NULLIF(btrim(p_config->>'variant'), ''));
  v_tournament_type := upper(NULLIF(btrim(p_config->>'tournament_type'), ''));
  v_buy_in := COALESCE(NULLIF(p_config->>'buy_in_amount', '')::numeric, 0);
  v_buy_in_fee := COALESCE(NULLIF(p_config->>'buy_in_fee', '')::numeric, 0);
  v_guarantee := COALESCE(NULLIF(p_config->>'guaranteed_prize', '')::numeric, 0);
  v_starting_chips := NULLIF(p_config->>'starting_chips', '')::integer;
  v_max_players := NULLIF(p_config->>'max_players', '')::integer;
  v_min_players := COALESCE(NULLIF(p_config->>'min_players', '')::integer, v_max_players);
  v_table_size := COALESCE(NULLIF(p_config->>'table_size', '')::integer, v_max_players);
  v_blinds := p_config->'blind_structure';
  v_payouts := COALESCE(p_config->'payout_structure', '[]'::jsonb);
  v_start_time := NULLIF(p_config->>'start_time', '')::timestamptz;
  v_late_reg_levels := COALESCE(NULLIF(p_config->>'late_reg_levels', '')::integer, 0);
  v_late_reg_mins := COALESCE(NULLIF(p_config->>'late_reg_mins', '')::integer, 0);
  v_satellite_target_id := NULLIF(p_config->>'satellite_target_id', '')::uuid;
  v_satellite_seats := NULLIF(p_config->>'satellite_seats', '')::integer;
  v_short_description := NULLIF(btrim(p_config->>'short_description'), '');
  v_requested_current_players :=
    COALESCE(NULLIF(p_config->>'current_players', '')::integer, 0);
  v_requested_status :=
    upper(COALESCE(NULLIF(btrim(p_config->>'status'), ''), 'REGISTERING'));

  IF v_club_id IS NULL
     OR v_name IS NULL
     OR v_game_type IS NULL
     OR v_variant IS NULL
     OR v_tournament_type IS NULL
     OR v_starting_chips IS NULL OR v_starting_chips <= 0
     OR v_max_players IS NULL OR v_max_players < 2 OR v_max_players > 3
     OR v_min_players < 2 OR v_min_players > v_max_players
     OR v_table_size <> v_max_players
     OR v_start_time IS NULL
     OR jsonb_typeof(v_blinds) <> 'array'
     OR jsonb_array_length(v_blinds) = 0
     OR jsonb_typeof(v_payouts) <> 'array'
     OR NOT (v_variant = 'spin' OR v_max_players = 2)
     OR v_tournament_type NOT IN ('SPIN', 'SNG', 'SATELLITE')
     OR v_table_variant NOT IN ('nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'flh', 'flo8')
     OR v_requested_current_players <> 0
     OR v_requested_status <> 'REGISTERING'
     OR NULLIF(p_config->>'spin_multiplier', '') IS NOT NULL
     OR (
       p_config ? 'spin_locked_tiers'
       AND jsonb_typeof(p_config->'spin_locked_tiers') IS DISTINCT FROM 'null'
     )
     OR (v_tournament_type = 'SPIN' AND (v_variant <> 'spin' OR v_max_players <> 3))
     OR (
       v_tournament_type = 'SATELLITE'
       AND (
         v_satellite_target_id IS NULL
         OR v_satellite_seats IS NULL
         OR v_satellite_seats <= 0
         OR v_satellite_seats > v_max_players
       )
     )
     OR (
       v_tournament_type <> 'SATELLITE'
       AND (v_satellite_target_id IS NOT NULL OR v_satellite_seats IS NOT NULL)
     )
     OR v_buy_in < 0 OR v_buy_in_fee < 0 OR v_guarantee < 0 THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_CONFIG'
      USING ERRCODE = '22023';
  END IF;

  v_first_level := v_blinds->0;
  v_small_blind := COALESCE(
    NULLIF(v_first_level->>'smallBlind', '')::numeric,
    NULLIF(v_first_level->>'small_blind', '')::numeric,
    NULLIF(v_first_level->>'sb', '')::numeric
  );
  v_big_blind := COALESCE(
    NULLIF(v_first_level->>'bigBlind', '')::numeric,
    NULLIF(v_first_level->>'big_blind', '')::numeric,
    NULLIF(v_first_level->>'bb', '')::numeric
  );
  IF v_small_blind IS NULL OR v_small_blind <= 0
     OR v_big_blind IS NULL OR v_big_blind < v_small_blind THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_BLINDS'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    SELECT count(*) INTO v_existing_table_count
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running');

    IF v_existing_table_count <> 1 THEN
      RAISE EXCEPTION
        'SEAT_FIRST_ATOMIC_PARTIAL_STATE: tournament % has % joinable tables',
        p_tournament_id, v_existing_table_count
        USING ERRCODE = '23514';
    END IF;

    SELECT tb.* INTO v_existing_table
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running')
     ORDER BY tb.created_at, tb.id
     LIMIT 1
     FOR UPDATE;
    v_table_id := v_existing_table.id;

    IF v_existing.club_id IS DISTINCT FROM v_club_id
       OR v_existing.union_id IS DISTINCT FROM v_union_id
       OR v_existing.name IS DISTINCT FROM v_name
       OR lower(v_existing.game_type) IS DISTINCT FROM lower(v_game_type)
       OR lower(v_existing.variant) IS DISTINCT FROM v_variant
       OR upper(v_existing.tournament_type) IS DISTINCT FROM v_tournament_type
       OR v_existing.buy_in_amount IS DISTINCT FROM v_buy_in
       OR v_existing.buy_in_fee IS DISTINCT FROM v_buy_in_fee
       OR v_existing.guaranteed_prize IS DISTINCT FROM v_guarantee
       OR v_existing.starting_chips IS DISTINCT FROM v_starting_chips
       OR v_existing.max_players IS DISTINCT FROM v_max_players
       OR v_existing.min_players IS DISTINCT FROM v_min_players
       OR v_existing.table_size IS DISTINCT FROM v_table_size
       OR (v_existing.blind_structure)::jsonb IS DISTINCT FROM v_blinds
       OR (v_existing.payout_structure)::jsonb IS DISTINCT FROM v_payouts
       OR v_existing.start_time IS DISTINCT FROM v_start_time
       OR v_existing.late_reg_levels IS DISTINCT FROM v_late_reg_levels
       OR v_existing.late_reg_mins IS DISTINCT FROM v_late_reg_mins
       OR v_existing.satellite_target_id IS DISTINCT FROM v_satellite_target_id
       OR v_existing.satellite_seats IS DISTINCT FROM v_satellite_seats
       OR v_existing.short_description IS DISTINCT FROM v_short_description
       OR v_existing_table.club_id IS DISTINCT FROM v_club_id
       OR v_existing_table.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_existing_table.name IS DISTINCT FROM v_name
       OR lower(v_existing_table.game_type) IS DISTINCT FROM 'tournament'
       OR lower(v_existing_table.game_variant) IS DISTINCT FROM v_table_variant
       OR v_existing_table.stakes IS DISTINCT FROM
          (v_small_blind::text || '/' || v_big_blind::text)
       OR v_existing_table.small_blind IS DISTINCT FROM v_small_blind
       OR v_existing_table.big_blind IS DISTINCT FROM v_big_blind
       OR v_existing_table.min_buy_in IS DISTINCT FROM 0::numeric
       OR v_existing_table.max_buy_in IS DISTINCT FROM 0::numeric
       OR v_existing_table.max_players IS DISTINCT FROM v_max_players THEN
      RAISE EXCEPTION 'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH: %', p_tournament_id
        USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'replayed', true,
      'tournament', to_jsonb(v_existing),
      'table_id', v_table_id
    );
  END IF;

  INSERT INTO public.tournaments (
    id, club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips,
    max_players, min_players, table_size, current_players, status,
    blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins,
    satellite_target_id, satellite_seats, short_description
  ) VALUES (
    p_tournament_id, v_club_id, v_union_id, v_name, v_game_type, v_variant,
    v_tournament_type, v_buy_in, v_buy_in_fee, v_guarantee, v_starting_chips,
    v_max_players, v_min_players, v_table_size, 0, 'REGISTERING',
    v_blinds::text, v_payouts::text, v_start_time,
    v_late_reg_levels, v_late_reg_mins,
    v_satellite_target_id, v_satellite_seats, v_short_description
  ) RETURNING * INTO v_created;

  INSERT INTO public.tables (
    club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in,
    max_players, current_players, status
  ) VALUES (
    v_club_id, p_tournament_id, v_name, 'tournament', v_table_variant,
    v_small_blind::text || '/' || v_big_blind::text,
    v_small_blind, v_big_blind, 0, 0,
    v_max_players, 0, 'waiting'
  ) RETURNING id INTO v_table_id;

  RETURN jsonb_build_object(
    'ok', true,
    'replayed', false,
    'tournament', to_jsonb(v_created),
    'table_id', v_table_id
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) TO postgres, service_role;

-- Captured full-definition MD5 3bd1e0aeed55ae8e56c9e28e8967ae2b
CREATE OR REPLACE FUNCTION public.fn_ensure_agent_row(p_club_id uuid, p_user_id uuid, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id    uuid;
  v_union uuid;
  v_min   numeric;
  v_role  text;
  v_staff boolean;
begin
  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  if v_id is not null then
    return v_id;
  end if;

  -- agents.role CHECK still admits only the three agent tiers, so a staff
  -- wallet holder is stored as 'super_agent'. The data lies about who holds the
  -- wallet; club_members.role is the truth and every rule reads it. Recorded as
  -- P3 debt for phase 7, not fixed here, because relaxing that CHECK is a table
  -- lock on agents and this migration deliberately takes none.
  v_role := case when p_role in ('super_agent', 'agent', 'sub_agent') then p_role
                 else 'super_agent' end;

  v_staff := exists (
    select 1 from club_members cm
     where cm.club_id = p_club_id and cm.user_id = p_user_id
       and cm.role in ('co_owner', 'admin'));

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c
    left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id
   limit 1;

  -- A rate nobody chose is the bug phase 0 removed from the promotion path.
  -- Staff earn nothing by law, so minting them at the union minimum invented a
  -- commission AND tripped the band on the way back down to zero.
  v_min := case when v_staff then 0
                when v_union is null then 0
                else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  -- Prepaid with no line: a wallet that appears because somebody was sent chips
  -- must not also arrive able to borrow. A credit line is granted deliberately,
  -- through the promotion screen or the agent panel, never as a side effect.
  insert into agents (user_id, club_id, role, status,
                      agent_wallet_balance, promo_wallet_balance,
                      commission_rate, player_rakeback_rate,
                      credit_limit, credit_used, is_prepaid)
  values (p_user_id, p_club_id, v_role, 'active', 0, 0, v_min, 0, 0, 0, true)
  on conflict (user_id, club_id) do nothing;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  return v_id;
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_ensure_agent_row(uuid,uuid,text) FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.fn_ensure_agent_row(uuid,uuid,text) TO postgres, service_role;

-- Captured full-definition MD5 d5ec9bc535b1a0b84140af8a48da8640
CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_tbl        record;
  v_t          record;
  v_reg        jsonb;
  v_seat_cap   integer;
  v_taken      integer;
  v_mine       integer;
  v_stack      numeric;
  v_err        text;
BEGIN
  PERFORM set_config('app.money_path', 'fn_take_seat_and_buy_in', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, tournament_id, max_players, status
    INTO v_tbl FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_game_table');
  END IF;
  IF v_tbl.status = 'closed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_closed');
  END IF;

  SELECT id, status, variant, max_players, starting_chips, name
    INTO v_t FROM public.tournaments WHERE id = v_tbl.tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  -- The chips this seat is buying. Known now, because the board decides it.
  v_stack := COALESCE(v_t.starting_chips, 0);

  v_seat_cap := COALESCE(NULLIF(v_tbl.max_players, 0), v_t.max_players, 3);

  IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > v_seat_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_seat');
  END IF;

  SELECT seat_number INTO v_mine
    FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL LIMIT 1;
  IF v_mine IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true,
      'table_id', p_table_id, 'seat_number', v_mine);
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_already_started');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_seats
     WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_t.id);

  v_reg := public.fn_register_for_tournament(v_t.id, true);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason', '') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false,
      'reason', COALESCE(v_reg->>'reason', 'buy_in_failed'));
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', chips = v_stack, table_id = p_table_id, seat_number = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  UPDATE public.table_seats
     SET user_id = v_uid, stack = v_stack, left_at = NULL, joined_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (p_table_id, v_uid, p_seat_number, v_stack);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'seat_taken' USING ERRCODE = '55000';
    END;
  END IF;

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(v_t.id), 0);
  IF v_taken = 0 THEN
    SELECT count(*) INTO v_taken FROM public.table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id,
    'seat_number', p_seat_number, 'stack', v_stack, 'seat_reserved', true,
    'seats_taken', v_taken, 'seats_needed', v_seat_cap,
    'starts_now', v_taken >= v_seat_cap,
    'cost', COALESCE((v_reg->>'cost')::numeric, 0))
    -- DIAMOND PHASE 8: a Diamond seat purchase names its asset and the
    -- wallet after the charge, as the lobby receipt does, so the client can
    -- move the balance it shows. Absent on the already_registered answer,
    -- which carries no charge.
    || CASE WHEN v_reg ? 'asset'
         THEN jsonb_build_object('asset', v_reg->'asset', 'diamonds_after', v_reg->'diamonds_after')
         ELSE '{}'::jsonb END;

EXCEPTION
  WHEN sqlstate '55000' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  WHEN sqlstate '23514' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE '%FOUR TABLE LIMIT%' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'table_limit_reached',
        'limit', 4);
    END IF;
    RAISE;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer) FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer) TO postgres;

-- Captured full-definition MD5 b22f559c1e388ed3564b8cad6fd801d6
CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in_before_terminal_seat_gate(p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(
    p_table_id, p_seat_number
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer) FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer) TO postgres;

-- Captured full-definition MD5 a965493d4837187d433b3cdd40c5da81
CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in(p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    NULL,p_table_id,auth.uid());
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_take_seat_and_buy_in_before_terminal_seat_gate(
    p_table_id,p_seat_number);
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in(uuid,integer) FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in(uuid,integer) TO postgres, authenticated, service_role;

-- Captured full-definition MD5 162eba07a4e75f16ae21e5ca809ee595
CREATE OR REPLACE FUNCTION public.fn_club_bank_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_bank_before  numeric;
  v_bank_after   numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_agent_id     uuid;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Bank');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;
  -- Dan 2026-09-02: "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A PLAYER
  -- WALLET (ADMIN'S SHOULD NOT)". A player-wallet credit to an admin lands in
  -- a balance no surface shows them, so it is refused here rather than
  -- stranded.
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select coalesce(c.chip_treasury, 0) into v_bank_before
    from clubs c where c.id = p_club_id for update;
  if v_bank_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;
  if v_bank_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Bank Balance',
      'balance', v_bank_before, 'requested', p_amount);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a club bank send is ONE journal row from
  -- the bank to the wallet that receives it. Undeclared, the two balance
  -- writes landed as `adjustment club_treasury -> settlement_suspense` plus
  -- `adjustment settlement_suspense -> agent_wallet` (or `table_stack ->
  -- player_wallet`), unkeyed and uncorrelated (3,750,000.00 on 2026-09-01
  -- 14:02:19 journaled exactly so). The clubs trigger is skipped for this
  -- write; the receiving wallet's trigger writes the row with the bank as its
  -- counterparty, keyed and correlated on the op. Never a refusal: a journal
  -- miss falls back inside the trigger, the money moves as before.
  perform public.fn_ca_declare_ledger('club_bank_send', 'club_treasury', p_club_id, null,
    'club_bank_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;

    if v_dest = 'agent_wallet' then
      update agents
         set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning agent_wallet_balance into v_to_after;
    else
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning promo_wallet_balance into v_to_after;
    end if;
  end if;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_bank_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after, now() + interval '7 days')
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'bank_before', v_bank_before,
    'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC, anon, authenticated, dashboard_user, pg_database_owner, postgres, service_role, supabase_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid) TO postgres, authenticated, service_role;

RESET ROLE;
DO $all_functions_after$
DECLARE v_expected jsonb; v_actual jsonb;
BEGIN
  FOR v_expected IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"24fc93502f66beb34c31e1a16c87a147"},{"signature":"fn_create_seat_first_game_atomic(uuid,jsonb)","owner":"postgres","proacl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"92cbf5680d78bdbaa4309412b3d19dfd"},{"signature":"fn_ensure_agent_row(uuid,uuid,text)","owner":"postgres","proacl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"3bd1e0aeed55ae8e56c9e28e8967ae2b"},{"signature":"fn_entry_purchases_frozen()","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":false,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"sql","prokind":"f","full_definition_md5":"0b05e2e7905caf71f14c8327a172cea0"},{"signature":"fn_register_for_tournament(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"0f3b104a1bf9431d70053c656fedc081"},{"signature":"fn_register_for_tournament(uuid)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"sql","prokind":"f","full_definition_md5":"52ae0199d26af5deeaa5d865ef178c39"},{"signature":"fn_sync_seat_first_player_count(uuid)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"6ca19586d771591fb674d07e4b0c323c"},{"signature":"fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, extensions"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"d5ec9bc535b1a0b84140af8a48da8640"},{"signature":"fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, extensions","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"b22f559c1e388ed3564b8cad6fd801d6"},{"signature":"fn_take_seat_and_buy_in(uuid,integer)","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"a965493d4837187d433b3cdd40c5da81"},{"signature":"fn_caller_is_engine()","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=pg_catalog, public, auth"],"prosecdef":false,"provolatile":"s","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"sql","prokind":"f","full_definition_md5":"d9a70f1d932538025e656bfe2b4d091d"},{"signature":"fn_caller_session_is_live()","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=pg_catalog, public, auth"],"prosecdef":true,"provolatile":"s","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"23ffeea99f9d9e76102ecbf6185222c0"},{"signature":"fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"2f1b8cafdab8cb2249bdcdd0d12e36c2"},{"signature":"fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"1f5b646bfa52cafa0c3a678324cf3e56"},{"signature":"fn_register_for_tournament_before_maintenance_announcement_gate(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"8f5f2fb6976198a19f0a79fbcde4559b"},{"signature":"fn_register_for_tournament_before_terminal_seat_gate(uuid,boolean)","owner":"postgres","proacl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp","statement_timeout=30s"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"e65fe889128c1ce4306b1236cb44484a"},{"signature":"fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)","owner":"postgres","proacl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosecdef":true,"provolatile":"v","proparallel":"u","proisstrict":false,"proleakproof":false,"language":"plpgsql","prokind":"f","full_definition_md5":"162eba07a4e75f16ae21e5ca809ee595"}]$expected$::jsonb) LOOP
    SELECT jsonb_build_object('signature',v_expected->>'signature',
      'owner',pg_get_userbyid(p.proowner),'proacl',p.proacl::text,
      'proconfig',to_jsonb(p.proconfig),'prosecdef',p.prosecdef,
      'provolatile',p.provolatile,'proparallel',p.proparallel,
      'proisstrict',p.proisstrict,'proleakproof',p.proleakproof,
      'prokind',p.prokind,'language',l.lanname,
      'full_definition_md5',md5(pg_get_functiondef(p.oid))) INTO v_actual
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid=to_regprocedure('public.'||(v_expected->>'signature'));
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'entry provider function authority differs: %',v_expected->>'signature';
    END IF;
  END LOOP;
END $all_functions_after$;

DO $relations_after$
DECLARE v_expected jsonb; v_actual jsonb;
BEGIN
  FOR v_expected IN SELECT value FROM jsonb_array_elements($expected$[{"ns":"auth","name":"sessions","relkind":"r","relpersistence":"p","owner":"supabase_auth_admin","relacl":"{postgres=ar*wdDxtm/supabase_auth_admin,supabase_auth_admin=arwdDxtm/supabase_auth_admin,dashboard_user=arwdDxtm/supabase_auth_admin}","relrowsecurity":true,"relforcerowsecurity":false,"columns":[{"acl":null,"name":"id","type":"uuid","attnum":1,"default":null,"notnull":true,"identity":"","generated":""},{"acl":null,"name":"user_id","type":"uuid","attnum":2,"default":null,"notnull":true,"identity":"","generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","attnum":3,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","attnum":4,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"factor_id","type":"uuid","attnum":5,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"aal","type":"auth.aal_level","attnum":6,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"not_after","type":"timestamp with time zone","attnum":7,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"refreshed_at","type":"timestamp without time zone","attnum":8,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"user_agent","type":"text","attnum":9,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"ip","type":"inet","attnum":10,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"tag","type":"text","attnum":11,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"oauth_client_id","type":"uuid","attnum":12,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"refresh_token_hmac_key","type":"text","attnum":13,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"refresh_token_counter","type":"bigint","attnum":14,"default":null,"notnull":false,"identity":"","generated":""},{"acl":null,"name":"scopes","type":"text","attnum":15,"default":null,"notnull":false,"identity":"","generated":""}],"constraints":[{"name":"sessions_oauth_client_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE"},{"name":"sessions_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"sessions_scopes_length","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((char_length(scopes) <= 4096))"},{"name":"sessions_user_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"}],"indexes":[{"name":"auth.sessions_not_after_idx","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC)"},{"name":"auth.sessions_oauth_client_id_idx","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX sessions_oauth_client_id_idx ON auth.sessions USING btree (oauth_client_id)"},{"name":"auth.sessions_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX sessions_pkey ON auth.sessions USING btree (id)"},{"name":"auth.sessions_user_id_idx","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id)"},{"name":"auth.user_id_created_at_idx","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at)"}],"triggers":null,"policies":null},{"ns":"public","name":"spin_fill_policy","relkind":"r","relpersistence":"p","owner":"postgres","relacl":"{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}","relrowsecurity":true,"relforcerowsecurity":false,"columns":[{"acl":null,"name":"id","type":"boolean","attnum":1,"default":"true","notnull":true,"identity":"","generated":""},{"acl":null,"name":"unfilled_timeout_minutes","type":"integer","attnum":2,"default":"30","notnull":true,"identity":"","generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","attnum":3,"default":"now()","notnull":true,"identity":"","generated":""}],"constraints":[{"name":"spin_fill_policy_id_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (id)"},{"name":"spin_fill_policy_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"spin_fill_policy_sane","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((unfilled_timeout_minutes >= 0) AND (unfilled_timeout_minutes <= 10080)))"}],"indexes":[{"name":"spin_fill_policy_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX spin_fill_policy_pkey ON public.spin_fill_policy USING btree (id)"}],"triggers":null,"policies":null}]$expected$::jsonb) LOOP
    SELECT to_jsonb(q)-'observed_at' INTO v_actual FROM (
      WITH wanted(ns,name) AS (VALUES (v_expected->>'ns',v_expected->>'name')) SELECT clock_timestamp() observed_at,w.ns,w.name,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) owner,c.relacl::text relacl,c.relrowsecurity,c.relforcerowsecurity,(SELECT jsonb_agg(jsonb_build_object('attnum',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,'definition',pg_get_constraintdef(k.oid)) ORDER BY k.conname)FROM pg_constraint k WHERE k.conrelid=c.oid) constraints,(SELECT jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,'primary',i.indisprimary,'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text)FROM pg_index i WHERE i.indrelid=c.oid) indexes,(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname)FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers,(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles::text,'permissive',p.polpermissive,'cmd',p.polcmd,'qual',pg_get_expr(p.polqual,p.polrelid),'with_check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)FROM pg_policy p WHERE p.polrelid=c.oid) policies FROM wanted w JOIN pg_namespace n ON n.nspname=w.ns JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=w.name ORDER BY w.ns,w.name
    ) q;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'entry provider relation authority differs: %.%',v_expected->>'ns',v_expected->>'name';
    END IF;
  END LOOP;
END $relations_after$;

DO $empty_policy$ BEGIN
  IF EXISTS (SELECT 1 FROM public.spin_fill_policy) THEN
    RAISE EXCEPTION 'entry supplement must not seed policy or business state';
  END IF;
END $empty_policy$;
COMMIT;

-- SOURCE ONLY / UNRUN. Isolated FIFO5 R2 provider index restoration.
-- Append this separate transaction after the existing entry-provider-supplement
-- COMMIT, before catalog/funding. No runner stage or production migration.
-- Retained canonical authority: spin-expiry-committed-refund.authority.json
-- SHA256 b83bf508780fab8ca029fbf36c6b637aa4637426705006cb03261c6d00899060,
-- capture fifo5-R2-current-indexes-1412.json. Fresh 65-row comparison:
-- r2-index-capture-v6.json, observed 2026-09-16 16:58:28.612698 UTC,
-- SHA256 35a46fa90b9bfba365aa96012dd83a4b7fdfcc4e502dedcba5b31a27323defea.
-- Required CI 35123728626 retained 24 exact matches and 41 absent indexes:
-- EXACT-INDEX-DIFF.json SHA256 60c8f7c456872b651f2e222c1c184e678671f651b16224286ebe5950de234ee2;
-- OBSERVED-INDEXES.json SHA256 2288a2d32b38677ced5391a0053505d21eedfdc944107583cd25c5eb861a7360.
-- Restore only those 41 literal nonunique definitions. All original definitions,
-- flags and predicates remain exact; replay, extras and wrong-kind names refuse.
-- No financial rows, counters, defaults, constraints, functions or triggers change.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '5s';

DO $r2_indexes_boundary$
DECLARE execution_uuid text := current_setting('qualification.execution_uuid');
BEGIN
  IF current_user <> 'fixture_bootstrap' OR session_user <> 'fixture_bootstrap'
     OR execution_uuid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_spin_expiry_' || replace(execution_uuid, '-', '')
     OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR inet_server_addr() IS NOT NULL
     OR current_setting('session_replication_role') <> 'origin'
     OR (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'R2 index restoration requires exact isolated bootstrap boundary';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (
    'chip_ledger',
    'club_members',
    'tournament_cancellation_receipts',
    'tournament_escrow',
    'tournament_obligations',
    'tournament_refund_authorizations',
    'tournament_refund_entitlements',
    'tournament_refund_tranches',
    'wallet_credit_idempotency',
    'wallet_transactions')
        AND c.relkind = 'r' AND c.relpersistence = 'p'
        AND pg_get_userbyid(c.relowner) = 'postgres') <> 10
  THEN
    RAISE EXCEPTION 'R2 index target tables differ from postgres-owned provider';
  END IF;
END $r2_indexes_boundary$;

-- Hold the ten selected provider tables stable through catalog comparison and DDL.
LOCK TABLE public.chip_ledger,
  public.club_members,
  public.tournament_cancellation_receipts,
  public.tournament_escrow,
  public.tournament_obligations,
  public.tournament_refund_authorizations,
  public.tournament_refund_entitlements,
  public.tournament_refund_tranches,
  public.wallet_credit_idempotency,
  public.wallet_transactions IN SHARE MODE;

DO $r2_indexes_preimage$
DECLARE differs boolean;
BEGIN
  WITH expected AS (
    SELECT value AS row FROM jsonb_array_elements($expected$[
    {"relation":"chip_ledger","index_name":"chip_ledger_chain_seq_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX chip_ledger_chain_seq_key ON public.chip_ledger USING btree (chain_seq)"},
    {"relation":"chip_ledger","index_name":"chip_ledger_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX chip_ledger_pkey ON public.chip_ledger USING btree (id)"},
    {"relation":"chip_ledger","index_name":"ux_chip_ledger_idempotency_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(idempotency_key IS NOT NULL)","definition":"CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)"},
    {"relation":"club_members","index_name":"club_members_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX club_members_pkey ON public.club_members USING btree (club_id, user_id)"},
    {"relation":"tournament_cancellation_receipts","index_name":"tournament_cancellation_receipts_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_cancellation_receipts_pkey ON public.tournament_cancellation_receipts USING btree (tournament_id)"},
    {"relation":"tournament_cancellation_receipts","index_name":"tournament_cancellation_receipts_spin_unwind_tournament_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_cancellation_receipts_spin_unwind_tournament_id_key ON public.tournament_cancellation_receipts USING btree (spin_unwind_tournament_id)"},
    {"relation":"tournament_escrow","index_name":"tournament_escrow_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_escrow_pkey ON public.tournament_escrow USING btree (tournament_id)"},
    {"relation":"tournament_obligations","index_name":"tournament_obligations_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_obligations_pkey ON public.tournament_obligations USING btree (id)"},
    {"relation":"tournament_obligations","index_name":"ux_tournament_obligations_place","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(place IS NOT NULL)","definition":"CREATE UNIQUE INDEX ux_tournament_obligations_place ON public.tournament_obligations USING btree (tournament_id, kind, place) WHERE (place IS NOT NULL)"},
    {"relation":"tournament_obligations","index_name":"ux_tournament_obligations_user","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(place IS NULL)","definition":"CREATE UNIQUE INDEX ux_tournament_obligations_user ON public.tournament_obligations USING btree (tournament_id, kind, user_id) WHERE (place IS NULL)"},
    {"relation":"tournament_refund_authorizations","index_name":"tournament_refund_authorizations_entitlement_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_authorizations_entitlement_id_key ON public.tournament_refund_authorizations USING btree (entitlement_id)"},
    {"relation":"tournament_refund_authorizations","index_name":"tournament_refund_authorizations_idempotency_key_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_authorizations_idempotency_key_key ON public.tournament_refund_authorizations USING btree (idempotency_key)"},
    {"relation":"tournament_refund_authorizations","index_name":"tournament_refund_authorizations_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_authorizations_pkey ON public.tournament_refund_authorizations USING btree (token)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlement_one_source_ticket","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(source_ticket_id IS NOT NULL)","definition":"CREATE UNIQUE INDEX tournament_refund_entitlement_one_source_ticket ON public.tournament_refund_entitlements USING btree (source_ticket_id) WHERE (source_ticket_id IS NOT NULL)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlement_tournament_id_user_id_entitle_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_entitlement_tournament_id_user_id_entitle_key ON public.tournament_refund_entitlements USING btree (tournament_id, user_id, entitlement_kind, source_ledger_id)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlements_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_entitlements_pkey ON public.tournament_refund_entitlements USING btree (id)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlements_source_ledger_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_entitlements_source_ledger_id_key ON public.tournament_refund_entitlements USING btree (source_ledger_id)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_credit_ledger_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_credit_ledger_id_key ON public.tournament_refund_tranches USING btree (credit_ledger_id)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_entitlement_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_entitlement_id_key ON public.tournament_refund_tranches USING btree (entitlement_id)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_idempotency_key_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_idempotency_key_key ON public.tournament_refund_tranches USING btree (idempotency_key)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_obligation_id_amount_paid_before_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_obligation_id_amount_paid_before_key ON public.tournament_refund_tranches USING btree (obligation_id, amount_paid_before)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_pkey ON public.tournament_refund_tranches USING btree (wallet_transaction_id)"},
    {"relation":"wallet_credit_idempotency","index_name":"wallet_credit_idempotency_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX wallet_credit_idempotency_pkey ON public.wallet_credit_idempotency USING btree (key)"},
    {"relation":"wallet_transactions","index_name":"wallet_transactions_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX wallet_transactions_pkey ON public.wallet_transactions USING btree (id)"}
  ]$expected$::jsonb)
  ), actual AS (
    SELECT to_jsonb(q) AS row FROM (
      SELECT c.relname relation,i.indexrelid::regclass::text index_name,i.indisvalid,i.indisready,i.indisunique,i.indisprimary,i.indisexclusion,pg_get_expr(i.indpred,i.indrelid) predicate,pg_get_indexdef(i.indexrelid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('tournament_cancellation_receipts','tournament_refund_tranches','tournament_obligations','wallet_credit_idempotency','tournament_refund_authorizations','wallet_transactions','club_members','chip_ledger','tournament_refund_entitlements','tournament_escrow') ORDER BY c.relname,i.indexrelid::regclass::text
    ) q
  )
  SELECT (SELECT count(*) FROM actual) <> 24
    OR EXISTS(SELECT row FROM actual EXCEPT ALL SELECT row FROM expected)
    OR EXISTS(SELECT row FROM expected EXCEPT ALL SELECT row FROM actual)
  INTO differs;
  IF differs THEN
    RAISE EXCEPTION 'R2 index preimage differs from exact 24-row catalog';
  END IF;
END $r2_indexes_preimage$;

DO $r2_indexes_missing_names$
BEGIN
  -- A table/view/sequence or other relation with a missing index name also refuses.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN (
        'idx_chip_ledger_club_created_desc',
        'idx_chip_ledger_club_from_created',
        'idx_chip_ledger_club_to_created',
        'idx_chip_ledger_created_at',
        'idx_chip_ledger_from_entity_created',
        'idx_chip_ledger_overlay_by_tournament',
        'idx_chip_ledger_performed_by',
        'idx_chip_ledger_promo_from',
        'idx_chip_ledger_promo_to',
        'idx_chip_ledger_rebuy_probe',
        'idx_chip_ledger_to_entity',
        'idx_chip_ledger_to_entity_created',
        'ix_chip_ledger_settlement',
        'club_members_cashier_tree_idx',
        'idx_club_members_active_lifecycle',
        'idx_club_members_agent_id',
        'idx_club_members_club_status',
        'idx_club_members_search_scope',
        'idx_club_members_user',
        'idx_club_members_user_active',
        'idx_cm_club_role_status',
        'ix_tournament_obligations_tournament',
        'ix_tournament_obligations_user_created',
        'idx_tournament_refund_authorizations_source_wallet_club_id_fk',
        'idx_tournament_refund_entitlements_refund_wallet_club_id_fk',
        'tournament_refund_entitlements_player',
        'idx_tournament_refund_tranches_source_wallet_club_id_fk',
        'idx_wallet_credit_idempotency_user_id',
        'idx_wallet_transactions_user',
        'idx_wallet_transactions_user_created',
        'idx_wallet_tx_club_data_cash_user_window',
        'idx_wallet_tx_club_data_player_window',
        'idx_wallet_tx_club_data_tournament_user_window',
        'idx_wallet_tx_created_at',
        'idx_wallet_tx_entity_cat_created',
        'idx_wallet_tx_prize_credits_by_entity',
        'idx_wallet_tx_table_cat',
        'idx_wallet_tx_table_created',
        'idx_wallet_tx_user_diamond',
        'idx_wallet_tx_user_diamond_spend',
        'idx_wt_bbj_promo_payout')
  ) THEN
    RAISE EXCEPTION 'R2 missing index name already occupied; replay or drift refused';
  END IF;
END $r2_indexes_missing_names$;

SET LOCAL ROLE postgres;
CREATE INDEX idx_chip_ledger_club_created_desc ON public.chip_ledger USING btree (club_id, created_at DESC);
CREATE INDEX idx_chip_ledger_club_from_created ON public.chip_ledger USING btree (club_id, from_entity_id, created_at);
CREATE INDEX idx_chip_ledger_club_to_created ON public.chip_ledger USING btree (club_id, to_entity_id, created_at);
CREATE INDEX idx_chip_ledger_created_at ON public.chip_ledger USING btree (created_at);
CREATE INDEX idx_chip_ledger_from_entity_created ON public.chip_ledger USING btree (from_entity_id, created_at DESC);
CREATE INDEX idx_chip_ledger_overlay_by_tournament ON public.chip_ledger USING btree (tournament_id) INCLUDE (amount) WHERE ((tournament_id IS NOT NULL) AND (category = 'overlay'::text) AND (to_type = 'prize_liability'::text));
CREATE INDEX idx_chip_ledger_performed_by ON public.chip_ledger USING btree (performed_by);
CREATE INDEX idx_chip_ledger_promo_from ON public.chip_ledger USING btree (from_entity_id, created_at DESC) WHERE (from_type = 'promo_wallet'::text);
CREATE INDEX idx_chip_ledger_promo_to ON public.chip_ledger USING btree (to_entity_id, created_at DESC) WHERE (to_type = 'promo_wallet'::text);
CREATE INDEX idx_chip_ledger_rebuy_probe ON public.chip_ledger USING btree (from_entity_id, tournament_id, created_at) WHERE ((category = 'rebuy'::text) AND (from_type = 'player_wallet'::text) AND (to_type = 'prize_liability'::text) AND (status = 'posted'::text));
CREATE INDEX idx_chip_ledger_to_entity ON public.chip_ledger USING btree (to_entity_id);
CREATE INDEX idx_chip_ledger_to_entity_created ON public.chip_ledger USING btree (to_entity_id, created_at DESC);
CREATE INDEX ix_chip_ledger_settlement ON public.chip_ledger USING btree (settlement_id) WHERE (settlement_id IS NOT NULL);
CREATE INDEX club_members_cashier_tree_idx ON public.club_members USING btree (club_id, agent_id, user_id) INCLUDE (role, status, chip_balance) WHERE (COALESCE(status, 'active'::text) = ANY (ARRAY['active'::text, 'approved'::text]));
CREATE INDEX idx_club_members_active_lifecycle ON public.club_members USING btree (club_id, user_id) WHERE (membership_lifecycle_status = 'active'::text);
CREATE INDEX idx_club_members_agent_id ON public.club_members USING btree (agent_id);
CREATE INDEX idx_club_members_club_status ON public.club_members USING btree (club_id, status);
CREATE INDEX idx_club_members_search_scope ON public.club_members USING btree (club_id, user_id) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text]));
CREATE INDEX idx_club_members_user ON public.club_members USING btree (user_id);
CREATE INDEX idx_club_members_user_active ON public.club_members USING btree (user_id, club_id) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text]));
CREATE INDEX idx_cm_club_role_status ON public.club_members USING btree (club_id, role, status);
CREATE INDEX ix_tournament_obligations_tournament ON public.tournament_obligations USING btree (tournament_id);
CREATE INDEX ix_tournament_obligations_user_created ON public.tournament_obligations USING btree (user_id, created_at DESC, id DESC) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_tournament_refund_authorizations_source_wallet_club_id_fk ON public.tournament_refund_authorizations USING btree (source_wallet_club_id);
CREATE INDEX idx_tournament_refund_entitlements_refund_wallet_club_id_fk ON public.tournament_refund_entitlements USING btree (refund_wallet_club_id);
CREATE INDEX tournament_refund_entitlements_player ON public.tournament_refund_entitlements USING btree (tournament_id, user_id, id);
CREATE INDEX idx_tournament_refund_tranches_source_wallet_club_id_fk ON public.tournament_refund_tranches USING btree (source_wallet_club_id);
CREATE INDEX idx_wallet_credit_idempotency_user_id ON public.wallet_credit_idempotency USING btree (user_id);
CREATE INDEX idx_wallet_transactions_user ON public.wallet_transactions USING btree (user_id);
CREATE INDEX idx_wallet_transactions_user_created ON public.wallet_transactions USING btree (user_id, created_at DESC);
CREATE INDEX idx_wallet_tx_club_data_cash_user_window ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (type, amount, table_id) WHERE ((category = ANY (ARRAY['buyin'::text, 'cashout'::text])) AND (table_id IS NOT NULL));
CREATE INDEX idx_wallet_tx_club_data_player_window ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (category, type, amount, table_id, related_entity_id) WHERE (((category = ANY (ARRAY['buyin'::text, 'cashout'::text])) AND (table_id IS NOT NULL)) OR ((category = ANY (ARRAY['tournament_buyin'::text, 'prize'::text, 'bounty'::text])) AND (related_entity_id IS NOT NULL)));
CREATE INDEX idx_wallet_tx_club_data_tournament_user_window ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (category, amount, related_entity_id) WHERE ((category = ANY (ARRAY['tournament_buyin'::text, 'prize'::text, 'bounty'::text])) AND (related_entity_id IS NOT NULL));
CREATE INDEX idx_wallet_tx_created_at ON public.wallet_transactions USING btree (created_at);
CREATE INDEX idx_wallet_tx_entity_cat_created ON public.wallet_transactions USING btree (related_entity_id, category, created_at) WHERE (related_entity_id IS NOT NULL);
CREATE INDEX idx_wallet_tx_prize_credits_by_entity ON public.wallet_transactions USING btree (related_entity_id) INCLUDE (amount) WHERE ((type = 'credit'::text) AND (category = 'prize'::text) AND (related_entity_id IS NOT NULL));
CREATE INDEX idx_wallet_tx_table_cat ON public.wallet_transactions USING btree (table_id, category) WHERE (table_id IS NOT NULL);
CREATE INDEX idx_wallet_tx_table_created ON public.wallet_transactions USING btree (table_id, created_at) WHERE (table_id IS NOT NULL);
CREATE INDEX idx_wallet_tx_user_diamond ON public.wallet_transactions USING btree (user_id) INCLUDE (amount) WHERE ((type = 'credit'::text) AND (category = ANY (ARRAY['diamond_purchase'::text, 'diamond_reward'::text, 'diamond_refund'::text])));
CREATE INDEX idx_wallet_tx_user_diamond_spend ON public.wallet_transactions USING btree (user_id) INCLUDE (amount) WHERE ((type = 'debit'::text) AND (category = ANY (ARRAY['diamond_deduction'::text, 'vip_purchase'::text, 'mint'::text])));
CREATE INDEX idx_wt_bbj_promo_payout ON public.wallet_transactions USING btree (category) INCLUDE (amount) WHERE ((category = 'promotion'::text) AND (description = 'BBJ promo pool payout'::text));
RESET ROLE;

DO $r2_indexes_postimage$
DECLARE differs boolean;
BEGIN
  WITH expected AS (
    SELECT value AS row FROM jsonb_array_elements($expected$[
    {"relation":"chip_ledger","index_name":"chip_ledger_chain_seq_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX chip_ledger_chain_seq_key ON public.chip_ledger USING btree (chain_seq)"},
    {"relation":"chip_ledger","index_name":"chip_ledger_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX chip_ledger_pkey ON public.chip_ledger USING btree (id)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_club_created_desc","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_club_created_desc ON public.chip_ledger USING btree (club_id, created_at DESC)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_club_from_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_club_from_created ON public.chip_ledger USING btree (club_id, from_entity_id, created_at)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_club_to_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_club_to_created ON public.chip_ledger USING btree (club_id, to_entity_id, created_at)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_created_at","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_created_at ON public.chip_ledger USING btree (created_at)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_from_entity_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_from_entity_created ON public.chip_ledger USING btree (from_entity_id, created_at DESC)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_overlay_by_tournament","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((tournament_id IS NOT NULL) AND (category = 'overlay'::text) AND (to_type = 'prize_liability'::text))","definition":"CREATE INDEX idx_chip_ledger_overlay_by_tournament ON public.chip_ledger USING btree (tournament_id) INCLUDE (amount) WHERE ((tournament_id IS NOT NULL) AND (category = 'overlay'::text) AND (to_type = 'prize_liability'::text))"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_performed_by","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_performed_by ON public.chip_ledger USING btree (performed_by)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_promo_from","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(from_type = 'promo_wallet'::text)","definition":"CREATE INDEX idx_chip_ledger_promo_from ON public.chip_ledger USING btree (from_entity_id, created_at DESC) WHERE (from_type = 'promo_wallet'::text)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_promo_to","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(to_type = 'promo_wallet'::text)","definition":"CREATE INDEX idx_chip_ledger_promo_to ON public.chip_ledger USING btree (to_entity_id, created_at DESC) WHERE (to_type = 'promo_wallet'::text)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_rebuy_probe","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((category = 'rebuy'::text) AND (from_type = 'player_wallet'::text) AND (to_type = 'prize_liability'::text) AND (status = 'posted'::text))","definition":"CREATE INDEX idx_chip_ledger_rebuy_probe ON public.chip_ledger USING btree (from_entity_id, tournament_id, created_at) WHERE ((category = 'rebuy'::text) AND (from_type = 'player_wallet'::text) AND (to_type = 'prize_liability'::text) AND (status = 'posted'::text))"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_to_entity","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_to_entity ON public.chip_ledger USING btree (to_entity_id)"},
    {"relation":"chip_ledger","index_name":"idx_chip_ledger_to_entity_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_chip_ledger_to_entity_created ON public.chip_ledger USING btree (to_entity_id, created_at DESC)"},
    {"relation":"chip_ledger","index_name":"ix_chip_ledger_settlement","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(settlement_id IS NOT NULL)","definition":"CREATE INDEX ix_chip_ledger_settlement ON public.chip_ledger USING btree (settlement_id) WHERE (settlement_id IS NOT NULL)"},
    {"relation":"chip_ledger","index_name":"ux_chip_ledger_idempotency_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(idempotency_key IS NOT NULL)","definition":"CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)"},
    {"relation":"club_members","index_name":"club_members_cashier_tree_idx","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(COALESCE(status, 'active'::text) = ANY (ARRAY['active'::text, 'approved'::text]))","definition":"CREATE INDEX club_members_cashier_tree_idx ON public.club_members USING btree (club_id, agent_id, user_id) INCLUDE (role, status, chip_balance) WHERE (COALESCE(status, 'active'::text) = ANY (ARRAY['active'::text, 'approved'::text]))"},
    {"relation":"club_members","index_name":"club_members_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX club_members_pkey ON public.club_members USING btree (club_id, user_id)"},
    {"relation":"club_members","index_name":"idx_club_members_active_lifecycle","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(membership_lifecycle_status = 'active'::text)","definition":"CREATE INDEX idx_club_members_active_lifecycle ON public.club_members USING btree (club_id, user_id) WHERE (membership_lifecycle_status = 'active'::text)"},
    {"relation":"club_members","index_name":"idx_club_members_agent_id","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_club_members_agent_id ON public.club_members USING btree (agent_id)"},
    {"relation":"club_members","index_name":"idx_club_members_club_status","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_club_members_club_status ON public.club_members USING btree (club_id, status)"},
    {"relation":"club_members","index_name":"idx_club_members_search_scope","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(status = ANY (ARRAY['active'::text, 'approved'::text]))","definition":"CREATE INDEX idx_club_members_search_scope ON public.club_members USING btree (club_id, user_id) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text]))"},
    {"relation":"club_members","index_name":"idx_club_members_user","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_club_members_user ON public.club_members USING btree (user_id)"},
    {"relation":"club_members","index_name":"idx_club_members_user_active","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(status = ANY (ARRAY['active'::text, 'approved'::text]))","definition":"CREATE INDEX idx_club_members_user_active ON public.club_members USING btree (user_id, club_id) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text]))"},
    {"relation":"club_members","index_name":"idx_cm_club_role_status","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_cm_club_role_status ON public.club_members USING btree (club_id, role, status)"},
    {"relation":"tournament_cancellation_receipts","index_name":"tournament_cancellation_receipts_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_cancellation_receipts_pkey ON public.tournament_cancellation_receipts USING btree (tournament_id)"},
    {"relation":"tournament_cancellation_receipts","index_name":"tournament_cancellation_receipts_spin_unwind_tournament_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_cancellation_receipts_spin_unwind_tournament_id_key ON public.tournament_cancellation_receipts USING btree (spin_unwind_tournament_id)"},
    {"relation":"tournament_escrow","index_name":"tournament_escrow_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_escrow_pkey ON public.tournament_escrow USING btree (tournament_id)"},
    {"relation":"tournament_obligations","index_name":"ix_tournament_obligations_tournament","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX ix_tournament_obligations_tournament ON public.tournament_obligations USING btree (tournament_id)"},
    {"relation":"tournament_obligations","index_name":"ix_tournament_obligations_user_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(user_id IS NOT NULL)","definition":"CREATE INDEX ix_tournament_obligations_user_created ON public.tournament_obligations USING btree (user_id, created_at DESC, id DESC) WHERE (user_id IS NOT NULL)"},
    {"relation":"tournament_obligations","index_name":"tournament_obligations_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_obligations_pkey ON public.tournament_obligations USING btree (id)"},
    {"relation":"tournament_obligations","index_name":"ux_tournament_obligations_place","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(place IS NOT NULL)","definition":"CREATE UNIQUE INDEX ux_tournament_obligations_place ON public.tournament_obligations USING btree (tournament_id, kind, place) WHERE (place IS NOT NULL)"},
    {"relation":"tournament_obligations","index_name":"ux_tournament_obligations_user","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(place IS NULL)","definition":"CREATE UNIQUE INDEX ux_tournament_obligations_user ON public.tournament_obligations USING btree (tournament_id, kind, user_id) WHERE (place IS NULL)"},
    {"relation":"tournament_refund_authorizations","index_name":"idx_tournament_refund_authorizations_source_wallet_club_id_fk","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_tournament_refund_authorizations_source_wallet_club_id_fk ON public.tournament_refund_authorizations USING btree (source_wallet_club_id)"},
    {"relation":"tournament_refund_authorizations","index_name":"tournament_refund_authorizations_entitlement_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_authorizations_entitlement_id_key ON public.tournament_refund_authorizations USING btree (entitlement_id)"},
    {"relation":"tournament_refund_authorizations","index_name":"tournament_refund_authorizations_idempotency_key_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_authorizations_idempotency_key_key ON public.tournament_refund_authorizations USING btree (idempotency_key)"},
    {"relation":"tournament_refund_authorizations","index_name":"tournament_refund_authorizations_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_authorizations_pkey ON public.tournament_refund_authorizations USING btree (token)"},
    {"relation":"tournament_refund_entitlements","index_name":"idx_tournament_refund_entitlements_refund_wallet_club_id_fk","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_tournament_refund_entitlements_refund_wallet_club_id_fk ON public.tournament_refund_entitlements USING btree (refund_wallet_club_id)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlement_one_source_ticket","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":"(source_ticket_id IS NOT NULL)","definition":"CREATE UNIQUE INDEX tournament_refund_entitlement_one_source_ticket ON public.tournament_refund_entitlements USING btree (source_ticket_id) WHERE (source_ticket_id IS NOT NULL)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlement_tournament_id_user_id_entitle_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_entitlement_tournament_id_user_id_entitle_key ON public.tournament_refund_entitlements USING btree (tournament_id, user_id, entitlement_kind, source_ledger_id)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlements_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_entitlements_pkey ON public.tournament_refund_entitlements USING btree (id)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlements_player","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX tournament_refund_entitlements_player ON public.tournament_refund_entitlements USING btree (tournament_id, user_id, id)"},
    {"relation":"tournament_refund_entitlements","index_name":"tournament_refund_entitlements_source_ledger_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_entitlements_source_ledger_id_key ON public.tournament_refund_entitlements USING btree (source_ledger_id)"},
    {"relation":"tournament_refund_tranches","index_name":"idx_tournament_refund_tranches_source_wallet_club_id_fk","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_tournament_refund_tranches_source_wallet_club_id_fk ON public.tournament_refund_tranches USING btree (source_wallet_club_id)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_credit_ledger_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_credit_ledger_id_key ON public.tournament_refund_tranches USING btree (credit_ledger_id)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_entitlement_id_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_entitlement_id_key ON public.tournament_refund_tranches USING btree (entitlement_id)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_idempotency_key_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_idempotency_key_key ON public.tournament_refund_tranches USING btree (idempotency_key)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_obligation_id_amount_paid_before_key","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_obligation_id_amount_paid_before_key ON public.tournament_refund_tranches USING btree (obligation_id, amount_paid_before)"},
    {"relation":"tournament_refund_tranches","index_name":"tournament_refund_tranches_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX tournament_refund_tranches_pkey ON public.tournament_refund_tranches USING btree (wallet_transaction_id)"},
    {"relation":"wallet_credit_idempotency","index_name":"idx_wallet_credit_idempotency_user_id","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_wallet_credit_idempotency_user_id ON public.wallet_credit_idempotency USING btree (user_id)"},
    {"relation":"wallet_credit_idempotency","index_name":"wallet_credit_idempotency_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX wallet_credit_idempotency_pkey ON public.wallet_credit_idempotency USING btree (key)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_transactions_user","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_wallet_transactions_user ON public.wallet_transactions USING btree (user_id)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_transactions_user_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_wallet_transactions_user_created ON public.wallet_transactions USING btree (user_id, created_at DESC)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_club_data_cash_user_window","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((category = ANY (ARRAY['buyin'::text, 'cashout'::text])) AND (table_id IS NOT NULL))","definition":"CREATE INDEX idx_wallet_tx_club_data_cash_user_window ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (type, amount, table_id) WHERE ((category = ANY (ARRAY['buyin'::text, 'cashout'::text])) AND (table_id IS NOT NULL))"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_club_data_player_window","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(((category = ANY (ARRAY['buyin'::text, 'cashout'::text])) AND (table_id IS NOT NULL)) OR ((category = ANY (ARRAY['tournament_buyin'::text, 'prize'::text, 'bounty'::text])) AND (related_entity_id IS NOT NULL)))","definition":"CREATE INDEX idx_wallet_tx_club_data_player_window ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (category, type, amount, table_id, related_entity_id) WHERE (((category = ANY (ARRAY['buyin'::text, 'cashout'::text])) AND (table_id IS NOT NULL)) OR ((category = ANY (ARRAY['tournament_buyin'::text, 'prize'::text, 'bounty'::text])) AND (related_entity_id IS NOT NULL)))"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_club_data_tournament_user_window","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((category = ANY (ARRAY['tournament_buyin'::text, 'prize'::text, 'bounty'::text])) AND (related_entity_id IS NOT NULL))","definition":"CREATE INDEX idx_wallet_tx_club_data_tournament_user_window ON public.wallet_transactions USING btree (user_id, created_at) INCLUDE (category, amount, related_entity_id) WHERE ((category = ANY (ARRAY['tournament_buyin'::text, 'prize'::text, 'bounty'::text])) AND (related_entity_id IS NOT NULL))"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_created_at","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":null,"definition":"CREATE INDEX idx_wallet_tx_created_at ON public.wallet_transactions USING btree (created_at)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_entity_cat_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(related_entity_id IS NOT NULL)","definition":"CREATE INDEX idx_wallet_tx_entity_cat_created ON public.wallet_transactions USING btree (related_entity_id, category, created_at) WHERE (related_entity_id IS NOT NULL)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_prize_credits_by_entity","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((type = 'credit'::text) AND (category = 'prize'::text) AND (related_entity_id IS NOT NULL))","definition":"CREATE INDEX idx_wallet_tx_prize_credits_by_entity ON public.wallet_transactions USING btree (related_entity_id) INCLUDE (amount) WHERE ((type = 'credit'::text) AND (category = 'prize'::text) AND (related_entity_id IS NOT NULL))"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_table_cat","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(table_id IS NOT NULL)","definition":"CREATE INDEX idx_wallet_tx_table_cat ON public.wallet_transactions USING btree (table_id, category) WHERE (table_id IS NOT NULL)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_table_created","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"(table_id IS NOT NULL)","definition":"CREATE INDEX idx_wallet_tx_table_created ON public.wallet_transactions USING btree (table_id, created_at) WHERE (table_id IS NOT NULL)"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_user_diamond","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((type = 'credit'::text) AND (category = ANY (ARRAY['diamond_purchase'::text, 'diamond_reward'::text, 'diamond_refund'::text])))","definition":"CREATE INDEX idx_wallet_tx_user_diamond ON public.wallet_transactions USING btree (user_id) INCLUDE (amount) WHERE ((type = 'credit'::text) AND (category = ANY (ARRAY['diamond_purchase'::text, 'diamond_reward'::text, 'diamond_refund'::text])))"},
    {"relation":"wallet_transactions","index_name":"idx_wallet_tx_user_diamond_spend","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((type = 'debit'::text) AND (category = ANY (ARRAY['diamond_deduction'::text, 'vip_purchase'::text, 'mint'::text])))","definition":"CREATE INDEX idx_wallet_tx_user_diamond_spend ON public.wallet_transactions USING btree (user_id) INCLUDE (amount) WHERE ((type = 'debit'::text) AND (category = ANY (ARRAY['diamond_deduction'::text, 'vip_purchase'::text, 'mint'::text])))"},
    {"relation":"wallet_transactions","index_name":"idx_wt_bbj_promo_payout","indisvalid":true,"indisready":true,"indisunique":false,"indisprimary":false,"indisexclusion":false,"predicate":"((category = 'promotion'::text) AND (description = 'BBJ promo pool payout'::text))","definition":"CREATE INDEX idx_wt_bbj_promo_payout ON public.wallet_transactions USING btree (category) INCLUDE (amount) WHERE ((category = 'promotion'::text) AND (description = 'BBJ promo pool payout'::text))"},
    {"relation":"wallet_transactions","index_name":"wallet_transactions_pkey","indisvalid":true,"indisready":true,"indisunique":true,"indisprimary":true,"indisexclusion":false,"predicate":null,"definition":"CREATE UNIQUE INDEX wallet_transactions_pkey ON public.wallet_transactions USING btree (id)"}
  ]$expected$::jsonb)
  ), actual AS (
    SELECT to_jsonb(q) AS row FROM (
      SELECT c.relname relation,i.indexrelid::regclass::text index_name,i.indisvalid,i.indisready,i.indisunique,i.indisprimary,i.indisexclusion,pg_get_expr(i.indpred,i.indrelid) predicate,pg_get_indexdef(i.indexrelid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('tournament_cancellation_receipts','tournament_refund_tranches','tournament_obligations','wallet_credit_idempotency','tournament_refund_authorizations','wallet_transactions','club_members','chip_ledger','tournament_refund_entitlements','tournament_escrow') ORDER BY c.relname,i.indexrelid::regclass::text
    ) q
  )
  SELECT (SELECT count(*) FROM actual) <> 65
    OR EXISTS(SELECT row FROM actual EXCEPT ALL SELECT row FROM expected)
    OR EXISTS(SELECT row FROM expected EXCEPT ALL SELECT row FROM actual)
  INTO differs;
  IF differs THEN
    RAISE EXCEPTION 'R2 index postimage differs from exact 65-row catalog';
  END IF;
END $r2_indexes_postimage$;

DO $r2_indexes_owner$
BEGIN
  IF (SELECT count(*) FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class x ON x.oid = i.indexrelid
      WHERE n.nspname = 'public' AND t.relname IN (
    'chip_ledger',
    'club_members',
    'tournament_cancellation_receipts',
    'tournament_escrow',
    'tournament_obligations',
    'tournament_refund_authorizations',
    'tournament_refund_entitlements',
    'tournament_refund_tranches',
    'wallet_credit_idempotency',
    'wallet_transactions')
        AND x.relnamespace = t.relnamespace AND x.relkind = 'i'
        AND pg_get_userbyid(x.relowner) = 'postgres') <> 65
  THEN
    RAISE EXCEPTION 'R2 index ownership postimage differs';
  END IF;
END $r2_indexes_owner$;
COMMIT;
