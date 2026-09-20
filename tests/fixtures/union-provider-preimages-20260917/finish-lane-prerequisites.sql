-- FIXTURE ONLY. Restore two exact captured catalog omissions before the unchanged
-- maintained PR4761 migration. No business row or existing function is changed.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $isolated$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('session_replication_role')<>'origin'
  OR to_regclass('public.tables') IS NULL
  OR md5((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_lock_settlement_lane_global()')))
    IS DISTINCT FROM '343015440ea5c84ee4ca7ae583c73d30'
  OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
   AND proname IN ('fn_ca_share_settlement_lane_for_table','fn_resolve_committed_tournament_seat_move',
    'fn_ca_lock_settlement_lane_for_finish'))
 THEN RAISE EXCEPTION 'finish_lane_fixture_requires_original_isolated_pg17_predecessor'; END IF;
END $isolated$;

CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  -- Acquire G before B and T; source custody guards also need G.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  -- B shared: yields to terminal authorities, concurrent with every other
  -- hand and with rolling authorities of OTHER tournaments.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));

  IF p_table_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
  FROM public.tables tb
  WHERE tb.id = p_table_id;

  IF v_tournament_id IS NOT NULL THEN
    -- T(id) shared: yields to this tournament's own rolling authorities.
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_resolve_committed_tournament_seat_move(p_request_id uuid, p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_destination_table_id uuid, p_destination_seat_number integer, p_source_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_actor text:=NULLIF(current_setting('app.smarter_data_actor',true),'');
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'committed tournament move receipt requires ordinary service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL OR p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_source_table_id=p_destination_table_id
     OR p_destination_seat_number NOT BETWEEN 1 AND 10
     OR p_source_mode NOT IN ('live_source','closed_orphan') THEN
    RAISE EXCEPTION 'invalid committed tournament move receipt identity'
      USING ERRCODE='22023';
  END IF;

  -- The writer (fn_move_tournament_player) holds this tournament's lane -
  -- G shared, T(id) exclusive - from before its first receipt read through
  -- commit. G shared then T(id) SHARED waits for exactly that writer and for
  -- terminal authorities (2026-09-10; this was G exclusive, which made every
  -- authority and hand on the platform queue behind a read-only lookup).
  -- An absent receipt is deliberately not converted into proof that no write
  -- can still begin later.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1:'||p_tournament_id::text,0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;
  IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
     OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
     OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
     OR (v_result->>'destination_table_id')::uuid
          IS DISTINCT FROM p_destination_table_id
     OR (v_result->>'destination_seat_number')::integer
          IS DISTINCT FROM p_destination_seat_number
     OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode THEN
    RAISE EXCEPTION 'tournament move request id belongs to another operation'
      USING ERRCODE='23505';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',true);
END;
$function$;
ALTER FUNCTION public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text) TO service_role;

DO $dependency_readback$
DECLARE expected record; actual record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_ca_share_settlement_lane_for_table(uuid)','409b14ee72ce888d3b26524c52d49a68','7a4d464261d6cc5cb185ad6c8b846440',false,'["search_path=public, pg_temp"]'::jsonb),
  ('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)','43c53a2b376cb28161584db487bfd17c','f00ad0e9a08496d96f6375cbf6f30678',true,'["search_path=public, pg_temp","statement_timeout=30s"]'::jsonb)
 ) v(signature,definition_md5,body_md5,security_definer,config) LOOP
  SELECT p.*,md5(pg_get_functiondef(p.oid)) AS definition_md5,
   ARRAY(SELECT a::text FROM unnest(p.proacl) a ORDER BY a::text COLLATE "C") AS grants
   INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
  IF NOT FOUND THEN RAISE EXCEPTION 'finish lane fixture function missing: %',expected.signature; END IF;
  IF actual.definition_md5 IS DISTINCT FROM expected.definition_md5
   OR md5(actual.prosrc) IS DISTINCT FROM expected.body_md5
   OR actual.proowner IS DISTINCT FROM 'postgres'::regrole
   OR actual.prosecdef IS DISTINCT FROM expected.security_definer
   OR to_jsonb(actual.proconfig) IS DISTINCT FROM expected.config
   OR actual.grants IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
   OR has_function_privilege('anon',actual.oid,'EXECUTE')
   OR has_function_privilege('authenticated',actual.oid,'EXECUTE')
   OR NOT has_function_privilege('service_role',actual.oid,'EXECUTE')
  THEN RAISE EXCEPTION 'finish lane fixture function authority differs: %',expected.signature; END IF;
 END LOOP;
END;
$dependency_readback$;
COMMIT;
