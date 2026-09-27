-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419025928 "phase22_rls_table_audit"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e01d939127f297058b860cf3c3643e51 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Table-level RLS audit (read-only catalog)
--  -----------------------------------------------------------------------
--  Documents tables where anon/authenticated has CRUD grants but RLS is
--  either disabled or has 0 policies. Some of these are false positives
--  (RLS-enabled + 0-policies actually denies everything), others are real
--  exposure.
--
--  NO PRODUCTION TABLES ARE MODIFIED. This only creates and populates a
--  tracking table so Dan can triage on his own schedule.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.phase22_rls_table_audit (
    id               serial PRIMARY KEY,
    audit_date       timestamptz NOT NULL DEFAULT NOW(),
    table_name       text        NOT NULL,
    row_count        bigint,
    rls_enabled      boolean     NOT NULL,
    policy_count     int         NOT NULL,
    anon_crud_grants boolean     NOT NULL,
    auth_crud_grants boolean     NOT NULL,
    effective_anon_access text,  -- 'BLOCKED_BY_RLS' | 'OPEN' | 'PARTIAL'
    risk_level       text        NOT NULL,  -- CRITICAL | HIGH | MEDIUM | FALSE_POSITIVE
    notes            text,
    recommendation   text,
    resolved_at      timestamptz,
    resolution       text,
    UNIQUE (audit_date, table_name)
);

ALTER TABLE public.phase22_rls_table_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY phase22_rls_audit_nobody ON public.phase22_rls_table_audit FOR ALL USING (false);
REVOKE ALL ON public.phase22_rls_table_audit FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE ON public.phase22_rls_table_audit TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE public.phase22_rls_table_audit_id_seq TO service_role;

-- Populate with the 8 findings
INSERT INTO public.phase22_rls_table_audit 
  (table_name, row_count, rls_enabled, policy_count, anon_crud_grants, auth_crud_grants, effective_anon_access, risk_level, notes, recommendation)
VALUES
  ('deploy_alerts', 0, true, 0, true, true, 'BLOCKED_BY_RLS',
   'FALSE_POSITIVE',
   'RLS enabled with 0 policies = default deny. Anon has CRUD grants but cannot actually access anything. Grants are hygienically loose but functionally safe.',
   'Low priority. Consider REVOKE for cleanliness but no real risk.'),

  ('game_live_history', 979692, false, 0, true, true, 'OPEN',
   'CRITICAL',
   'Live poker game data for Poker Near Me (venue_name, game_type, stakes, waiting counts). 979K rows. Anon has INSERT/UPDATE/DELETE — could pollute live-game display or wipe history.',
   'HIGH_RISK_TO_CHANGE: Multiple Next.js API routes likely read this via anon key for PNM pages. Enabling RLS requires identifying all read paths and adding a SELECT-only policy. Also need service_role INSERT path for scrapers. Recommend Dan review.'),

  ('hand_state_snapshots', 35177, false, 0, true, true, 'OPEN',
   'CRITICAL',
   'Poker hand state (state_json, players_json, dealer_seat, stage). 35K rows. GAME INTEGRITY risk — anon could modify in-progress game state. Hole cards are separately stored so immediate cheating risk is limited, but state manipulation could still force game outcomes.',
   'HIGH_RISK_TO_CHANGE: Club Arena game UI subscribes to this table. Enabling RLS needs table-owner-or-seated-player SELECT policy + service_role INSERT/UPDATE. Test in staging first.'),

  ('scrape_evidence', 0, false, 0, true, true, 'OPEN',
   'MEDIUM',
   'Scraper evidence log (URLs, HTTP status, screenshot paths). Empty. Anon exposure is low value but still shouldnt be.',
   'LOW_RISK_TO_CHANGE: No rows, no UI reads it. Could REVOKE anon/authenticated safely, but need to verify scraper writes via service_role.'),

  ('scrape_source_registry', 21, false, 0, true, true, 'OPEN',
   'MEDIUM',
   'Scraper config for 21 sources (source URLs, schedules, last-check status).',
   'LOW_RISK_TO_CHANGE: Config table, probably only written by scrapers via service_role. Same recommendation as scrape_evidence.'),

  ('tour_scrape_registry', 13, false, 0, true, true, 'OPEN',
   'MEDIUM',
   'Tour scraper config for 13 tours (WSOP, WPT, etc). URLs and schedules.',
   'LOW_RISK_TO_CHANGE: Likely public discovery info (tour names/URLs), but no reason anon should write. Same recommendation.'),

  ('user_notification_preferences', 0, false, 0, true, true, 'OPEN',
   'HIGH',
   'User PII — notification toggle prefs per user. Currently empty (no users have customized). When populated, anon CRUD would let anyone read/modify anyones preferences.',
   'HIGH_RISK_TO_CHANGE: Settings UI reads this via anon key after auth. Enabling RLS needs auth.uid() = user_id policy. Urgent-but-defer: no users yet, so adding RLS is safe before adoption grows.');

-- Explicitly call out that we are NOT changing production tables
COMMENT ON TABLE public.phase22_rls_table_audit IS
  'Phase 22 — triage list of public tables with loose RLS/grants. Read-only audit; no production tables were modified by the migration that populated this.';
