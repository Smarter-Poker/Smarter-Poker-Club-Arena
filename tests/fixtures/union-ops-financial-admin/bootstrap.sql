CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA cron;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.engine', true), '') = 'on'
$$;
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.platform_admin', true), '') = 'on'
$$;

CREATE TABLE public.unions(id uuid PRIMARY KEY, name text NOT NULL, owner_id uuid);
CREATE TABLE public.clubs(
  id uuid PRIMARY KEY, name text, union_id uuid, owner_id uuid,
  is_union boolean NOT NULL DEFAULT false);
CREATE TABLE public.union_admins(
  union_id uuid NOT NULL, user_id uuid NOT NULL,
  PRIMARY KEY(union_id, user_id));
CREATE TABLE public.union_clubs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), union_id uuid, club_id uuid);
CREATE TABLE public.club_members(
  club_id uuid, user_id uuid, agent_id uuid, credit_used numeric DEFAULT 0,
  joined_at timestamptz, role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY(club_id, user_id));

CREATE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  )
$$;
CREATE FUNCTION public.fn_is_any_union_overseer(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.unions u
     WHERE public.fn_is_union_overseer(u.id, p_user_id))
$$;
CREATE FUNCTION public.fn_union_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT date_trunc('week', p_at) $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, username text);
CREATE TABLE public.agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, club_id uuid, role text);
CREATE TABLE public.table_seats(user_id uuid, club_id uuid, left_at timestamptz);
CREATE TABLE public.rake_attributions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, club_id uuid,
  rake_amount numeric NOT NULL CHECK (rake_amount >= 0), created_at timestamptz NOT NULL);
CREATE INDEX idx_rake_attributions_club_created
  ON public.rake_attributions(club_id, created_at) INCLUDE(player_id, rake_amount);
CREATE TABLE public.chip_ledger(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, from_type text,
  from_entity_id uuid, to_type text, to_entity_id uuid, amount numeric,
  status text, created_at timestamptz);
CREATE INDEX idx_chip_ledger_club_from_created
  ON public.chip_ledger(club_id, from_entity_id, created_at);
CREATE INDEX idx_chip_ledger_club_to_created
  ON public.chip_ledger(club_id, to_entity_id, created_at);
CREATE TABLE public.agent_commissions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, club_id uuid,
  amount numeric, created_at timestamptz);
CREATE INDEX idx_agent_commissions_club_created
  ON public.agent_commissions(club_id, created_at) INCLUDE(user_id, amount);
CREATE TABLE public.rake_records(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, rake_amount numeric,
  player_contributions jsonb, is_tournament boolean NOT NULL DEFAULT false,
  source text, metadata jsonb, created_at timestamptz);
CREATE INDEX idx_rake_records_club_created
  ON public.rake_records(club_id, created_at) WHERE rake_amount > 0;
CREATE TABLE public.rakeback_periods(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid,
  rakeback_amount numeric, period_start date);
CREATE INDEX idx_rakeback_periods_club ON public.rakeback_periods(club_id);
CREATE TABLE public.wallet_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text,
  category text, amount numeric, created_at timestamptz);

CREATE TABLE cron.job(
  jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean,
  username text, database text);
CREATE TABLE cron.job_run_details(
  runid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, jobid bigint,
  status text, start_time timestamptz, end_time timestamptz, return_message text);
CREATE FUNCTION cron.alter_job(
  job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job j
     SET schedule = COALESCE($2, j.schedule),
         command = COALESCE($3, j.command),
         active = COALESCE($6, j.active)
   WHERE j.jobid = $1
$$;

INSERT INTO cron.job(jobid, jobname, schedule, command, active, username, database) VALUES
  (121, 'union-law-selftest', '20 0 * * *',
   'SET statement_timeout = ''600s''; SELECT public.fn_union_law_selftest();', true,
   'postgres', 'postgres');
INSERT INTO cron.job_run_details(jobid,status,start_time,end_time,return_message) VALUES
  (121,'succeeded','2026-10-04 00:20:00+00','2026-10-04 00:20:17+00','1 row');

CREATE FUNCTION public.fn_union_law_selftest() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('healthy', true, 'breaches', '[]'::jsonb,
                            'warnings', jsonb_build_array(jsonb_build_object('check','fixture_warning')))
$$;

CREATE OR REPLACE FUNCTION public.fn_union_agent_risk_report(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_user_id uuid, agent_name text, club_name text, role text, players integer, seated_now integer, rake_generated numeric, player_net numeric, commission_accrued numeric, credit_extended numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH union_clubs_all AS (
    SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = p_union_id
    UNION SELECT p_union_id
  ),
  roster AS (
    SELECT m.agent_id AS agent_user_id, m.user_id AS player_id, m.club_id,
           COALESCE(m.credit_used,0) AS credit_used
      FROM club_members m
      JOIN union_clubs_all u ON u.club_id = m.club_id
     WHERE m.agent_id IS NOT NULL
  ),
  rake AS (
    SELECT (e.key)::uuid AS player_id,
           SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake_generated
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
     WHERE rr.created_at >= v_from
       AND rr.player_contributions IS NOT NULL AND c.total > 0
     GROUP BY 1
  ),
  flows AS (
    SELECT wt.user_id AS player_id,
           SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END)
         - SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon') THEN wt.amount ELSE 0 END) AS net
      FROM wallet_transactions wt
     WHERE wt.created_at >= v_from
     GROUP BY 1
  ),
  comm AS (
    SELECT ac.user_id AS agent_user_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
     WHERE ac.created_at >= v_from
     GROUP BY 1
  )
  SELECT r.agent_user_id,
         pr.username,
         cl.name,
         COALESCE(a.role,'agent'),
         COUNT(DISTINCT r.player_id)::int,
         COUNT(DISTINCT r.player_id) FILTER (
           WHERE EXISTS (SELECT 1 FROM table_seats ts
                          WHERE ts.user_id = r.player_id AND ts.left_at IS NULL))::int,
         ROUND(COALESCE(SUM(rk.rake_generated),0),2),
         ROUND(COALESCE(SUM(fl.net),0),2),
         ROUND(COALESCE(MAX(cm2.amt),0),2),
         ROUND(COALESCE(SUM(r.credit_used),0),2)
    FROM roster r
    LEFT JOIN profiles pr ON pr.id = r.agent_user_id
    LEFT JOIN clubs cl ON cl.id = r.club_id
    LEFT JOIN agents a ON a.user_id = r.agent_user_id AND a.club_id = r.club_id
    LEFT JOIN rake rk ON rk.player_id = r.player_id
    LEFT JOIN flows fl ON fl.player_id = r.player_id
    LEFT JOIN comm cm2 ON cm2.agent_user_id = r.agent_user_id
   GROUP BY r.agent_user_id, pr.username, cl.name, a.role
   ORDER BY 8 DESC NULLS LAST;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_distribution_check(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_rake numeric; v_comm numeric; v_rb numeric;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN RAISE EXCEPTION 'not_authorised'; END IF;
  SELECT COALESCE(SUM(rr.rake_amount),0) INTO v_rake
    FROM rake_records rr
    JOIN clubs uc ON uc.id = rr.club_id AND (uc.union_id = p_union_id OR uc.id = p_union_id)
   WHERE rr.created_at >= v_from;

  SELECT COALESCE(SUM(ac.amount),0) INTO v_comm
    FROM agent_commissions ac
    JOIN clubs uc ON uc.id = ac.club_id AND (uc.union_id = p_union_id OR uc.id = p_union_id)
   WHERE ac.created_at >= v_from;

  SELECT COALESCE(SUM(rp.rakeback_amount),0) INTO v_rb
    FROM rakeback_periods rp
    JOIN clubs uc ON uc.id = rp.club_id AND (uc.union_id = p_union_id OR uc.id = p_union_id)
   WHERE rp.period_start >= v_from::date;

  RETURN jsonb_build_object(
    'period_start', v_from,
    'rake_collected', round(v_rake,2),
    'agent_commissions', round(v_comm,2),
    'player_rakeback', round(v_rb,2),
    'total_distributed', round(v_comm + v_rb, 2),
    'over_distributed_by', round(GREATEST((v_comm + v_rb) - v_rake, 0), 2),
    'healthy', (v_comm + v_rb) <= v_rake * 1.001,
    'note', 'Player rakeback is funded from the agent''s commission, so '
            || 'commissions + rakeback must not exceed the rake collected.'
  );
END $function$;
