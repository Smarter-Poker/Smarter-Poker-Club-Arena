\set ON_ERROR_STOP on
-- Bring the captured weekly run journal up to the shape production actually has.
--
-- WHY THIS FILE EXISTS.
-- tests/fixtures/full-weekly-accounting/schema.sql is a 2026-09-14 catalog
-- capture, and on that date public.union_accounting_runs was still union-only:
-- PRIMARY KEY(union_id,period_start,period_end), union_id NOT NULL, and no
-- standalone_club_id, scope_kind, scope_id or last_scheduler_visit_at. Every
-- term of the coordinator's standalone-club discovery reads those columns, so
-- on the captured base the club branch cannot execute at all - it fails 42703
-- before any floor predicate is reached. That, and not the migration's preimage
-- guard, is what kept the club branch untested: this cluster carries the exact
-- installed coordinator and 20260920232503 applies here with its production
-- preimage guard live and unmodified.
--
-- WHAT IT APPLIES. The reviewed source of the installed shape, verbatim:
--   * supabase/accounting/weekly-v3/components/
--       20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql
--       20260914154500_weekly_scheduler_visits_every_accounting_scope_fairly.sql
--   * supabase/migrations/20260917195207_accounting_club_foreign_keys_stay_indexed.sql
-- and nothing else. No coordinator, floor, payer or document body is touched.
--
-- The readback below is bound to the shape read out of production read-only on
-- 2026-09-21. If the installed journal ever moves, this fixture refuses instead
-- of proving discovery against a shape production does not have.
DO $$BEGIN IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
 RAISE EXCEPTION 'private native fixture only';END IF;END$$;

ALTER TABLE public.union_accounting_runs DROP CONSTRAINT union_accounting_runs_pkey;
ALTER TABLE public.union_accounting_runs ALTER COLUMN union_id DROP NOT NULL;
ALTER TABLE public.union_accounting_runs ADD COLUMN standalone_club_id uuid REFERENCES public.clubs(id),
 ADD COLUMN scope_kind text GENERATED ALWAYS AS(CASE WHEN union_id IS NOT NULL THEN 'union' ELSE 'club' END) STORED,
 ADD COLUMN scope_id uuid GENERATED ALWAYS AS(COALESCE(union_id,standalone_club_id)) STORED,
 ADD CONSTRAINT accounting_run_has_one_scope CHECK((union_id IS NULL)<>(standalone_club_id IS NULL)),
 ADD PRIMARY KEY(scope_kind,scope_id,period_start,period_end),
 ADD UNIQUE(union_id,period_start,period_end);
ALTER TABLE public.union_accounting_runs ADD COLUMN last_scheduler_visit_at timestamptz
 CHECK(last_scheduler_visit_at IS NULL OR isfinite(last_scheduler_visit_at));
CREATE INDEX IF NOT EXISTS idx_union_accounting_runs_standalone_club_id_fk
 ON public.union_accounting_runs(standalone_club_id);

-- Exact readback against the installed production shape.
DO $readback$
DECLARE expected text; actual text;
BEGIN
 expected:=$e$union_id uuid|period_start timestamp with time zone NOT NULL|period_end timestamp with time zone NOT NULL|scheduled_at timestamp with time zone NOT NULL|status text NOT NULL|attempts integer NOT NULL|started_at timestamp with time zone|finished_at timestamp with time zone|result jsonb NOT NULL|standalone_club_id uuid|scope_kind text NOT NULL|scope_id uuid NOT NULL|last_scheduler_visit_at timestamp with time zone$e$;
 SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,'|' ORDER BY a.attnum)
  INTO actual FROM pg_attribute a
  WHERE a.attrelid='public.union_accounting_runs'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'installed run journal columns moved: %',actual; END IF;

 expected:=$e$accounting_run_has_one_scope CHECK (((union_id IS NULL) <> (standalone_club_id IS NULL)))|union_accounting_runs_attempts_check CHECK ((attempts >= 0))|union_accounting_runs_check CHECK ((isfinite(period_start) AND isfinite(period_end) AND (period_start < period_end)))|union_accounting_runs_last_scheduler_visit_at_check CHECK (((last_scheduler_visit_at IS NULL) OR isfinite(last_scheduler_visit_at)))|union_accounting_runs_pkey PRIMARY KEY (scope_kind, scope_id, period_start, period_end)|union_accounting_runs_standalone_club_id_fkey FOREIGN KEY (standalone_club_id) REFERENCES clubs(id)|union_accounting_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'complete'::text, 'failed'::text])))|union_accounting_runs_union_id_period_start_period_end_key UNIQUE (union_id, period_start, period_end)$e$;
 SELECT string_agg(c.conname||' '||pg_get_constraintdef(c.oid),'|' ORDER BY c.conname)
  INTO actual FROM pg_constraint c WHERE c.conrelid='public.union_accounting_runs'::regclass;
 IF actual IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'installed run journal constraints moved: %',actual; END IF;

 SELECT string_agg(i.indexdef,'|' ORDER BY i.indexname) INTO actual
  FROM pg_indexes i WHERE i.schemaname='public' AND i.tablename='union_accounting_runs';
 IF actual IS DISTINCT FROM
  'CREATE INDEX idx_union_accounting_runs_standalone_club_id_fk ON public.union_accounting_runs USING btree (standalone_club_id)|CREATE UNIQUE INDEX union_accounting_runs_pkey ON public.union_accounting_runs USING btree (scope_kind, scope_id, period_start, period_end)|CREATE UNIQUE INDEX union_accounting_runs_union_id_period_start_period_end_key ON public.union_accounting_runs USING btree (union_id, period_start, period_end)'
 THEN RAISE EXCEPTION 'installed run journal indexes moved: %',actual; END IF;

 -- The migration under test is already installed on this cluster, and this file
 -- must not have disturbed it.
 IF (SELECT (length(d)-length(replace(d,'fn_club_settlement_floor_week','')))/length('fn_club_settlement_floor_week')
     FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q)<>3
 THEN RAISE EXCEPTION 'club floor is not bound into discovery'; END IF;
 RAISE NOTICE 'PASS: the captured run journal now has the exact installed union/standalone shape';
END $readback$;
