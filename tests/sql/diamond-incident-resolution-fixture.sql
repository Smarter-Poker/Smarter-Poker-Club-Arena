-- Isolated fixture for tests/sql/run-diamond-incident-resolution.py. Never
-- connects to production. The two watch functions and fn_ca_diamond_incident
-- are the EXACT production definitions captured read-only on 2026-09-19
-- (pg_get_functiondef; md5 15a6122b49ba60123b73380da4b30e33,
-- b98e983f098449c22b26478657923b46 and 184127186e82dcfecd7d0dac92310fab), so
-- the migration's md5 pins pass here exactly as they must in production, and
-- a fixture that drifts fails the load instead of certifying something the
-- estate does not run. fn_ca_diamond_health() and fn_ca_diamond_trial_balance()
-- are stubs that read fixture tables, because what is under test is what the
-- watches DO with a reading, not the reading itself.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'poker_diamond_incident_resolution_test' OR inet_server_addr() IS NOT NULL
 OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated incident resolution fixture only'; END IF;
END $$;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA IF NOT EXISTS auth;
-- The hourly job runs the watch as the database owner (postgres), which the watch admits by
-- name; this cluster's owner has another name, so the fixture answers as the service role.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;

-- ca_diamond_incidents as production has it (information_schema read 2026-09-19).
CREATE TABLE public.ca_diamond_incidents(
 id bigserial PRIMARY KEY,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 rule text NOT NULL,
 severity text NOT NULL DEFAULT 'info',
 user_id uuid,
 amount numeric,
 writer text,
 db_role text NOT NULL DEFAULT current_user,
 app_name text NOT NULL DEFAULT COALESCE(current_setting('application_name',true),''),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 resolved_at timestamptz);
CREATE INDEX ca_diamond_incidents_open_idx ON public.ca_diamond_incidents (occurred_at DESC) WHERE resolved_at IS NULL;
CREATE FUNCTION public.fn_ca_is_fixture_account(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;

-- The readings the watches consume, set by the runner.
CREATE TABLE public.fixture_health(ord integer, area text, status text, detail text);
CREATE TABLE public.fixture_trial_balance(ord integer, account text, balance_now numeric, balance_delta numeric,
 journal_net numeric, mint_net numeric, difference numeric, note text);
CREATE FUNCTION public.fn_ca_diamond_health() RETURNS TABLE(area text, status text, detail text)
 LANGUAGE sql STABLE AS $$ SELECT area,status,detail FROM public.fixture_health ORDER BY ord $$;
CREATE FUNCTION public.fn_ca_diamond_trial_balance(p_since timestamptz)
 RETURNS TABLE(account text, balance_now numeric, balance_delta numeric, journal_net numeric, mint_net numeric, difference numeric, note text)
 LANGUAGE sql STABLE AS $$ SELECT account,balance_now,balance_delta,journal_net,mint_net,difference,note FROM public.fixture_trial_balance ORDER BY ord $$;

-- No guard watchlist in this fixture: the migration's declaration step must skip cleanly.
CREATE FUNCTION public.fixture_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;

-- ---- exact production definitions follow ----
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_incident(p_rule text, p_severity text, p_user_id uuid, p_amount numeric, p_writer text, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_sev text := COALESCE(p_severity, 'info');
BEGIN
  -- Fixture accounts are not players (docs/DIAMOND-RULINGS.md): a rule filed against one is info
  -- unless it is critical. Horses are players and are never fixtures.
  IF v_sev <> 'critical' AND p_user_id IS NOT NULL AND public.fn_ca_is_fixture_account(p_user_id) THEN
    v_sev := 'info';
  END IF;
  INSERT INTO public.ca_diamond_incidents (rule, severity, user_id, amount, writer, detail)
  VALUES (p_rule, v_sev, p_user_id, p_amount, p_writer,
          COALESCE(p_detail, '{}'::jsonb) || CASE WHEN v_sev <> COALESCE(p_severity, 'info')
                                                  THEN jsonb_build_object('severity_requested', p_severity, 'fixture_account', true)
                                                  ELSE '{}'::jsonb END);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_incident could not record % (%): %', p_rule, p_writer, SQLERRM;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_bad integer; v_detail jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_diamond_health_watch: service_role required';
  END IF;

  -- `unknown` counts as bad. An area that could not be read is not an area that is fine, and the
  -- whole point of giving health an `unknown` status was that somebody would act on it.
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('area', h.area, 'status', h.status, 'detail', h.detail)), '[]'::jsonb)
    INTO v_bad, v_detail
    FROM public.fn_ca_diamond_health() h
   WHERE h.status IN ('critical', 'unknown');

  IF v_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident(
      'DR0:health_critical', 'critical', NULL, NULL, 'fn_ca_diamond_health_watch',
      jsonb_build_object('areas', v_bad, 'detail', v_detail));
  END IF;

  RETURN v_bad;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_since timestamptz := now() - interval '1 hour';
  v_filed integer := 0; v_rows integer := 0; v_broken text := '';
BEGIN
  FOR r IN SELECT * FROM public.fn_ca_diamond_trial_balance(v_since) LOOP
    v_rows := v_rows + 1;
    IF r.account IN ('player_diamonds', 'diamond_house', 'register') AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      -- Ruling 13 (docs/DIAMOND-RULINGS.md): a break over 1,000 diamonds in one hour is critical and
      -- pages; opening the diamond_issuance freeze stays a human act.
      PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_break',
        CASE WHEN abs(r.difference) > 1000 THEN 'critical' ELSE 'warning' END, NULL, r.difference, r.account,
        jsonb_build_object('account', r.account, 'balance_now', r.balance_now, 'balance_delta', r.balance_delta,
                           'journal_net', r.journal_net, 'mint_net', r.mint_net, 'difference', r.difference,
                           'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1; v_broken := v_broken || r.account || ' ';
    END IF;
    IF r.account = 'fixture_accounts' AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR6:fixture_harness_unregistered_movement', 'info', NULL, r.difference,
        'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('balance_delta', r.balance_delta, 'mint_net', r.mint_net, 'window_start', v_since, 'note', r.note));
    END IF;
    IF r.account = 'suspense' AND COALESCE(r.balance_now, 0) <> 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR12:suspense_nonzero', 'info', NULL, r.balance_now, 'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('suspense', r.balance_now, 'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed, 'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'window_start', v_since, 'window_end', now()));

  UPDATE public.ca_diamond_incidents SET resolved_at = now()
   WHERE resolved_at IS NULL AND severity = 'info' AND occurred_at < now() - interval '7 days';
  DELETE FROM public.ca_diamond_incidents
   WHERE severity = 'info' AND resolved_at IS NOT NULL AND occurred_at < now() - interval '30 days';
  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_health_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health_watch() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance_watch() TO service_role;
SELECT public.fixture_assert(md5(pg_get_functiondef('public.fn_ca_diamond_health_watch()'::regprocedure))='15a6122b49ba60123b73380da4b30e33','fixture health watch is the production text');
SELECT public.fixture_assert(md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance_watch()'::regprocedure))='b98e983f098449c22b26478657923b46','fixture trial balance watch is the production text');
SELECT public.fixture_assert(md5(pg_get_functiondef('public.fn_ca_diamond_incident(text,text,uuid,numeric,text,jsonb)'::regprocedure))='184127186e82dcfecd7d0dac92310fab','fixture incident writer is the production text');
