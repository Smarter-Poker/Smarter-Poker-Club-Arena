-- Ordinary eliminations acquire their canonical lane before row locks.
-- Installed ordinary RPC locks tournaments/player/candidate rows before its
-- F06 trigger tries G shared/T exclusive. A concurrent accepted hand holding
-- T shared therefore causes 40001 instead of letting the valid claim finish.
-- Add only the existing canonical prefix, after unchanged argument validation.
-- All accepted-hand, candidate, rebuy, seat-generation, prize, duplicate and
-- custody predicates remain byte-identical. No player, seat or money write.
-- Database source change uses the existing engine RPC; no restart dependency.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its exact enabled definition is asserted and preserved.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its exact enabled definition is asserted and preserved.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $elimination_lane$
DECLARE original text; candidate text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_try_lane(uuid)') AND md5(pg_get_functiondef(p.oid))='78a3a191b9991b0a3a343db39de335aa' AND md5(p.prosrc)='e2926a0246837b974c7237872ec42aa5') THEN RAISE EXCEPTION 'ELIMINATION_LANE_SOURCE_DRIFT: %','smarter_private.f06_try_lane(uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.f06_try_lane(uuid)'::regprocedure AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb AND p.prosecdef=false AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_AUTHORITY_DRIFT: %','smarter_private.f06_try_lane(uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)') AND md5(pg_get_functiondef(p.oid))='2c34f4cb405753e1180aa59bfb8b1f35' AND md5(p.prosrc)='59028dfca77ee07b3b014679e3d351f3') THEN RAISE EXCEPTION 'ELIMINATION_LANE_SOURCE_DRIFT: %','public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb AND p.prosecdef=true AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_AUTHORITY_DRIFT: %','public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='9877846ffabee004690e6b24a3ddcee2' AND md5(p.prosrc)='3acb4c1d763181905cf5b64287f8f28f') THEN RAISE EXCEPTION 'ELIMINATION_LANE_SOURCE_DRIFT: %','public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb AND p.prosecdef=false AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_AUTHORITY_DRIFT: %','public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)') AND md5(pg_get_functiondef(p.oid))='5086f465475086bb869b31ed78ea96f2' AND md5(p.prosrc)='a4d2d589200bc41bab9a015ea0e7bdfb') THEN RAISE EXCEPTION 'ELIMINATION_LANE_SOURCE_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb AND p.prosecdef=true AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_AUTHORITY_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_source_guard()') AND md5(pg_get_functiondef(p.oid))='17bf5b2ba1901ba4a3f55f7ff3426f6c' AND md5(p.prosrc)='be484837a5103b3c0ac78a1d6d5d0bf2') THEN RAISE EXCEPTION 'ELIMINATION_LANE_SOURCE_DRIFT: %','smarter_private.f06_source_guard()'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.f06_source_guard()'::regprocedure AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb AND p.prosecdef=true AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_AUTHORITY_DRIFT: %','smarter_private.f06_source_guard()'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='a00_f06_source_seat' AND tgenabled='O' AND NOT tgisinternal AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN RAISE EXCEPTION 'ELIMINATION_LANE_TRIGGER_DRIFT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass AND tgname='a00_f06_source_roster' AND tgenabled='O' AND NOT tgisinternal AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN RAISE EXCEPTION 'ELIMINATION_LANE_TRIGGER_DRIFT'; END IF;
  SELECT pg_get_functiondef('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure) INTO original;
  IF (length(original)-length(replace(original,'  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;','')))/length('  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;')<>1 THEN RAISE EXCEPTION 'ELIMINATION_LANE_SEAM_DRIFT'; END IF;
  candidate:=replace(original,$row_lock$  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;$row_lock$,$canonical_lane$  -- Acquire G shared then T exclusive before any tournament/player row lock.
  -- The unchanged F06 trigger only tries this lane once rows are locked.
  -- A concurrent accepted hand owns T shared; waiting here lets that hand
  -- finish without a row-lock inversion or a failed elimination retry.
  IF p_tournament_id IS NOT NULL THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;$canonical_lane$);
  IF md5(candidate)<>'a5585b9d7fb061f12c29f1262a5a1b6c' OR replace(candidate,$lane_prefix$  -- Acquire G shared then T exclusive before any tournament/player row lock.
  -- The unchanged F06 trigger only tries this lane once rows are locked.
  -- A concurrent accepted hand owns T shared; waiting here lets that hand
  -- finish without a row-lock inversion or a failed elimination retry.
  IF p_tournament_id IS NOT NULL THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  END IF;

$lane_prefix$,'')<>original THEN RAISE EXCEPTION 'ELIMINATION_LANE_BODY_DRIFT'; END IF;
  EXECUTE candidate;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.f06_try_lane(uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='78a3a191b9991b0a3a343db39de335aa' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb AND p.prosecdef=false AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_POSTIMAGE_DRIFT: %','smarter_private.f06_try_lane(uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure AND md5(pg_get_functiondef(p.oid))='a5585b9d7fb061f12c29f1262a5a1b6c' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb AND p.prosecdef=true AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_POSTIMAGE_DRIFT: %','public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='9877846ffabee004690e6b24a3ddcee2' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb AND p.prosecdef=false AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_POSTIMAGE_DRIFT: %','public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure AND md5(pg_get_functiondef(p.oid))='5086f465475086bb869b31ed78ea96f2' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb AND p.prosecdef=true AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_POSTIMAGE_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.f06_source_guard()'::regprocedure AND md5(pg_get_functiondef(p.oid))='17bf5b2ba1901ba4a3f55f7ff3426f6c' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb AND p.prosecdef=true AND p.provolatile='v') THEN RAISE EXCEPTION 'ELIMINATION_LANE_POSTIMAGE_DRIFT: %','smarter_private.f06_source_guard()'; END IF;
END $elimination_lane$;
COMMIT;
