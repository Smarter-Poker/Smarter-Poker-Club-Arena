-- 20261004153522_union_ops_reports_stay_inside_the_signed_in_budget.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Financial Admin used to start three full-accounting reads together whenever
-- staff selected a union. The risk report expanded every rake_records JSON row
-- and aggregated every wallet transaction before it met the selected union's
-- roster. The distribution check expressed a three-club filter as a join with
-- an OR, which production planned across 15.6 million commission rows. The
-- third read executed the global daily union-law audit interactively; its last
-- successful production run took 17.5 seconds, beyond the signed-in request
-- budget, and it calls the distribution check again.
--
-- The risk report preserves the signed rake_records/player_contributions
-- authority used by its preimage, but filters the canonical union roster and
-- club/time range before expanding contribution JSON. Posted chip_ledger
-- table-stack flows and club-scoped agent_commissions meet the same roster
-- before aggregation. The distribution check preserves its
-- separate accounting scope (clubs.union_id plus the union house club) and its
-- signed reversal arithmetic. A concurrent covering index gives that exact
-- all-rake-records range an interactive plan; commissions stay on their
-- authoritative indexed ledger. The daily law audit records its
-- result; the browser reads that one-row cache and never executes the audit.
--
-- No money moves and no rate, period boundary, settlement, or audit verdict is
-- changed. The migration seeds one verdict; the daily cron remains its sole
-- recurring producer.
--
-- @live-proof: (SELECT public.fn_union_law_selftest_status()->>'run_status' = 'succeeded' AND pg_get_indexdef('public.idx_rake_records_union_signed_window'::regclass) = 'CREATE INDEX idx_rake_records_union_signed_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (rake_amount)')

-- rake_records is an active engine ledger. Build its signed reporting path
-- without taking the writer-blocking lock a transactional CREATE INDEX would
-- require. IF NOT EXISTS makes the staged migration retryable; the validity
-- assertion refuses an interrupted concurrent build before any function body
-- changes. This statement must remain outside BEGIN by PostgreSQL law.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_records_union_signed_window
  ON public.rake_records (club_id, created_at)
  INCLUDE (rake_amount);

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indexrelid = 'public.idx_rake_records_union_signed_window'::regclass
       AND i.indisvalid AND i.indisready AND i.indislive
       AND i.indpred IS NULL
       AND i.indnkeyatts = 2 AND i.indnatts = 3
       AND (SELECT array_agg(a.attname ORDER BY k.ordinality)
              FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ordinality)
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
           = ARRAY['club_id','created_at','rake_amount']::name[]
  ) THEN
    RAISE EXCEPTION 'UNION_SIGNED_RAKE_WINDOW_INDEX_SHAPE_CHANGED';
  END IF;
  IF md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '89e2a62ef34afbf1cda9465d052ae46e' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_PREIMAGE_CHANGED';
  END IF;
  IF md5(pg_get_functiondef('public.fn_union_distribution_check(uuid,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '2347e9268b84a1685e37af32d8b050e8' THEN
    RAISE EXCEPTION 'UNION_DISTRIBUTION_CHECK_PREIMAGE_CHANGED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobid = 121
       AND jobname = 'union-law-selftest'
       AND username = 'postgres'
       AND database = 'postgres'
       AND active
       AND command = 'SET statement_timeout = ''600s''; SELECT public.fn_union_law_selftest();'
  ) THEN
    RAISE EXCEPTION 'UNION_LAW_SELFTEST_JOB_PREIMAGE_CHANGED';
  END IF;
  IF to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'PG_CRON_ALTER_JOB_SIGNATURE_CHANGED';
  END IF;
  IF to_regprocedure('public.fn_union_overseer_options()') IS NOT NULL THEN
    RAISE EXCEPTION 'UNION_OVERSEER_OPTIONS_ALREADY_EXISTS';
  END IF;
END
$preimage$;

-- Financial Admin must not enumerate every discoverable union and then offer
-- money controls optimistically. This reader returns only unions for which
-- the signed-in caller passes the exact predicate enforced by every operation
-- below. A platform role is deliberately not a union-specific bypass.
CREATE FUNCTION public.fn_union_overseer_options()
RETURNS TABLE(union_id uuid, union_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT u.id, u.name
    FROM public.unions u
   WHERE (SELECT auth.uid()) IS NOT NULL
     AND public.fn_is_union_overseer(u.id, (SELECT auth.uid()))
   ORDER BY lower(u.name), u.name, u.id
$function$;

REVOKE ALL ON FUNCTION public.fn_union_overseer_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_overseer_options() TO authenticated, service_role;

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
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
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
    -- Preserve the canonical attribution rule already owned by
    -- fn_union_rake_paid_by_club: a real union_clubs membership wins over the
    -- union house fallback, then the oldest membership and club id break ties.
    SELECT DISTINCT ON (r.player_id)
           r.player_id, r.club_id
      FROM roster r
     ORDER BY r.player_id, (r.club_id = p_union_id),
              r.joined_at ASC NULLS LAST, r.club_id
  ),
  scoped_rake_records AS MATERIALIZED (
    SELECT rr.club_id, rr.rake_amount, rr.player_contributions
      FROM public.rake_records rr
     WHERE rr.club_id = ANY(v_clubs)
       AND rr.created_at >= v_from
       AND rr.player_contributions IS NOT NULL
  ),
  rake AS (
    SELECT r.player_id, r.club_id,
           SUM(srr.rake_amount * (e.value::numeric) / NULLIF(c.total, 0)) AS rake_generated
      FROM scoped_rake_records srr
      CROSS JOIN LATERAL (
        SELECT SUM(t.value::numeric) AS total
          FROM jsonb_each_text(srr.player_contributions) t(key, value)
      ) c
      CROSS JOIN LATERAL jsonb_each_text(srr.player_contributions) e(key, value)
      JOIN rake_roster r
        ON r.player_id = (e.key)::uuid
     WHERE c.total > 0
     GROUP BY r.player_id, r.club_id
  ),
  flows AS (
    SELECT r.player_id, r.club_id,
           SUM(CASE WHEN l.to_type = 'player_wallet'
                         AND l.to_entity_id = r.player_id
                         AND l.from_type = 'table_stack'
                    THEN l.amount ELSE 0 END)
         - SUM(CASE WHEN l.from_type = 'player_wallet'
                         AND l.from_entity_id = r.player_id
                         AND l.to_type = 'table_stack'
                    THEN l.amount ELSE 0 END) AS net
      FROM roster r
      JOIN public.chip_ledger l
        ON l.club_id = r.club_id
       AND ((l.from_entity_id = r.player_id AND l.from_type = 'player_wallet'
             AND l.to_type = 'table_stack')
         OR (l.to_entity_id = r.player_id AND l.to_type = 'player_wallet'
             AND l.from_type = 'table_stack'))
     WHERE l.status = 'posted' AND l.created_at >= v_from
     GROUP BY r.player_id, r.club_id
  ),
  comm AS (
    SELECT ac.user_id AS agent_user_id, ac.club_id, SUM(ac.amount) AS amt
      FROM (SELECT DISTINCT rr.agent_user_id, rr.club_id FROM roster rr) r
      JOIN public.agent_commissions ac
        ON ac.user_id = r.agent_user_id AND ac.club_id = r.club_id
     WHERE ac.created_at >= v_from
     GROUP BY ac.user_id, ac.club_id
  )
  SELECT r.agent_user_id,
         pr.username,
         cl.name,
         COALESCE(a.role, 'agent'),
         COUNT(DISTINCT r.player_id)::int,
         COUNT(DISTINCT r.player_id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM public.table_seats ts
              WHERE ts.user_id = r.player_id
                AND ts.club_id = r.club_id
                AND ts.left_at IS NULL))::int,
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
   GROUP BY r.agent_user_id, pr.username, cl.name, a.role
   ORDER BY 8 DESC NULLS LAST;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_distribution_check(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',
  p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_clubs uuid[];
  v_rake numeric;
  v_comm numeric;
  v_rb numeric;
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT COALESCE(array_agg(c.id), '{}'::uuid[])
    INTO v_clubs
    FROM public.clubs c
   WHERE c.union_id = p_union_id OR c.id = p_union_id;

  -- Preserve the preimage exactly: every signed rake_records row, including
  -- tournament fees and reversals, from the requested lower bound. The
  -- concurrent covering index makes this a bounded club/time range read.
  SELECT COALESCE(SUM(rr.rake_amount), 0)
    INTO v_rake
    FROM public.rake_records rr
   WHERE rr.club_id = ANY(v_clubs)
     AND rr.created_at >= v_from;

  SELECT COALESCE(SUM(ac.amount), 0)
    INTO v_comm
    FROM public.agent_commissions ac
   WHERE ac.club_id = ANY(v_clubs)
     AND ac.created_at >= v_from;

  SELECT COALESCE(SUM(rp.rakeback_amount), 0)
    INTO v_rb
    FROM public.rakeback_periods rp
   WHERE rp.club_id = ANY(v_clubs) AND rp.period_start >= v_from::date;

  RETURN jsonb_build_object(
    'period_start', v_from,
    'rake_collected', ROUND(v_rake, 2),
    'agent_commissions', ROUND(v_comm, 2),
    'player_rakeback', ROUND(v_rb, 2),
    'total_distributed', ROUND(v_comm + v_rb, 2),
    'over_distributed_by', ROUND(GREATEST((v_comm + v_rb) - v_rake, 0), 2),
    'healthy', (v_comm + v_rb) <= v_rake * 1.001,
    'note', 'Player rakeback is funded from the agent''s commission, so '
            || 'commissions + rakeback must not exceed the rake collected.');
END
$function$;

CREATE TABLE public.union_law_selftest_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb NOT NULL,
  CONSTRAINT union_law_selftest_result_shape CHECK (
    jsonb_typeof(result) = 'object'
    AND jsonb_typeof(result -> 'healthy') = 'boolean'
    AND jsonb_typeof(result -> 'breaches') = 'array'
    AND jsonb_typeof(result -> 'warnings') = 'array')
);

CREATE INDEX union_law_selftest_runs_completed_at
  ON public.union_law_selftest_runs (completed_at DESC);

ALTER TABLE public.union_law_selftest_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.union_law_selftest_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.union_law_selftest_runs FROM service_role;
REVOKE ALL ON SEQUENCE public.union_law_selftest_runs_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_union_law_selftest_record()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;

  v_result := public.fn_union_law_selftest();
  IF jsonb_typeof(v_result) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_result -> 'healthy') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_result -> 'breaches') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_result -> 'warnings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'union_law_selftest_result_invalid';
  END IF;

  INSERT INTO public.union_law_selftest_runs(started_at, result)
  VALUES (v_started, v_result);
  DELETE FROM public.union_law_selftest_runs
   WHERE completed_at < clock_timestamp() - interval '30 days';
  RETURN v_result;
END
$function$;

CREATE FUNCTION public.fn_union_law_selftest_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_run public.union_law_selftest_runs%ROWTYPE;
  v_job_found boolean := false;
  v_job_active boolean;
  v_cron_status text;
  v_cron_start timestamptz;
  v_cron_end timestamptz;
  v_unavailable_status text;
  v_unavailable_note text;
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR (
       NOT public.fn_is_platform_admin()
       AND NOT public.fn_is_any_union_overseer(auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT j.active, d.status, d.start_time, d.end_time
    INTO v_job_active, v_cron_status, v_cron_start, v_cron_end
    FROM cron.job j
    LEFT JOIN LATERAL (
      SELECT r.status, r.start_time, r.end_time
        FROM cron.job_run_details r
       WHERE r.jobid = j.jobid
       ORDER BY r.start_time DESC
       LIMIT 1
    ) d ON true
   WHERE j.jobid = 121 AND j.jobname = 'union-law-selftest';
  v_job_found := FOUND;

  SELECT * INTO v_run
    FROM public.union_law_selftest_runs
   ORDER BY completed_at DESC, id DESC
   LIMIT 1;
  IF FOUND
     AND v_job_found AND v_job_active
     AND v_cron_start IS NOT NULL
     AND v_cron_status = 'succeeded'
     AND v_run.started_at >= v_cron_start
     AND v_run.completed_at >= now() - interval '36 hours' THEN
    RETURN v_run.result || jsonb_build_object(
      'available', true,
      'run_status', 'succeeded',
      'started_at', v_run.started_at,
      'checked_at', v_run.completed_at);
  END IF;

  IF NOT v_job_found THEN
    v_unavailable_status := 'missing';
    v_unavailable_note := 'The Scheduled Union Law Audit Is Missing.';
  ELSIF NOT v_job_active THEN
    v_unavailable_status := 'inactive';
    v_unavailable_note := 'The Scheduled Union Law Audit Is Inactive.';
  ELSIF v_cron_start IS NULL THEN
    v_unavailable_status := 'pending';
    v_unavailable_note := 'The Scheduled Union Law Audit Has Not Run Yet.';
  ELSIF v_cron_status <> 'succeeded' THEN
    v_unavailable_status := COALESCE(v_cron_status, 'pending');
    v_unavailable_note := 'The Latest Scheduled Union Law Audit Did Not Succeed.';
  ELSIF v_run.id IS NULL OR v_run.started_at < v_cron_start THEN
    v_unavailable_status := 'pending';
    v_unavailable_note := 'The Detailed Verdict Is Not Available For The Latest Audit.';
  ELSE
    v_unavailable_status := 'stale';
    v_unavailable_note := 'The Latest Union Law Verdict Is Older Than Thirty-Six Hours.';
  END IF;

  RETURN jsonb_build_object(
    'available', false,
    'healthy', false,
    'breaches', '[]'::jsonb,
    'warnings', '[]'::jsonb,
    'run_status', v_unavailable_status,
    'started_at', v_cron_start,
    'checked_at', v_cron_end,
    'note', v_unavailable_note);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_union_law_selftest_record() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_union_law_selftest_record() FROM service_role;
REVOKE ALL ON FUNCTION public.fn_union_law_selftest_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_law_selftest_status() TO authenticated, service_role;

-- Do not make the first signed-in read wait for tomorrow's cron. This uses the
-- newly optimized distribution reader and remains under this migration's
-- bounded 60-second statement timeout; any incomplete audit aborts the whole
-- migration rather than publishing an unavailable or stale green verdict.
SELECT public.fn_union_law_selftest_record();

SELECT cron.alter_job(
  121,
  command := 'SET statement_timeout = ''600s''; SELECT public.fn_union_law_selftest_record();');

DO $postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.idx_rake_records_union_signed_window'::regclass
       AND i.indisvalid AND i.indisready AND i.indislive
       AND i.indpred IS NULL
       AND i.indnkeyatts = 2 AND i.indnatts = 3
       AND (SELECT array_agg(a.attname ORDER BY k.ordinality)
              FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ordinality)
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
           = ARRAY['club_id','created_at','rake_amount']::name[]
  ) THEN
    RAISE EXCEPTION 'UNION_SIGNED_RAKE_WINDOW_INDEX_SHAPE_LOST';
  END IF;
  IF has_function_privilege('anon', 'public.fn_union_law_selftest_status()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_union_law_selftest_status()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_union_overseer_options()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_union_overseer_options()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_union_overseer_options()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.union_law_selftest_runs', 'SELECT')
     OR has_table_privilege('service_role', 'public.union_law_selftest_runs', 'SELECT')
     OR has_table_privilege('service_role', 'public.union_law_selftest_runs', 'INSERT')
     OR has_table_privilege('service_role', 'public.union_law_selftest_runs', 'DELETE')
     OR has_sequence_privilege('service_role', 'public.union_law_selftest_runs_id_seq', 'USAGE')
     OR has_function_privilege('authenticated', 'public.fn_union_law_selftest_record()', 'EXECUTE') THEN
    RAISE EXCEPTION 'UNION_OPS_AUTHORITY_CHANGED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobid = 121
       AND command = 'SET statement_timeout = ''600s''; SELECT public.fn_union_law_selftest_record();'
  ) THEN
    RAISE EXCEPTION 'UNION_LAW_STATUS_PRODUCER_NOT_INSTALLED';
  END IF;
END
$postimage$;

COMMIT;
