-- Source-custody guards also take G. Accepted hands must acquire it before B,
-- before T, and before any financial row lock; terminal authorities use G then B.
-- This changes lock order only. No balances, hands, permits, or incidents change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure)) NOT IN ('f1337496592df1b4e89cac9fc7ecfef8','409b14ee72ce888d3b26524c52d49a68')
 OR md5(pg_get_functiondef('public.fn_ca_lock_settlement_lane_global()'::regprocedure)) <> '6b4cf15d9a7cd253e957e1571b300f40'
 OR md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)) <> '2bfb53c26a9043bcb1cd015dfbebc8b7'
 OR NOT EXISTS(
  SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure
   AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef
   AND proconfig=ARRAY['search_path=public, pg_temp']
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 ) THEN
  RAISE EXCEPTION 'Hand terminal lane predecessor or authority changed; review before installation';
 END IF;
END $preflight$;
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

DO $postflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure)) <> '409b14ee72ce888d3b26524c52d49a68'
 OR NOT EXISTS(
  SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure
   AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef
   AND proconfig=ARRAY['search_path=public, pg_temp']
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 ) THEN
  RAISE EXCEPTION 'Hand terminal lane postimage or authority mismatch';
 END IF;
END $postflight$;
COMMENT ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) IS
 'Accepted hand lane: G shared, B shared, then tournament T shared before financial row locks. G is held before source-custody guards run, so a terminal authority queued for G cannot make the accepted hand refuse while waiting for its B. Rolling authorities remain concurrent across tournaments.';
COMMIT;
