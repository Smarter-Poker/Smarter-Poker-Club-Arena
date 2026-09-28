-- The column contracts the coordinator reads (production, 2026-09-28) and
-- declared seams for everything below a scope: preparation, the cascade and
-- the P&L gate are fixture stubs whose behaviour each union's fixture_mode
-- row selects ('ok', 'slow', 'raise', 'cancel'). No real book is certified.
DO $r$ BEGIN
 IF to_regrole('anon') IS NULL THEN CREATE ROLE anon; END IF;
 IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated; END IF;
 IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role; END IF;
END $r$;
CREATE SCHEMA extensions;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions'
AS $function$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles'))
           AT TIME ZONE 'America/Los_Angeles';
$function$;
CREATE FUNCTION public.fn_union_prev_week_start(p_at timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE
 AS $$ SELECT public.fn_union_week_start(public.fn_union_week_start(p_at)-interval '1 day') $$;
CREATE FUNCTION public.fn_union_accounting_run_at(p_end timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT p_end $$;
CREATE FUNCTION public.fn_club_settlement_floor_week(p_club uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT NULL::timestamptz $$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE TABLE public.unions(id uuid PRIMARY KEY);
CREATE TABLE public.clubs(id uuid PRIMARY KEY, is_union boolean);
CREATE TABLE public.union_clubs(club_id uuid);
CREATE TABLE public.union_settlement_floor(union_id uuid PRIMARY KEY, earliest_period_start timestamptz);
CREATE TABLE public.accounting_payable_earning_sources(club_id uuid, coordinator_union_id uuid, union_id uuid, earned_at timestamptz);
CREATE TABLE public.rakeback_periods(club_id uuid, status text, period_start date, period_end date, rakeback_amount numeric);
CREATE TABLE public.agents(club_id uuid, is_prepaid boolean, credit_used numeric);
CREATE TABLE public.union_accounting_runs(union_id uuid, period_start timestamp with time zone NOT NULL, period_end timestamp with time zone NOT NULL,
 scheduled_at timestamp with time zone NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 0, started_at timestamp with time zone,
 finished_at timestamp with time zone, result jsonb NOT NULL DEFAULT '{}'::jsonb, standalone_club_id uuid,
 scope_kind text NOT NULL GENERATED ALWAYS AS (CASE WHEN union_id IS NOT NULL THEN 'union'::text ELSE 'club'::text END) STORED,
 scope_id uuid NOT NULL GENERATED ALWAYS AS (COALESCE(union_id, standalone_club_id)) STORED,
 last_scheduler_visit_at timestamp with time zone);
CREATE UNIQUE INDEX union_accounting_runs_pkey ON public.union_accounting_runs USING btree (scope_kind, scope_id, period_start, period_end);
CREATE UNIQUE INDEX union_accounting_runs_union_id_period_start_period_end_key ON public.union_accounting_runs USING btree (union_id, period_start, period_end);
CREATE TABLE public.financial_alerts(id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, severity text NOT NULL, source text NOT NULL, message text NOT NULL,
 context jsonb DEFAULT '{}'::jsonb, resolved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.union_settlement_rounds(union_id uuid, period_start timestamptz, period_end timestamptz, round_no int, detail jsonb);
CREATE TABLE public.settlement_periods(id uuid PRIMARY KEY, club_id uuid, union_id uuid, start_at timestamptz, end_at timestamptz, status text);
CREATE TABLE public.settlement_invoices(club_id uuid, invoice_type text, breakdown jsonb, message_sent boolean, status text, period_id uuid);
CREATE TABLE public.ca_settlements(settlement_type text, union_id uuid, state text, totals jsonb, external_ref text);
CREATE TABLE public.accounting_routed_settlement_runs(scope_kind text, scope_id uuid, period_start timestamptz, period_end timestamptz, round_no int, result jsonb);
CREATE TABLE public.rake_records(id uuid, is_tournament boolean, tournament_id uuid, rake_amount numeric, created_at timestamptz, club_id uuid);
CREATE TABLE public.daemon_state(daemon text, high_water_mark timestamptz, high_water_mark_id uuid);
CREATE FUNCTION public.fn_accounting_failure_identity(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT md5(COALESCE(p->>'error','')) $$;
CREATE FUNCTION public.fn_union_pnl_close_quality(p_union uuid, p_from timestamptz, p_to timestamptz) RETURNS jsonb LANGUAGE sql STABLE
 AS $$ SELECT '{"status":"ready","issues":[]}'::jsonb $$;
CREATE FUNCTION public.fn_assert_cash_commission_period(p_union uuid, p_club uuid, p_from timestamptz, p_to timestamptz) RETURNS void LANGUAGE sql AS $$ SELECT $$;

-- The seams each union's behaviour selects.
CREATE TABLE public.fixture_mode(union_id uuid PRIMARY KEY, mode text NOT NULL);
CREATE TABLE public.fixture_calls(what text, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION public.fn_union_pnl_closed_book_barrier(p_end timestamptz) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION public.fn_prepare_accounting_week(p_union uuid, p_club uuid, p_from timestamptz, p_to timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m text := (SELECT mode FROM public.fixture_mode WHERE union_id=p_union);
BEGIN
 IF m='slow' THEN PERFORM pg_sleep(30); END IF;
 IF m='cancel' THEN RAISE EXCEPTION USING ERRCODE='query_canceled', MESSAGE='canceling statement due to user request'; END IF;
 RETURN jsonb_build_object('success',true);
END $$;
CREATE FUNCTION public.fn_union_settlement_cascade(p_union uuid, p_from timestamptz, p_to timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.fixture_calls(what) VALUES('cascade '||p_union);
 RETURN jsonb_build_object('success',true,'posted',p_union);
END $$;
CREATE FUNCTION public.fn_accounting_week_clubs(p_union uuid, p_club uuid, p_from timestamptz, p_to timestamptz) RETURNS TABLE(club_id uuid)
 LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$;
-- 'raise': an error the scope does not catch itself. The run-row write sits
-- outside the scope's own handlers, as a closed-book barrier refusal does.
CREATE FUNCTION public.fixture_refuse_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.fixture_mode f WHERE f.union_id=NEW.union_id AND f.mode='raise') THEN
  RAISE EXCEPTION 'fixture_run_row_refused';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fixture_refuse_run BEFORE INSERT ON public.union_accounting_runs FOR EACH ROW EXECUTE FUNCTION public.fixture_refuse_run();
