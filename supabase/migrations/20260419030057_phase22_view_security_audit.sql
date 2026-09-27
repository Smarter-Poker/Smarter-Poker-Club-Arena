-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419030057 "phase22_view_security_audit"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b3751f29d1eed183dcfe90b0aa135a30 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — View security audit (read-only catalog)
--  -----------------------------------------------------------------------
--  Views and materialized views that anon can SELECT but which don't
--  have security_invoker=true. These run with view-owner (postgres)
--  permissions, bypassing RLS on underlying tables.
--
--  NO VIEWS ARE MODIFIED by this migration.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.phase22_view_security_audit (
    id              serial PRIMARY KEY,
    audit_date      timestamptz NOT NULL DEFAULT NOW(),
    view_name       text NOT NULL,
    view_kind       text NOT NULL,  -- 'view' | 'materialized_view'
    security_invoker boolean NOT NULL,
    underlying_tables text[],
    bypasses_rls    boolean NOT NULL,
    row_count       bigint,
    risk_level      text NOT NULL,
    notes           text,
    recommendation  text,
    resolved_at     timestamptz,
    UNIQUE (audit_date, view_name)
);

ALTER TABLE public.phase22_view_security_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY phase22_view_audit_nobody ON public.phase22_view_security_audit FOR ALL USING (false);
REVOKE ALL ON public.phase22_view_security_audit FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE ON public.phase22_view_security_audit TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE public.phase22_view_security_audit_id_seq TO service_role;

INSERT INTO public.phase22_view_security_audit
  (view_name, view_kind, security_invoker, underlying_tables, bypasses_rls, row_count, risk_level, notes, recommendation)
VALUES
  ('mv_hand_histories', 'materialized_view', false, 
   ARRAY['hand_histories'], true, 4,
   'HIGH_LATENT',
   'Materialized view exposes hand_data JSONB which contains players[].holeCards. Underlying hand_histories has 5 RLS policies which this MV bypasses. Only 4 rows currently (sandbox/training data with player id="human1"). If this MV grows with real multiplayer data, hole card leak becomes active exploit.',
   'DEFER: Add `WITH (security_invoker=true)` to the MV. Or: drop the MV if unused. Or: project only non-sensitive columns. Dan should verify this MV is not populated by any live Club Arena game path first.'),

  ('unified_events_calendar', 'view', false,
   ARRAY['poker_series','poker_venues','tour_stop_events','venue_daily_tournaments'], true, NULL,
   'LOW',
   'Reads public discovery tables (venue names, tournament schedules). These underlying tables appear to be intentionally public (scraped data displayed on PNM pages). No sensitive rows to leak.',
   'ACCEPTABLE: No action needed. All underlying data is meant for public display.'),

  ('geography_columns', 'view', false, ARRAY[]::text[], false, NULL,
   'FALSE_POSITIVE',
   'PostGIS system view (supabase_admin owned). Reference data for geography columns. Safe by design.',
   'No action.'),

  ('geometry_columns', 'view', false, ARRAY[]::text[], false, NULL,
   'FALSE_POSITIVE',
   'PostGIS system view (supabase_admin owned). Reference data for geometry columns. Safe by design.',
   'No action.');
