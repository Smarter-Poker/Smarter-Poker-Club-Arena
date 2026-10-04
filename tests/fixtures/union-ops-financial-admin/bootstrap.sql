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
  is_union boolean NOT NULL DEFAULT false, chip_treasury numeric DEFAULT 0);
CREATE TABLE public.union_admins(
  union_id uuid NOT NULL, user_id uuid NOT NULL,
  PRIMARY KEY(union_id, user_id));
CREATE TABLE public.union_clubs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), union_id uuid, club_id uuid);
CREATE TABLE public.club_members(
  club_id uuid, user_id uuid, agent_id uuid, credit_used numeric DEFAULT 0,
  chip_balance numeric DEFAULT 0,
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
CREATE FUNCTION public.fn_union_prev_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT public.fn_union_week_start(p_at) - interval '7 days' $$;
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY, username text, display_name text, alias text,
  first_name text, last_name text, full_name text);
CREATE FUNCTION public.fn_arena_name(
  p_alias text, p_username text, p_display_name text,
  p_first_name text, p_last_name text, p_full_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT COALESCE(NULLIF(btrim(p_alias), ''), NULLIF(btrim(p_username), ''),
                  NULLIF(btrim(p_display_name), ''), 'Player')
$function$;
CREATE TABLE public.agents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, club_id uuid,
  role text, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.table_seats(user_id uuid, club_id uuid, left_at timestamptz);
CREATE TABLE public.rake_attributions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hand_id uuid, rake_record_id uuid,
  player_id uuid, club_id uuid, rake_amount numeric NOT NULL CHECK (rake_amount >= 0),
  eligible_contribution numeric, contribution_weight numeric,
  weighted_rake_credit numeric, rake_method text,
  created_at timestamptz NOT NULL);
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
  amount numeric, created_at timestamptz, settled_at timestamptz);
CREATE INDEX idx_agent_commissions_club_created
  ON public.agent_commissions(club_id, created_at) INCLUDE(user_id, amount, settled_at);
CREATE INDEX agent_commissions_open_idx
  ON public.agent_commissions(club_id, user_id, created_at) INCLUDE(amount, id)
  WHERE settled_at IS NULL;
CREATE TABLE public.rake_records(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hand_id uuid, club_id uuid, rake_amount numeric,
  player_contributions jsonb, is_tournament boolean NOT NULL DEFAULT false,
  source text, metadata jsonb, rake_method text NOT NULL DEFAULT 'DEALT_EQUAL',
  created_at timestamptz);
CREATE INDEX idx_rake_records_club_created
  ON public.rake_records(club_id, created_at) WHERE rake_amount > 0;
CREATE TABLE public.club_rake_daily_user(
  club_id uuid NOT NULL, day date NOT NULL, user_id uuid NOT NULL,
  rake_amount numeric(20,2) NOT NULL DEFAULT 0, hands bigint NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(club_id,day,user_id));
CREATE INDEX club_rake_daily_user_day_idx
  ON public.club_rake_daily_user(day,club_id);
CREATE INDEX club_rake_daily_user_user_idx
  ON public.club_rake_daily_user(user_id,club_id,day);
CREATE TABLE public.club_rake_rollup_complete(
  club_id uuid NOT NULL, day date NOT NULL, rows_written integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(club_id,day));
CREATE INDEX club_rake_rollup_complete_day_idx
  ON public.club_rake_rollup_complete(day);
CREATE TABLE public.rakeback_periods(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, club_id uuid,
  rakeback_amount numeric, period_start date,
  status text NOT NULL DEFAULT 'pending');
CREATE INDEX idx_rakeback_periods_club ON public.rakeback_periods(club_id);
CREATE TABLE public.wallet_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text,
  category text, amount numeric, created_at timestamptz);

CREATE TABLE public.union_rakeback_log(
  union_id uuid, period_start timestamptz, period_end timestamptz);
CREATE TABLE public.union_wallets(
  union_id uuid PRIMARY KEY, rake_wallet numeric DEFAULT 0);
CREATE TABLE public.agent_commission_settlements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL, user_id uuid NOT NULL, union_id uuid,
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  amount numeric NOT NULL DEFAULT 0, rows_count integer NOT NULL DEFAULT 0,
  paid_at timestamptz NOT NULL DEFAULT now(), settlement_ref text,
  UNIQUE(club_id, user_id, period_start, period_end));
CREATE INDEX agent_commission_settlements_pair_idx
  ON public.agent_commission_settlements(club_id, user_id, period_start, period_end);

CREATE FUNCTION public.fn_agent_commission_paid_by_period(
  p_club_id uuid, p_user_id uuid, p_created_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                  WHERE s.club_id = p_club_id AND s.user_id = p_user_id
                    AND p_created_at >= s.period_start AND p_created_at < s.period_end);
$function$;

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

-- Match the installed preimage ACL established by the Union Ops UI grant
-- migration and preserved by later CREATE OR REPLACE migrations.
REVOKE ALL ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  TO authenticated, service_role;

-- Exact production preimage of the read-only settlement preview. The body is
-- preserved from the historical live schema capture, including its engine-or-
-- overseer authorization guard, Round labels, and arena-name fallback. The
-- 20260908 paid-period migration added the scalar predicate to both Round-2
-- scans; the production repair under test replaces those per-row calls with
-- one explicit anti-join and one commission fact set.
CREATE OR REPLACE FUNCTION public.fn_union_settlement_preview(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end   timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1_done boolean;
  v_rake_wallet numeric;
  v_r2_total numeric := 0; v_r2_payees int := 0;
  v_r3_total numeric := 0; v_r3_payees int := 0;
  v_r2_short jsonb := '[]'::jsonb;
  v_r3_short jsonb := '[]'::jsonb;
  v_r2_short_amt numeric := 0; v_r3_short_amt numeric := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT EXISTS (SELECT 1 FROM union_rakeback_log
                  WHERE union_id = p_union_id
                    AND period_start = v_from AND period_end = v_to)
    INTO v_r1_done;

  SELECT COALESCE(rake_wallet,0) INTO v_rake_wallet
    FROM union_wallets WHERE union_id = p_union_id;

  -- ROUND 2 - unsettled agent commission, and whether the club treasury covers it.
  WITH owed AS (
    SELECT ac.club_id, ac.user_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status='active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to
       AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
  ), byclub AS (
    SELECT o.club_id, SUM(o.amt) AS club_owed,
           COALESCE(c.chip_treasury,0) AS treasury, c.name
      FROM owed o JOIN clubs c ON c.id = o.club_id
     GROUP BY o.club_id, c.chip_treasury, c.name
  )
  SELECT COALESCE(SUM(o.amt),0), COUNT(*)::int
    INTO v_r2_total, v_r2_payees FROM owed o;

  WITH owed AS (
    SELECT ac.club_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status='active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)
     GROUP BY ac.club_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'club_id', o.club_id, 'club', c.name,
           'owed', o.amt, 'treasury', COALESCE(c.chip_treasury,0),
           'short_by', round(o.amt - COALESCE(c.chip_treasury,0), 2))), '[]'::jsonb),
         COALESCE(SUM(o.amt - COALESCE(c.chip_treasury,0)), 0)
    INTO v_r2_short, v_r2_short_amt
    FROM owed o JOIN clubs c ON c.id = o.club_id
   WHERE COALESCE(c.chip_treasury,0) < o.amt;

  -- ROUND 3 - pending player rakeback, and whether the paying agent covers it.
  WITH owed AS (
    SELECT rp.user_id AS player_id, rp.club_id, cm.agent_id AS agent_user,
           SUM(rp.rakeback_amount) AS amt
      FROM rakeback_periods rp
      JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN club_members cm ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= v_from::date
       AND rp.period_start <  v_to::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.user_id, rp.club_id, cm.agent_id
    HAVING SUM(rp.rakeback_amount) > 0
  )
  SELECT COALESCE(SUM(amt),0), COUNT(*)::int INTO v_r3_total, v_r3_payees FROM owed;

  WITH owed AS (
    SELECT rp.club_id, cm.agent_id AS agent_user, SUM(rp.rakeback_amount) AS amt
      FROM rakeback_periods rp
      JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN club_members cm ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= v_from::date AND rp.period_start < v_to::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.club_id, cm.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_user_id', o.agent_user,
           'agent', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username),
           'club_id', o.club_id, 'owed', o.amt,
           'agent_balance', COALESCE(am.chip_balance,0),
           'short_by', round(o.amt - COALESCE(am.chip_balance,0), 2))), '[]'::jsonb),
         COALESCE(SUM(o.amt - COALESCE(am.chip_balance,0)), 0)
    INTO v_r3_short, v_r3_short_amt
    FROM owed o
    LEFT JOIN club_members am ON am.user_id = o.agent_user AND am.club_id = o.club_id
    LEFT JOIN profiles pr ON pr.id = o.agent_user
   WHERE COALESCE(am.chip_balance,0) < o.amt;

  RETURN jsonb_build_object(
    'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1', jsonb_build_object(
      'already_executed', v_r1_done,
      'rake_treasury_available', v_rake_wallet),
    'round2', jsonb_build_object(
      'payees', v_r2_payees, 'amount', round(v_r2_total,2),
      'clubs_short', jsonb_array_length(v_r2_short),
      'short_by', round(v_r2_short_amt,2), 'detail', v_r2_short),
    'round3', jsonb_build_object(
      'payees', v_r3_payees, 'amount', round(v_r3_total,2),
      'agents_short', jsonb_array_length(v_r3_short),
      'short_by', round(v_r3_short_amt,2), 'detail', v_r3_short),
    'total_to_move', round(v_r2_total + v_r3_total, 2),
    'has_blockers', (jsonb_array_length(v_r2_short) + jsonb_array_length(v_r3_short)) > 0
  );
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)
  TO authenticated, service_role;

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
