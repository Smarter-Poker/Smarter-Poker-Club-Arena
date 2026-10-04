-- 20261004202942_union_ops_risk_reads_bounded_production_facts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The signed-in Union Ops Risk reader still timed out after the first bounded
-- rewrite. Production has roughly 586 roster players, 548k current-week rake
-- records, 956k chip movements and 3.2m commission facts in the selected
-- union. The remaining plan executed two ledger probes per roster row, scanned
-- the commission window without an agent key, and expanded every rake JSON
-- record even though completed UTC days already have a vouched per-player
-- rollup. Those three independent scans each consumed most or all of the
-- request budget.
--
-- This migration changes only the read-only Risk report. Completed days come
-- from club_rake_daily_user when club_rake_rollup_complete vouches for them.
-- Partial days and uncovered complete days remain exact, bounded ranges.
-- Current cash-hand edges read the immutable rake_attributions ledger; legacy
-- and tournament rows without a hand id retain the report's historical raw
-- contribution-weighted allocation, and every signed reversal remains on
-- rake_records. Player table flows are two set-based ledger passes, and agent
-- commission totals are one indexed pass per actual roster pair.
--
-- No money moves. Authorization, signature, open-ended lower-bound contract,
-- signed reversal arithmetic, canonical roster choice, result columns, names,
-- roles and rounding are unchanged. The indexes are built concurrently before
-- the transactional function replacement so active writers are not blocked.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure)) = 'cb7441792b196bcfc9c73ebafb2fede9'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_commissions_risk_window
  ON public.agent_commissions (club_id, user_id, created_at)
  INCLUDE (amount);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_risk_in_window
  ON public.chip_ledger (club_id, created_at, to_entity_id)
  INCLUDE (amount)
  WHERE status = 'posted'
    AND to_type = 'player_wallet'
    AND from_type = 'table_stack';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_risk_out_window
  ON public.chip_ledger (club_id, created_at, from_entity_id)
  INCLUDE (amount)
  WHERE status = 'posted'
    AND from_type = 'player_wallet'
    AND to_type = 'table_stack';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_records_union_null_hand_window
  ON public.rake_records (club_id, created_at)
  WHERE hand_id IS NULL AND player_contributions IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_records_union_negative_window
  ON public.rake_records (club_id, created_at)
  WHERE rake_amount < 0 AND player_contributions IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE
  v_index text;
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '992fd2f4e0d37df3ff418a00eb7f620b' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT md5(p.prosrc)
        FROM pg_proc p
       WHERE p.oid =
         'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure)
       IS DISTINCT FROM '05838c201c3acf4ec130f911915d0839' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_BODY_PREIMAGE_CHANGED';
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
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_SECURITY_PREIMAGE_CHANGED';
  END IF;

  FOREACH v_index IN ARRAY ARRAY[
    'idx_agent_commissions_risk_window',
    'idx_chip_ledger_risk_in_window',
    'idx_chip_ledger_risk_out_window',
    'idx_rake_records_union_null_hand_window',
    'idx_rake_records_union_negative_window'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
       WHERE i.indexrelid = ('public.' || v_index)::regclass
         AND i.indisvalid AND i.indisready AND i.indislive
    ) THEN
      RAISE EXCEPTION 'UNION_AGENT_RISK_INDEX_UNUSABLE: %', v_index;
    END IF;
  END LOOP;

  IF pg_get_indexdef('public.idx_agent_commissions_risk_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_agent_commissions_risk_window ON public.agent_commissions USING btree (club_id, user_id, created_at) INCLUDE (amount)'
     OR pg_get_indexdef('public.idx_chip_ledger_risk_in_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_chip_ledger_risk_in_window ON public.chip_ledger USING btree (club_id, created_at, to_entity_id) INCLUDE (amount) WHERE ((status = ''posted''::text) AND (to_type = ''player_wallet''::text) AND (from_type = ''table_stack''::text))'
     OR pg_get_indexdef('public.idx_chip_ledger_risk_out_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_chip_ledger_risk_out_window ON public.chip_ledger USING btree (club_id, created_at, from_entity_id) INCLUDE (amount) WHERE ((status = ''posted''::text) AND (from_type = ''player_wallet''::text) AND (to_type = ''table_stack''::text))'
     OR pg_get_indexdef('public.idx_rake_records_union_null_hand_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_rake_records_union_null_hand_window ON public.rake_records USING btree (club_id, created_at) WHERE ((hand_id IS NULL) AND (player_contributions IS NOT NULL))'
     OR pg_get_indexdef('public.idx_rake_records_union_negative_window'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_rake_records_union_negative_window ON public.rake_records USING btree (club_id, created_at) WHERE ((rake_amount < (0)::numeric) AND (player_contributions IS NOT NULL))' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_INDEX_SHAPE_CHANGED';
  END IF;

  IF to_regclass('public.club_rake_daily_user') IS NULL
     OR to_regclass('public.club_rake_rollup_complete') IS NULL
     OR to_regclass('public.rake_attributions') IS NULL THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_FACT_SOURCE_MISSING';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_union_agent_risk_report(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',
  p_since timestamptz DEFAULT NULL)
RETURNS TABLE(
  agent_user_id uuid,
  agent_name text,
  club_name text,
  role text,
  players integer,
  seated_now integer,
  rake_generated numeric,
  player_net numeric,
  commission_accrued numeric,
  credit_extended numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET jit TO 'off'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_today timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_head_end timestamptz;
  v_tail_start timestamptz;
  v_clubs uuid[];
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT COALESCE(array_agg(x.club_id), '{}'::uuid[])
    INTO v_clubs
    FROM (
      SELECT p_union_id AS club_id
      UNION
      SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id = p_union_id
    ) x;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN
    v_day_lo := v_day_lo + 1;
  END IF;
  v_head_end := LEAST(v_day_lo::timestamptz, v_today);
  v_tail_start := GREATEST(v_today, v_from);

  RETURN QUERY
  WITH roster AS MATERIALIZED (
    SELECT m.agent_id AS agent_user_id,
           m.user_id AS player_id,
           m.club_id,
           m.joined_at,
           COALESCE(m.credit_used, 0) AS credit_used
      FROM public.club_members m
     WHERE m.club_id = ANY(v_clubs)
       AND m.agent_id IS NOT NULL
  ),
  rake_roster AS MATERIALIZED (
    SELECT DISTINCT ON (r.player_id)
           r.player_id, r.club_id
      FROM roster r
     ORDER BY r.player_id, (r.club_id = p_union_id),
              r.joined_at ASC NULLS LAST, r.club_id
  ),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = ANY(v_clubs)
       AND rc.day >= v_day_lo
       AND rc.day < v_today::date
  ),
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM unnest(v_clubs) c(club_id)
      CROSS JOIN generate_series(v_day_lo, v_today::date - 1, interval '1 day') g
     WHERE v_day_lo < v_today::date
       AND NOT EXISTS (
         SELECT 1 FROM ok_days o
          WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  rollup_rake AS (
    SELECT rr.player_id, rr.club_id, SUM(d.rake_amount) AS amount
      FROM public.club_rake_daily_user d
      JOIN ok_days o ON o.club_id = d.club_id AND o.day = d.day
      JOIN rake_roster rr ON rr.player_id = d.user_id
     GROUP BY rr.player_id, rr.club_id
  ),
  edge_attribution_rake AS (
    SELECT rr.player_id, rr.club_id, SUM(a.rake_amount) AS amount
      FROM (
        SELECT ra.player_id, ra.rake_amount
          FROM public.rake_attributions ra
         WHERE v_from >= v_today - interval '7 days'
           AND ra.club_id = ANY(v_clubs)
           AND ra.created_at >= v_from
           AND ra.created_at < v_head_end
           AND ra.hand_id IS NOT NULL
           AND ra.rake_amount > 0
        UNION ALL
        SELECT ra.player_id, ra.rake_amount
          FROM public.rake_attributions ra
         WHERE ra.club_id = ANY(v_clubs)
           AND ra.created_at >= v_tail_start
           AND ra.hand_id IS NOT NULL
           AND ra.rake_amount > 0
      ) a
      JOIN rake_roster rr ON rr.player_id = a.player_id
     GROUP BY rr.player_id, rr.club_id
  ),
  raw_records AS MATERIALIZED (
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE v_from < v_today - interval '7 days'
       AND r.club_id = ANY(v_clubs)
       AND r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE v_from >= v_today - interval '7 days'
       AND r.club_id = ANY(v_clubs)
       AND r.created_at >= v_from AND r.created_at < v_head_end
       AND r.hand_id IS NULL
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM ok_days o
      JOIN public.rake_records r
        ON r.club_id = o.club_id
       AND r.created_at >= o.day::timestamptz
       AND r.created_at < (o.day + 1)::timestamptz
     WHERE r.hand_id IS NULL
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_days gd
      JOIN public.rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at < (gd.day + 1)::timestamptz
     WHERE r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE r.club_id = ANY(v_clubs)
       AND r.created_at >= v_tail_start
       AND r.hand_id IS NULL
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM public.rake_records r
     WHERE r.club_id = ANY(v_clubs)
       AND r.created_at >= v_from
       AND r.rake_amount < 0 AND r.player_contributions IS NOT NULL
  ),
  raw_rake AS (
    SELECT rr.player_id, rr.club_id,
           SUM(x.rake_amount * split.contribution / NULLIF(split.total, 0)) AS amount
      FROM raw_records x
      CROSS JOIN LATERAL (
        SELECT (e.key)::uuid AS player_id,
               e.value::numeric AS contribution,
               SUM(e.value::numeric) OVER () AS total
          FROM jsonb_each_text(x.player_contributions) e(key, value)
         WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           AND e.value::numeric > 0
      ) split
      JOIN rake_roster rr ON rr.player_id = split.player_id
     WHERE split.total > 0
     GROUP BY rr.player_id, rr.club_id
  ),
  rake AS (
    SELECT q.player_id, q.club_id, SUM(q.amount) AS rake_generated
      FROM (
        SELECT * FROM rollup_rake
        UNION ALL SELECT * FROM edge_attribution_rake
        UNION ALL SELECT * FROM raw_rake
      ) q
     GROUP BY q.player_id, q.club_id
  ),
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
  ),
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
  ),
  seated AS MATERIALIZED (
    SELECT s.user_id, s.club_id
      FROM public.table_seats s
      JOIN (SELECT DISTINCT r.player_id, r.club_id FROM roster r) p
        ON p.player_id = s.user_id AND p.club_id = s.club_id
     WHERE s.left_at IS NULL
     GROUP BY s.user_id, s.club_id
  )
  SELECT r.agent_user_id,
         pr.username,
         cl.name,
         COALESCE(a.role, 'agent'),
         COUNT(DISTINCT r.player_id)::int,
         COUNT(DISTINCT r.player_id) FILTER (WHERE st.user_id IS NOT NULL)::int,
         ROUND(COALESCE(SUM(rk.rake_generated), 0), 2),
         ROUND(COALESCE(SUM(fl.net), 0), 2),
         ROUND(COALESCE(MAX(cm.amt), 0), 2),
         ROUND(COALESCE(SUM(r.credit_used), 0), 2)
    FROM roster r
    LEFT JOIN public.profiles pr ON pr.id = r.agent_user_id
    LEFT JOIN public.clubs cl ON cl.id = r.club_id
    LEFT JOIN public.agents a ON a.user_id = r.agent_user_id AND a.club_id = r.club_id
    LEFT JOIN rake rk ON rk.player_id = r.player_id AND rk.club_id = r.club_id
    LEFT JOIN flows fl ON fl.player_id = r.player_id AND fl.club_id = r.club_id
    LEFT JOIN comm cm ON cm.agent_user_id = r.agent_user_id AND cm.club_id = r.club_id
    LEFT JOIN seated st ON st.user_id = r.player_id AND st.club_id = r.club_id
   GROUP BY r.agent_user_id, pr.username, cl.name, a.role
   ORDER BY 8 DESC NULLS LAST;
END
$function$;

ALTER FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  TO authenticated, service_role;

DO $postimage$
DECLARE
  v_def_md5 text;
  v_body_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)), md5(p.prosrc)
    INTO v_def_md5, v_body_md5
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure;
  IF v_def_md5 IS DISTINCT FROM 'cb7441792b196bcfc9c73ebafb2fede9'
     OR v_body_md5 IS DISTINCT FROM '97759cacd2a158ebc79c48659a65003a' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_POSTIMAGE_CHANGED: def %, body %',
      v_def_md5, v_body_md5;
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
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_SECURITY_POSTIMAGE_CHANGED';
  END IF;
END
$postimage$;

COMMIT;
