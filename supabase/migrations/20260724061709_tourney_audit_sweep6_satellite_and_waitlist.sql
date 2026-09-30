-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260724061709 as "tourney_audit_sweep6_satellite_and_waitlist"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- TOURNEY-AUDIT SWEEP 6 (2026-07-24): satellite targets + cash-game waitlist.
--
-- 1. tournaments.satellite_target_id — satellites now award SEATS in a target
--    tournament at finish (engine: processSatelliteAwards). Previously the
--    satelliteTarget config was accepted and silently dropped.
-- 2. table_waitlists — cash-game waitlist (Dan's rule: waitlists are for cash
--    games; MTT late registrants are auto-seated by the engine, never queued).
--    Engine notifies the next player when a seat opens.

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS satellite_target_id uuid REFERENCES tournaments(id);

CREATE TABLE IF NOT EXISTS table_waitlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','seated','cancelled','expired')),
  UNIQUE (table_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_table_waitlists_table_status
  ON table_waitlists (table_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_table_waitlists_user
  ON table_waitlists (user_id) WHERE status IN ('waiting','notified');

ALTER TABLE table_waitlists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS table_waitlists_select ON table_waitlists;
CREATE POLICY table_waitlists_select ON table_waitlists
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS table_waitlists_insert_own ON table_waitlists;
CREATE POLICY table_waitlists_insert_own ON table_waitlists
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS table_waitlists_update_own ON table_waitlists;
CREATE POLICY table_waitlists_update_own ON table_waitlists
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
