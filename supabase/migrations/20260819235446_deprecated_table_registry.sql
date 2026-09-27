-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235446 "deprecated_table_registry"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 68132cf5e2dcb5312b068c58849e967e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- DEPRECATED TABLE REGISTRY (2026-08-19)
--
-- Five separate features were found reading tables that receive no writes —
-- club financials, the revenue chart, table admin stats, every player's
-- profile stats, and friend suggestions. All of them returned an empty array
-- and rendered it as a legitimate zero, for months.
--
-- The codebase ALREADY carried comments saying these tables were empty. That
-- did not stop it happening five times, because a comment in one file is
-- invisible to someone writing a query in another. So the fact is recorded
-- where a query author actually looks — on the table itself — and in a
-- machine-readable registry that CI and the weekly governance check can read.
--
-- Renaming them was considered and rejected: `hand_players` and
-- `rake_attributions` still have writers, and breaking a live write path to
-- make a point about a read path is a bad trade.
-- ============================================================================

CREATE TABLE IF NOT EXISTS deprecated_tables (
  table_name text PRIMARY KEY,
  reason text NOT NULL,
  replacement text,
  last_write_at timestamptz,
  deprecated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deprecated_tables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deprecated_tables_read ON deprecated_tables;
CREATE POLICY deprecated_tables_read ON deprecated_tables FOR SELECT USING (true);
DROP POLICY IF EXISTS deprecated_tables_service ON deprecated_tables;
CREATE POLICY deprecated_tables_service ON deprecated_tables
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO deprecated_tables (table_name, reason, replacement, last_write_at) VALUES
  ('rake_history',
   'Write-only legacy rake ledger; writes stopped 2026-05-01. Five features read it and silently showed zeros.',
   'rake_records', '2026-05-01 18:11:06+00'),
  ('hand_players',
   'Client-side hand persistence from before the server-authoritative migration. Zero rows; the engine writes hand_history instead.',
   'hand_history (or ca_player_stats_full for per-player aggregates)', NULL),
  ('rake_attributions',
   'Per-player rake attribution that never received writes. Attribution is derived from rake_records.player_contributions.',
   'rake_records.player_contributions', NULL)
ON CONFLICT (table_name) DO UPDATE
  SET reason = EXCLUDED.reason,
      replacement = EXCLUDED.replacement,
      last_write_at = EXCLUDED.last_write_at;

-- Put it where a query author actually looks.
COMMENT ON TABLE rake_history IS
  'DEPRECATED 2026-08-19 — no writes since 2026-05-01. Use rake_records. Reading this returns an empty set, not zero activity.';
COMMENT ON TABLE hand_players IS
  'DEPRECATED 2026-08-19 — zero rows; superseded by the server-authoritative engine. Use hand_history, or ca_player_stats_full for per-player aggregates.';
COMMENT ON TABLE rake_attributions IS
  'DEPRECATED 2026-08-19 — never populated. Rake is attributed from rake_records.player_contributions.';

-- Surface newly-dead tables automatically: anything registered that has taken
-- a write since being deprecated means the registry is wrong and should be
-- corrected rather than quietly ignored.
CREATE OR REPLACE FUNCTION fn_deprecated_table_usage()
RETURNS TABLE (table_name text, live_rows bigint, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_count bigint;
BEGIN
  FOR r IN SELECT d.table_name, d.replacement FROM deprecated_tables d LOOP
    EXECUTE format('SELECT count(*) FROM %I', r.table_name) INTO v_count;
    IF v_count > 0 THEN
      table_name := r.table_name; live_rows := v_count;
      note := 'Deprecated table still holds rows; replacement is ' || COALESCE(r.replacement, 'unknown');
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION fn_deprecated_table_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_deprecated_table_usage() TO service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM deprecated_tables) < 3 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: deprecated table registry not populated';
  END IF;
END $$;
