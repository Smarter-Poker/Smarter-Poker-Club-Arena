-- 20261006040022_club_reports_return_exact_scope_receipts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Six club-facing reads could return a successful empty payload without any
-- durable proof of which club or requested window produced it. Rows can be
-- checked after they arrive, but an empty array cannot prove scope. Preserve
-- the installed JSON accounting/query implementations as owner-only cores and
-- put versioned, request-bound envelopes on their existing public RPC names.
-- Bomb Pot already has a table-returning public contract, so add a separately
-- named v2 JSON RPC instead of breaking old clients during the rollout. The
-- cores retain their volatility, security-definer owner, search path and
-- implementation; client roles cannot call them around the receipt guard.
--
-- @live-proof: (SELECT bool_and(pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.proconfig::text = '{search_path=public}' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND p.prosrc LIKE '%contract_version%') FROM pg_proc p WHERE p.oid = ANY(ARRAY['public.ca_club_insurance_report(uuid,integer)'::regprocedure,'public.fn_club_bomb_pot_report_v2(uuid,integer)'::regprocedure,'public.ca_club_financials(uuid,date,date)'::regprocedure,'public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)'::regprocedure,'public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure,'public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure]))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $club_report_receipt_preimage$
DECLARE
  v_insurance regprocedure := 'public.ca_club_insurance_report(uuid,integer)'::regprocedure;
  v_bombs regprocedure := 'public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure;
  v_financials regprocedure := 'public.ca_club_financials(uuid,date,date)'::regprocedure;
  v_ledger regprocedure := 'public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)'::regprocedure;
  v_game_page regprocedure := 'public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure;
  v_player_page regprocedure := 'public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure;
  v_body text;
BEGIN
  IF to_regprocedure('public.ca_club_insurance_report_core_20261006(uuid,integer)') IS NOT NULL
     OR to_regprocedure('public.fn_club_bomb_pot_report_v2(uuid,integer)') IS NOT NULL
     OR to_regprocedure('public.ca_club_financials_core_20261006(uuid,date,date)') IS NOT NULL
     OR to_regprocedure('public.ca_club_chip_ledger_core_20261006(uuid,integer,timestamptz,boolean)') IS NOT NULL
     OR to_regprocedure('public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)') IS NOT NULL
     OR to_regprocedure('public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'CLUB_REPORT_RECEIPT_CORE_NAME_COLLISION';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_insurance
       AND md5(p.prosrc) = '8626295fcf40cfe73be63edf4702d568'
       AND md5(pg_get_functiondef(p.oid)) = '9bb9cbf8dbfaa17167690aa191a1f4bc'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_INSURANCE_REPORT_PREIMAGE_DRIFT';
  END IF;
  SELECT p.prosrc INTO STRICT v_body FROM pg_proc p WHERE p.oid = v_insurance;
  IF position('ca_can_view_club_finances(p_club_id)' in v_body) = 0
     OR position('v_from := v_today - (v_days - 1)' in v_body) = 0
     OR position('''window_start'', v_from' in v_body) = 0
     OR position('''days'', coalesce' in v_body) = 0 THEN
    RAISE EXCEPTION 'CLUB_INSURANCE_REPORT_BODY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_bombs
       AND md5(p.prosrc) = '635cce48ca50b92c3ef235be220d7dc8'
       AND md5(pg_get_functiondef(p.oid)) = 'a37016388c8957533a8a7f1e0b610065'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 'v'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND pg_get_function_result(p.oid) LIKE 'TABLE(table_id uuid,%'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_BOMB_POT_REPORT_PREIMAGE_DRIFT';
  END IF;
  SELECT p.prosrc INTO STRICT v_body FROM pg_proc p WHERE p.oid = v_bombs;
  IF position('fn_ca_bomb_pot_catchup(p_club_id, v_days)' in v_body) = 0
     OR position('ca_club_bomb_pot_daily d' in v_body) = 0
     OR position('MIN(h.created_at)::date INTO v_oldest' in v_body) = 0 THEN
    RAISE EXCEPTION 'CLUB_BOMB_POT_REPORT_BODY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_financials
       AND md5(p.prosrc) = '6a5399bf03d567b34d6382b25a9ca6db'
       AND md5(pg_get_functiondef(p.oid)) = 'ac1e093ddb297eb63ee8905d6c48229e'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_FINANCIALS_PREIMAGE_DRIFT';
  END IF;
  SELECT p.prosrc INTO STRICT v_body FROM pg_proc p WHERE p.oid = v_financials;
  IF position('ca_can_view_club_finances(p_club_id)' in v_body) = 0
     OR position('''range'', jsonb_build_object' in v_body) = 0
     OR position('''totals''' in v_body) = 0
     OR position('''daily''' in v_body) = 0 THEN
    RAISE EXCEPTION 'CLUB_FINANCIALS_BODY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_ledger
       AND md5(p.prosrc) = '53554b8d9922c63d160aa6cd68b0bbd6'
       AND md5(pg_get_functiondef(p.oid)) = '2da327b47573b7313a9362b81c78b873'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_CHIP_LEDGER_PREIMAGE_DRIFT';
  END IF;
  SELECT p.prosrc INTO STRICT v_body FROM pg_proc p WHERE p.oid = v_ledger;
  IF position('ca_can_view_club_finances(p_club_id)' in v_body) = 0
     OR position('WHERE l.club_id = p_club_id' in v_body) = 0
     OR position('''rows''' in v_body) = 0
     OR position('''hand_rows_included''' in v_body) = 0 THEN
    RAISE EXCEPTION 'CLUB_CHIP_LEDGER_BODY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_game_page
       AND md5(p.prosrc) = '1bb73735870ec3e4e26509f2dade4a8d'
       AND md5(pg_get_functiondef(p.oid)) = '005fcf77ba241a357921edc029fdfc3c'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_GAME_PAGE_PREIMAGE_DRIFT';
  END IF;
  SELECT p.prosrc INTO STRICT v_body FROM pg_proc p WHERE p.oid = v_game_page;
  IF position('ca_can_view_club_finances(p_club_id)' in v_body) = 0
     OR position('EXECUTE $query$' in v_body) = 0
     OR position('ROW(s.sort_value,s.sort_time,s.kind,s.id)' in v_body) = 0
     OR position('''filtered_count''' in v_body) = 0 THEN
    RAISE EXCEPTION 'CLUB_GAME_PAGE_BODY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_player_page
       AND md5(p.prosrc) = '3a7ec883a7ca32920d345e4d7eea044a'
       AND md5(pg_get_functiondef(p.oid)) = '171060d16ed798d1a185080d1a9334cd'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_PLAYER_PAGE_PREIMAGE_DRIFT';
  END IF;
  SELECT p.prosrc INTO STRICT v_body FROM pg_proc p WHERE p.oid = v_player_page;
  IF position('ca_can_view_club_finances(p_club_id)' in v_body) = 0
     OR position('hand_clubs AS MATERIALIZED' in v_body) = 0
     OR position('JOIN hand_clubs hc ON hc.club_id=s.club_id' in v_body) = 0
     OR position('ROW(s.sort_value,s.user_id::text)' in v_body) = 0 THEN
    RAISE EXCEPTION 'CLUB_PLAYER_PAGE_BODY_DRIFT';
  END IF;
END
$club_report_receipt_preimage$;

ALTER FUNCTION public.ca_club_insurance_report(uuid,integer)
  RENAME TO ca_club_insurance_report_core_20261006;
ALTER FUNCTION public.ca_club_financials(uuid,date,date)
  RENAME TO ca_club_financials_core_20261006;
ALTER FUNCTION public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)
  RENAME TO ca_club_chip_ledger_core_20261006;
ALTER FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)
  RENAME TO ca_club_game_page_core_20261006;
ALTER FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)
  RENAME TO ca_club_player_page_core_20261006;

REVOKE ALL ON FUNCTION public.ca_club_insurance_report_core_20261006(uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_financials_core_20261006(uuid,date,date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_chip_ledger_core_20261006(uuid,integer,timestamptz,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.ca_club_insurance_report(
  p_club_id uuid,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.ca_club_insurance_report_core_20261006(p_club_id, p_days);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'club insurance report core returned a malformed payload';
  END IF;
  RETURN v_payload || jsonb_build_object(
    'contract', 'ca_club_insurance_report.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_days', p_days
  );
END;
$function$;

CREATE FUNCTION public.fn_club_bomb_pot_report_v2(
  p_club_id uuid,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_window_start date := (now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365)))::date;
  v_window_end date := (now() AT TIME ZONE 'UTC')::date;
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.hands DESC), '[]'::jsonb)
    INTO v_rows
    FROM public.fn_club_bomb_pot_report(p_club_id, p_days) r;
  RETURN jsonb_build_object(
    'contract', 'fn_club_bomb_pot_report.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_days', p_days,
    'window_days', v_days,
    'window_start', v_window_start,
    'window_end', v_window_end,
    'rows', v_rows,
    'generated_at', now()
  );
END;
$function$;

CREATE FUNCTION public.ca_club_financials(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.ca_club_financials_core_20261006(p_club_id, p_start, p_end);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'club financials core returned a malformed payload';
  END IF;
  RETURN v_payload || jsonb_build_object(
    'contract', 'ca_club_financials.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_start', p_start,
    'requested_end', p_end
  );
END;
$function$;

CREATE FUNCTION public.ca_club_chip_ledger(
  p_club_id uuid,
  p_limit integer DEFAULT 25,
  p_before timestamptz DEFAULT NULL::timestamptz,
  p_include_hand_rows boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.ca_club_chip_ledger_core_20261006(
    p_club_id,
    p_limit,
    p_before,
    p_include_hand_rows
  );
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'club chip ledger core returned a malformed payload';
  END IF;
  RETURN v_payload || jsonb_build_object(
    'contract', 'ca_club_chip_ledger.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_limit', p_limit,
    'requested_before', p_before,
    'requested_include_hand_rows', p_include_hand_rows
  );
END;
$function$;

CREATE FUNCTION public.ca_club_game_page(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text,
  p_sort text DEFAULT 'recent'::text,
  p_cursor jsonb DEFAULT NULL::jsonb,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.ca_club_game_page_core_20261006(
    p_club_id,
    p_start,
    p_end,
    p_game,
    p_stakes,
    p_search,
    p_sort,
    p_cursor,
    p_limit
  );
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'club game page core returned a malformed payload';
  END IF;
  RETURN v_payload || jsonb_build_object(
    'contract', 'ca_club_game_page.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_start', p_start,
    'requested_end', p_end,
    'requested_game', p_game,
    'requested_stakes', p_stakes,
    'requested_search', p_search,
    'requested_sort', p_sort,
    'requested_cursor', p_cursor,
    'requested_limit', p_limit
  );
END;
$function$;

CREATE FUNCTION public.ca_club_player_page(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_sort text DEFAULT 'winners'::text,
  p_search text DEFAULT NULL::text,
  p_cursor jsonb DEFAULT NULL::jsonb,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.ca_club_player_page_core_20261006(
    p_club_id,
    p_start,
    p_end,
    p_sort,
    p_search,
    p_cursor,
    p_limit
  );
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'club player page core returned a malformed payload';
  END IF;
  RETURN v_payload || jsonb_build_object(
    'contract', 'ca_club_player_page.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_start', p_start,
    'requested_end', p_end,
    'requested_sort', p_sort,
    'requested_search', p_search,
    'requested_cursor', p_cursor,
    'requested_limit', p_limit
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_insurance_report(uuid,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_insurance_report(uuid,integer)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_financials(uuid,date,date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_financials(uuid,date,date)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_club_insurance_report(uuid,integer) IS
  'Club insurance report v2. Returns an exact contract, club and requested-day receipt even when no day rows exist.';
COMMENT ON FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) IS
  'Club bomb-pot report v2. Returns an exact contract, club and requested UTC window receipt around bounded table rows, including an empty row set.';
COMMENT ON FUNCTION public.ca_club_financials(uuid,date,date) IS
  'Club financials v2. Returns an exact contract and club receipt around the authoritative ledger report.';
COMMENT ON FUNCTION public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean) IS
  'Club chip-ledger v2. Returns an exact contract, club and page request receipt around immutable movements, including an empty row set.';
COMMENT ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer) IS
  'Club game page v2. Returns an exact contract, club, range, filter, search, sort, cursor and limit receipt around each page.';
COMMENT ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer) IS
  'Club player page v2. Returns an exact contract, club, range, search, sort, cursor and limit receipt around each page.';

DO $club_report_receipt_postimage$
DECLARE
  v_signature regprocedure;
  v_body text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.ca_club_insurance_report(uuid,integer)'::regprocedure,
    'public.fn_club_bomb_pot_report_v2(uuid,integer)'::regprocedure,
    'public.ca_club_financials(uuid,date,date)'::regprocedure,
    'public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)'::regprocedure,
    'public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure,
    'public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure
  ] LOOP
    SELECT p.prosrc
      INTO STRICT v_body
      FROM pg_proc p
     WHERE p.oid = v_signature
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE');
    IF position('''contract_version'', 2' in v_body) = 0
       OR position('''club_id'', p_club_id' in v_body) = 0 THEN
      RAISE EXCEPTION 'CLUB_REPORT_RECEIPT_POSTIMAGE_DRIFT: %', v_signature;
    END IF;
  END LOOP;

  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'public.fn_club_bomb_pot_report_v2(uuid,integer)'::regprocedure) <> 'v'
     OR (SELECT bool_or(p.provolatile <> 's') FROM pg_proc p WHERE p.oid = ANY(ARRAY[
       'public.ca_club_insurance_report(uuid,integer)'::regprocedure,
       'public.ca_club_financials(uuid,date,date)'::regprocedure,
       'public.ca_club_chip_ledger(uuid,integer,timestamptz,boolean)'::regprocedure,
       'public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure,
       'public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure
     ])) THEN
    RAISE EXCEPTION 'CLUB_REPORT_RECEIPT_VOLATILITY_DRIFT';
  END IF;

  -- The additive v2 endpoint is intentionally deployable before the client.
  -- Prove the legacy table-returning contract remains callable by old clients.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = 'public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 'v'
       AND p.proparallel = 'u'
       AND p.proconfig::text = '{search_path=public}'
       AND pg_get_function_result(p.oid) LIKE 'TABLE(table_id uuid,%'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'CLUB_BOMB_POT_REPORT_LEGACY_CONTRACT_DRIFT';
  END IF;

  IF has_function_privilege('authenticated', 'public.ca_club_insurance_report_core_20261006(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ca_club_insurance_report_core_20261006(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ca_club_financials_core_20261006(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ca_club_financials_core_20261006(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ca_club_chip_ledger_core_20261006(uuid,integer,timestamptz,boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ca_club_chip_ledger_core_20261006(uuid,integer,timestamptz,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CLUB_REPORT_RECEIPT_CORE_BYPASS';
  END IF;
END
$club_report_receipt_postimage$;

COMMIT;
