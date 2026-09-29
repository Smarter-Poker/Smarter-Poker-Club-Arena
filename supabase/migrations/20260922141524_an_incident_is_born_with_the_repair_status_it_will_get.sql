-- 20260922141524_an_incident_is_born_with_the_repair_status_it_will_get
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 14:15:24 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Every row in ca_drift_incidents is born with auto_repair_status = 'pending'.
-- That is the column default, and neither writer names the column
-- (fn_ca_raise_drift_incident, fn_capture_managed_game_contract), so every
-- incident is filed claiming that an automatic repair is queued for it.
--
-- For every classification except incorrect_rake and bbj_error no such repair
-- exists and none ever did. The only code that acts on 'pending' is
-- fn_ca_auto_reconcile_tick (pg_cron ca-auto-reconcile-tick, every minute),
-- and for those rows its whole job was to wait ten minutes and then rewrite
-- the claim to 'manual_needed'. Meanwhile the page a person receives at birth
-- (fn_ca_incident_notify) says "Auto-repair: pending." about an incident that
-- nothing will ever repair.
--
-- For the two classifications it does act on, it calls
-- fn_redrive_unbanked_rake(100) and fn_bbj_repair_unbanked(24,200) once a
-- minute for as long as the incident stays open, whatever the incident is
-- actually about.
--
-- MEASURED 2026-09-22, read-only:
--
--   pending -> manual_needed rewrites by the tick   139 in 7 days, 4,952 ever
--   redrive pairs run by the tick                   7,774 in 7 days, 25,343 in 30
--     9,176 of them for ONE incident, financial_alerts:RakeSpec.drift,
--     2026-09-14 14:34 to 2026-09-20 23:30: a rake-spec drift no re-drive
--     could touch, closed by hand in the end
--   money those re-drives moved in 13 days          0
--     pending_fee_distributions kind='rake': newest row 2026-09-08 17:30
--     bbj_contributions written by fn_bbj_repair_unbanked (hand_number
--     NULL): newest dated 2026-09-08 17:17; it back-dates to the hand and
--     looks 24 hours back, so nothing it wrote is newer than 2026-09-09
--     both candidate sets right now: 0 and 0
--   incidents the tick closed as re-verified clean  0 in 14 days
--                                                   (last 2026-09-08 02:55)
--   accepted-hand commits carrying the durable envelope that banks rake,
--   jackpot drop and promo inside one transaction   2,315,925 of 2,315,925
--                                                   in 7 days
--
-- WHAT THIS CHANGES
--
-- An incident is born with the status it will actually have: 'manual_needed'.
-- One column default, applied by both writers because neither names it.
--
-- The consequence is deliberate. fn_ca_auto_reconcile_tick selects only
-- auto_repair_status IN ('pending','running'), so it receives no new work
-- from the moment this lands; rows already 'pending' (at most ten minutes
-- old) are rewritten by the tick exactly as before. Unscheduling the tick is
-- the cron coordinator's decision and is NOT made here. This removes the
-- correctness dependency that kept it scheduled.
--
-- Visible difference: the dashboard badge and the page say manual_needed from
-- the first second instead of after ten minutes, and fn_ca_drift_metrics
-- reports auto_repairing = 0, which is true.
--
-- NOT TOUCHED: the CHECK constraint (historical rows keep their values),
-- the NOT NULL, fn_ca_auto_reconcile_tick's body, and every money function.
--
-- @live-proof: (SELECT position('manual_needed' in pg_get_expr(d.adbin, d.adrelid)) > 0 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.ca_drift_incidents'::regclass AND a.attname = 'auto_repair_status')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- PRE-FLIGHT. The new default must be a value the CHECK admits, or every
-- future incident insert would fail and nothing would ever be filed again.
DO $preflight$
DECLARE
  v_check text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_check
    FROM pg_constraint c
   WHERE c.conrelid = 'public.ca_drift_incidents'::regclass
     AND c.conname = 'ca_drift_incidents_auto_repair_status_check';
  IF v_check IS NULL OR position('''manual_needed''' in v_check) = 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: the auto_repair_status CHECK does not admit manual_needed: %', v_check;
  END IF;
END
$preflight$;

ALTER TABLE public.ca_drift_incidents
  ALTER COLUMN auto_repair_status SET DEFAULT 'manual_needed';

-- VERIFY, both directions.
DO $verify$
DECLARE
  v_def     text;
  v_notnull boolean;
  v_check   text;
  v_writer  text;
BEGIN
  -- 1. The new behaviour: a row that does not name the column is born
  --    manual_needed.
  SELECT pg_get_expr(d.adbin, d.adrelid), a.attnotnull
    INTO v_def, v_notnull
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.ca_drift_incidents'::regclass
     AND a.attname = 'auto_repair_status';
  IF v_def IS DISTINCT FROM '''manual_needed''::text' THEN
    RAISE EXCEPTION 'auto_repair_status default is %, expected manual_needed', v_def;
  END IF;

  -- 2. The old behaviour is gone at its only source: both writers inherit the
  --    default rather than naming the column, so neither can still write
  --    pending.
  FOR v_writer IN
    SELECT unnest(ARRAY['fn_ca_raise_drift_incident', 'fn_capture_managed_game_contract'])
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_writer) <> 1 THEN
      RAISE EXCEPTION 'incident writer % is not present exactly once', v_writer;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = v_writer
                  AND position('auto_repair_status' in p.prosrc) > 0) THEN
      RAISE EXCEPTION 'incident writer % names auto_repair_status, so it does not take the default', v_writer;
    END IF;
  END LOOP;

  -- 3. THE OTHER DIRECTION. Nothing was achieved by loosening the column:
  --    NOT NULL still refuses a missing status, and the CHECK still admits
  --    every value the 6,000-odd historical rows carry.
  IF NOT v_notnull THEN
    RAISE EXCEPTION 'auto_repair_status is no longer NOT NULL';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_check
    FROM pg_constraint c
   WHERE c.conrelid = 'public.ca_drift_incidents'::regclass
     AND c.conname = 'ca_drift_incidents_auto_repair_status_check';
  IF v_check IS NULL
     OR position('''pending''' in v_check) = 0
     OR position('''running''' in v_check) = 0
     OR position('''repaired''' in v_check) = 0
     OR position('''manual_needed''' in v_check) = 0
     OR position('''not_applicable''' in v_check) = 0 THEN
    RAISE EXCEPTION 'auto_repair_status CHECK no longer admits the historical values: %', v_check;
  END IF;
END
$verify$;

COMMIT;
