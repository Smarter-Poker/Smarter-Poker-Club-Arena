\set ON_ERROR_STOP on
-- UNRUN. Fresh load.sql database only; separate from due-regression.sql.
CREATE TABLE public.test_scheduler_timing_control(singleton boolean PRIMARY KEY CHECK(singleton),clock_at timestamptz NOT NULL,frozen boolean NOT NULL);
INSERT INTO public.test_scheduler_timing_control VALUES(true,'2026-09-14 09:20Z',false);
-- These are explicitly controlled clock/freeze dependencies in the disposable
-- unit fixture. No scheduler/advisory-lock/payment body is replaced.
CREATE OR REPLACE FUNCTION public.test_clock() RETURNS timestamptz LANGUAGE sql VOLATILE
 AS $$SELECT clock_at FROM public.test_scheduler_timing_control WHERE singleton$$;
CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql VOLATILE
 AS $$SELECT frozen FROM public.test_scheduler_timing_control WHERE singleton$$;
INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
 SELECT u(n),'2026-09-07 07:00Z','2026-09-14 07:00Z','2026-09-14 09:00Z','failed',1,'{"success":false,"original":true}'::jsonb
 FROM generate_series(12,14)n;
