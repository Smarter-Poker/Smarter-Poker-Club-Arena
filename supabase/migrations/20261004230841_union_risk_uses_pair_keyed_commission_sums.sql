-- 20261004230841_union_risk_uses_pair_keyed_commission_sums.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The player-keyed chip-flow correction removed the dominant cold scan, but a
-- first genuinely cold production call could still cross the eight-second
-- request budget. The remaining avoidable work was the commission CTE: it read
-- 3.25 million exact-pair index entries into one global aggregate. Aggregating
-- inside each of the 111 authoritative (agent, club) probes preserves every
-- signed amount while avoiding that global row stream. Same-snapshot production
-- proof found zero differing pairs and identical 1,095,760.46 signed totals.
--
-- This changes only that read-only Risk component. Authorization, roster and
-- rake selection, chip flows, output shape, rounding, ownership, volatility,
-- JIT guard and grants remain unchanged. No chips, commissions or settlements
-- move.
--
-- @qualified-postimage: definition md5 = 01baaad80223fe3364d9cf90da0076ae
-- @qualified-postimage: body md5 = 5fc4d72c95f2b58ab61c783e800e0327

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  v_definition text;
  v_body text;
  v_old text := $old$
  comm_pairs AS MATERIALIZED (
    SELECT DISTINCT r.agent_user_id, r.club_id FROM roster r
  ),
  comm AS (
    SELECT ac.user_id AS agent_user_id, ac.club_id, SUM(ac.amount) AS amt
      FROM comm_pairs p
      JOIN public.agent_commissions ac
        ON ac.user_id = p.agent_user_id AND ac.club_id = p.club_id
     WHERE ac.created_at >= v_from
     GROUP BY ac.user_id, ac.club_id
  ),$old$;
  v_new text := $new$
  comm_pairs AS MATERIALIZED (
    SELECT DISTINCT r.agent_user_id, r.club_id FROM roster r
  ),
  comm AS MATERIALIZED (
    SELECT p.agent_user_id, p.club_id,
           COALESCE((
             SELECT SUM(ac.amount)
               FROM public.agent_commissions ac
              WHERE ac.user_id = p.agent_user_id
                AND ac.club_id = p.club_id
                AND ac.created_at >= v_from
           ), 0) AS amt
      FROM comm_pairs p
  ),$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc
    INTO v_definition, v_body
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure;

  IF md5(v_definition) IS DISTINCT FROM 'cbb408858f75257d5dbc96f8feb5a96b'
     OR md5(v_body) IS DISTINCT FROM '81bf3a0faaf9d44b7ecb9996065a2857' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PAIR_COMMISSION_PREIMAGE_CHANGED';
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
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indexrelid = 'public.idx_agent_commissions_risk_window'::regclass
       AND i.indisvalid AND i.indisready AND i.indislive
       AND pg_get_indexdef(i.indexrelid) IS NOT DISTINCT FROM
           'CREATE INDEX idx_agent_commissions_risk_window ON public.agent_commissions USING btree (club_id, user_id, created_at) INCLUDE (amount)'
  ) THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PAIR_COMMISSION_SECURITY_OR_INDEX_CHANGED';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) IS DISTINCT FROM 1
     OR (length(v_body) - length(replace(v_body, v_old, '')))
       / length(v_old) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PAIR_COMMISSION_SOURCE_CHANGED';
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
  ) OR position('comm AS MATERIALIZED' in v_source) = 0
     OR position('ac.user_id = p.agent_user_id' in v_source) = 0
     OR position('ac.club_id = p.club_id' in v_source) = 0
     OR position('JOIN public.agent_commissions ac' in v_source) <> 0
     OR position('GROUP BY ac.user_id, ac.club_id' in v_source) <> 0
     OR md5(v_source) IS DISTINCT FROM '01baaad80223fe3364d9cf90da0076ae'
     OR (SELECT md5(p.prosrc)
           FROM pg_proc p
          WHERE p.oid =
            'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure)
        IS DISTINCT FROM '5fc4d72c95f2b58ab61c783e800e0327' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_PAIR_COMMISSION_POSTIMAGE_CHANGED';
  END IF;
END
$postimage$;

COMMIT;
