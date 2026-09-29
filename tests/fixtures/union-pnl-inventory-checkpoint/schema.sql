-- Column contracts of the original inventory (20260917233148) and the live
-- definitions this change depends on, captured from production 2026-09-28.
DO $r$ BEGIN
 IF to_regrole('anon') IS NULL THEN CREATE ROLE anon; END IF;
 IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated; END IF;
 IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role; END IF;
END $r$;
CREATE SCHEMA extensions;
-- fn_caller_is_engine: the fixture flips the caller with a setting.
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS
 $$ SELECT COALESCE(current_setting('fixture.caller',true),'') IN ('','service_role') $$;
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles'))
           AT TIME ZONE 'America/Los_Angeles';
$function$;
CREATE TABLE public.union_pnl_inventory_capture (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 captured_at timestamptz NOT NULL CHECK(isfinite(captured_at)),
 contract_version integer NOT NULL CHECK(contract_version=1),
 source_counts jsonb NOT NULL CHECK(jsonb_typeof(source_counts)='object')
);
CREATE TABLE public.union_pnl_inventory_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_name text NOT NULL CHECK(source_name IN ('union_clubs','tables','table_seats','tournaments','tournament_players')),
 row_id uuid NOT NULL,
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 transaction_id xid8 NOT NULL,
 operation text NOT NULL CHECK(operation IN ('baseline','INSERT','UPDATE','DELETE')),
 before_row jsonb,
 after_row jsonb,
 CHECK(before_row IS NOT NULL OR after_row IS NOT NULL),
 CHECK((before_row IS NULL OR (jsonb_typeof(before_row)='object' AND before_row->>'id'=row_id::text)) IS TRUE),
 CHECK((after_row IS NULL OR (jsonb_typeof(after_row)='object' AND after_row->>'id'=row_id::text)) IS TRUE),
 CHECK((operation IN ('baseline','INSERT') AND before_row IS NULL AND after_row IS NOT NULL)
  OR (operation='UPDATE' AND before_row IS NOT NULL AND after_row IS NOT NULL)
  OR (operation='DELETE' AND before_row IS NOT NULL AND after_row IS NULL))
);
CREATE INDEX union_pnl_inventory_identity ON public.union_pnl_inventory_events(source_name,row_id,event_id DESC);
CREATE INDEX union_pnl_inventory_boundary ON public.union_pnl_inventory_events(observed_at,event_id);
REVOKE ALL ON public.union_pnl_inventory_capture,public.union_pnl_inventory_events FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_union_pnl_inventory_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER original_pnl_inventory_capture_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_capture
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_events
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
