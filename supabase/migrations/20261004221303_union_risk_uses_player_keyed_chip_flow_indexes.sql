-- 20261004221303_union_risk_uses_player_keyed_chip_flow_indexes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The signed-in Union Operations Risk report could still miss the eight-second
-- request budget on a cold production read. Same-snapshot production profiling
-- isolated the remaining cost to two broad chip-ledger range scans. The
-- existing result was compared with an exact per-(club, player) formulation:
-- every pair matched and both signed totals were identical.
--
-- This migration changes only that read-only Risk component. Two partial,
-- covering indexes put the roster identity before the time range, and the
-- function probes those exact identities. Rake, commissions, roster choice,
-- authorization, output shape, rounding, ownership, volatility, JIT guard and
-- grants remain unchanged. No chips, commissions or settlement rows move.
--
-- @qualified-postimage: definition md5 = cbb408858f75257d5dbc96f8feb5a96b
-- @qualified-postimage: body md5 = 81bf3a0faaf9d44b7ecb9996065a2857

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_risk_in_player_window
  ON public.chip_ledger (club_id, to_entity_id, created_at)
  INCLUDE (amount)
  WHERE status = 'posted'
    AND to_type = 'player_wallet'
    AND from_type = 'table_stack';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_risk_out_player_window
  ON public.chip_ledger (club_id, from_entity_id, created_at)
  INCLUDE (amount)
  WHERE status = 'posted'
    AND from_type = 'player_wallet'
    AND to_type = 'table_stack';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  v_definition text;
  v_body text;
  v_old text := $old$
  flow_legs AS MATERIALIZED (
    SELECT l.to_entity_id AS player_id, l.club_id, SUM(l.amount) AS amount
      FROM public.chip_ledger l
      JOIN (SELECT DISTINCT r.player_id, r.club_id FROM roster r) p
        ON p.player_id = l.to_entity_id AND p.club_id = l.club_id
     WHERE l.club_id = ANY(v_clubs)
       AND l.created_at >= v_from
       AND l.status = 'posted'
       AND l.to_type = 'player_wallet'
       AND l.from_type = 'table_stack'
     GROUP BY l.to_entity_id, l.club_id
    UNION ALL
    SELECT l.from_entity_id AS player_id, l.club_id, -SUM(l.amount) AS amount
      FROM public.chip_ledger l
      JOIN (SELECT DISTINCT r.player_id, r.club_id FROM roster r) p
        ON p.player_id = l.from_entity_id AND p.club_id = l.club_id
     WHERE l.club_id = ANY(v_clubs)
       AND l.created_at >= v_from
       AND l.status = 'posted'
       AND l.from_type = 'player_wallet'
       AND l.to_type = 'table_stack'
     GROUP BY l.from_entity_id, l.club_id
  ),
  flows AS (
    SELECT f.player_id, f.club_id, SUM(f.amount) AS net
      FROM flow_legs f
     GROUP BY f.player_id, f.club_id
  ),$old$;
  v_new text := $new$
  flows AS MATERIALIZED (
    SELECT p.player_id, p.club_id,
           COALESCE((
             SELECT SUM(l.amount)
               FROM public.chip_ledger l
              WHERE l.club_id = p.club_id
                AND l.to_entity_id = p.player_id
                AND l.created_at >= v_from
                AND l.status = 'posted'
                AND l.to_type = 'player_wallet'
                AND l.from_type = 'table_stack'
           ), 0) - COALESCE((
             SELECT SUM(l.amount)
               FROM public.chip_ledger l
              WHERE l.club_id = p.club_id
                AND l.from_entity_id = p.player_id
                AND l.created_at >= v_from
                AND l.status = 'posted'
                AND l.from_type = 'player_wallet'
                AND l.to_type = 'table_stack'
           ), 0) AS net
      FROM (SELECT DISTINCT r.player_id, r.club_id FROM roster r) p
  ),$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc
    INTO v_definition, v_body
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure;

  IF md5(v_definition) IS DISTINCT FROM 'cb7441792b196bcfc9c73ebafb2fede9'
     OR md5(v_body) IS DISTINCT FROM '97759cacd2a158ebc79c48659a65003a' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PLAYER_FLOW_PREIMAGE_CHANGED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM
           ARRAY['search_path=public','jit=off']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PLAYER_FLOW_SECURITY_CHANGED';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PLAYER_FLOW_SOURCE_CHANGED';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;

ALTER FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  TO authenticated, service_role;

DO $postimage$
DECLARE
  v_source text := pg_get_functiondef(
    'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM
           ARRAY['search_path=public','jit=off']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) OR pg_get_indexdef('public.idx_chip_ledger_risk_in_player_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_chip_ledger_risk_in_player_window ON public.chip_ledger USING btree (club_id, to_entity_id, created_at) INCLUDE (amount) WHERE ((status = ''posted''::text) AND (to_type = ''player_wallet''::text) AND (from_type = ''table_stack''::text))'
     OR pg_get_indexdef('public.idx_chip_ledger_risk_out_player_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_chip_ledger_risk_out_player_window ON public.chip_ledger USING btree (club_id, from_entity_id, created_at) INCLUDE (amount) WHERE ((status = ''posted''::text) AND (from_type = ''player_wallet''::text) AND (to_type = ''table_stack''::text))'
     OR position('l.to_entity_id = p.player_id' in v_source) = 0
     OR position('l.from_entity_id = p.player_id' in v_source) = 0
     OR position('flow_legs AS MATERIALIZED' in v_source) <> 0
     OR md5(v_source) IS DISTINCT FROM 'cbb408858f75257d5dbc96f8feb5a96b'
     OR (SELECT md5(p.prosrc)
           FROM pg_proc p
          WHERE p.oid =
            'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure)
        IS DISTINCT FROM '81bf3a0faaf9d44b7ecb9996065a2857' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PLAYER_FLOW_POSTIMAGE_CHANGED';
  END IF;
END
$postimage$;

COMMIT;
